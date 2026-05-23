/**
 * Background workspace sync manager — runs as a plugin service.
 *
 * Runs rclone bisync at configured intervals WITHOUT involving the agent/LLM.
 * Pure file operation, zero token cost.
 */

import type { WorkspaceSyncConfig } from "./types.js";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  isRcloneInstalled,
  isRcloneConfigured,
  ensureRcloneConfigFromConfig,
  resolveSyncConfig,
  runBisync,
  runSync,
  runCopy,
  runMove,
  runMkdir,
  clearBisyncLocks,
} from "./rclone.js";

type Logger = {
  debug?: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

type SyncManagerState = {
  timeoutId: ReturnType<typeof setTimeout> | null;
  lastSyncAt: Date | null;
  lastSyncOk: boolean | null;
  syncCount: number;
  errorCount: number;
  running: boolean;
  syncing: boolean;
  intervalMs: number;
};

const state: SyncManagerState = {
  timeoutId: null,
  lastSyncAt: null,
  lastSyncOk: null,
  syncCount: 0,
  errorCount: 0,
  running: false,
  syncing: false,
  intervalMs: 0,
};

let currentSyncConfig: WorkspaceSyncConfig | null = null;
let currentWorkspaceDir: string | null = null;
let currentStateDir: string | null = null;
let currentLogger: Logger | null = null;
let currentOnInboxFiles: ((files: string[]) => void) | null = null;

function scheduleNextSync(): void {
  if (!state.running || state.intervalMs <= 0) return;
  state.timeoutId = setTimeout(() => {
    void runSyncLoop();
  }, state.intervalMs);
}

async function runSyncLoop(): Promise<void> {
  await doSync();
  scheduleNextSync();
}

async function doSync(): Promise<void> {
  if (!currentSyncConfig || !currentLogger || !currentWorkspaceDir) return;
  if (state.syncing) {
    currentLogger.info("[workspace-sync] Sync already in progress, skipping this cycle");
    return;
  }

  const syncConfig = currentSyncConfig;
  if (!syncConfig.provider || syncConfig.provider === "off") return;

  if (!syncConfig.mode) {
    currentLogger.error(
      '[workspace-sync] "mode" is required in config. Set "mode": "mailbox" (inbox/outbox, safest), "mode": "mirror" (remote→local), or "mode": "bisync" (bidirectional). Sync will not run until mode is set.',
    );
    return;
  }

  const logger = currentLogger;
  state.syncing = true;

  try {
    const installed = await isRcloneInstalled();
    if (!installed) {
      logger.warn("[workspace-sync] rclone not installed, skipping periodic sync");
      return;
    }

    const resolved = resolveSyncConfig(syncConfig, currentWorkspaceDir, currentStateDir ?? undefined);

    ensureRcloneConfigFromConfig(syncConfig, resolved.configPath, resolved.remoteName);

    if (!isRcloneConfigured(resolved.configPath, resolved.remoteName)) {
      logger.warn(`[workspace-sync] rclone not configured for "${resolved.remoteName}", skipping`);
      return;
    }

    const mode = resolved.mode;

    if (mode === "bisync") {
      logger.info(
        `[workspace-sync] Running periodic bisync: ${resolved.remoteName}:${resolved.remotePath}`,
      );

      const result = await runBisync({
        configPath: resolved.configPath,
        remoteName: resolved.remoteName,
        remotePath: resolved.remotePath,
        localPath: resolved.localPath,
        conflictResolve: resolved.conflictResolve,
        exclude: resolved.exclude,
        copySymlinks: resolved.copySymlinks,
        resync: false,
        timeoutMs: resolved.timeoutMs,
        verbose: !!logger.debug,
      });

      state.lastSyncAt = new Date();
      state.syncCount++;

      if (result.ok) {
        state.lastSyncOk = true;
        logger.info("[workspace-sync] Periodic bisync completed");
      } else {
        state.lastSyncOk = false;
        state.errorCount++;
        logger.warn(`[workspace-sync] Periodic bisync failed: ${result.error}`);
      }
    } else if (mode === "mailbox") {
      // Mailbox mode: workspace pushes to cloud, then drain cloud _outbox → local _inbox
      const outboxRemotePath = resolved.remotePath
        ? `${resolved.remotePath}/_outbox`
        : "_outbox";
      const inboxLocalPath = join(resolved.localPath, "_inbox");

      if (!existsSync(inboxLocalPath)) {
        mkdirSync(inboxLocalPath, { recursive: true });
      }

      // Step 1: push workspace → cloud (excluding _inbox and _outbox)
      const mailboxExcludes = [...resolved.exclude, "_inbox/**", "_outbox/**"];
      logger.info(
        `[workspace-sync] Mailbox: pushing workspace → ${resolved.remoteName}:${resolved.remotePath}`,
      );

      const pushResult = await runSync({
        configPath: resolved.configPath,
        remoteName: resolved.remoteName,
        remotePath: resolved.remotePath,
        localPath: resolved.localPath,
        direction: "push",
        exclude: mailboxExcludes,
        timeoutMs: resolved.timeoutMs,
        verbose: !!logger.debug,
      });

      state.lastSyncAt = new Date();
      state.syncCount++;

      if (pushResult.ok) {
        state.lastSyncOk = true;
        logger.info("[workspace-sync] Mailbox push completed");
      } else {
        state.lastSyncOk = false;
        state.errorCount++;
        logger.warn(`[workspace-sync] Mailbox push failed: ${pushResult.error}`);
      }

      // Step 2: drain cloud _outbox → local _inbox (move = deletes from cloud after transfer)
      logger.info(
        `[workspace-sync] Mailbox: draining ${resolved.remoteName}:${outboxRemotePath} → ${inboxLocalPath}`,
      );

      const inboxBefore = new Set(
        existsSync(inboxLocalPath) ? readdirSync(inboxLocalPath) : [],
      );

      const drainResult = await runMove({
        configPath: resolved.configPath,
        remoteName: resolved.remoteName,
        remotePath: outboxRemotePath,
        localPath: inboxLocalPath,
        direction: "pull",
        timeoutMs: resolved.timeoutMs,
        verbose: !!logger.debug,
      });

      if (drainResult.ok) {
        logger.info("[workspace-sync] Mailbox drain completed");

        if (currentOnInboxFiles) {
          const inboxAfter = existsSync(inboxLocalPath) ? readdirSync(inboxLocalPath) : [];
          const newFiles = inboxAfter.filter((f) => !inboxBefore.has(f));
          if (newFiles.length > 0) {
            try {
              currentOnInboxFiles(newFiles);
            } catch (err) {
              logger.warn(`[workspace-sync] Inbox notification error: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      } else {
        logger.warn(`[workspace-sync] Mailbox drain failed: ${drainResult.error}`);
      }
    } else {
      // mirror mode: one-way remote → local
      logger.info(
        `[workspace-sync] Running periodic mirror (remote→local): ${resolved.remoteName}:${resolved.remotePath}`,
      );

      const result = await runSync({
        configPath: resolved.configPath,
        remoteName: resolved.remoteName,
        remotePath: resolved.remotePath,
        localPath: resolved.localPath,
        direction: "pull",
        exclude: resolved.exclude,
        timeoutMs: resolved.timeoutMs,
        verbose: !!logger.debug,
      });

      state.lastSyncAt = new Date();
      state.syncCount++;

      if (result.ok) {
        state.lastSyncOk = true;
        logger.info("[workspace-sync] Periodic mirror completed");
      } else {
        state.lastSyncOk = false;
        state.errorCount++;
        logger.warn(`[workspace-sync] Periodic mirror failed: ${result.error}`);
      }

      // ingest: one-way local inbox → remote (additive)
      if (resolved.ingest) {
        // inbox lives as a sibling of localPath, not inside it,
        // so the mirror pull doesn't overwrite or delete inbox contents
        const { dirname } = await import("node:path");
        const inboxLocal = join(dirname(resolved.localPath), resolved.ingestPath);
        if (!existsSync(inboxLocal)) {
          mkdirSync(inboxLocal, { recursive: true });
        }
        const inboxRemotePath = resolved.remotePath
          ? `${resolved.remotePath}/${resolved.ingestPath}`
          : resolved.ingestPath;

        logger.info(
          `[workspace-sync] Running ingest (local inbox→remote): ${inboxLocal} → ${resolved.remoteName}:${inboxRemotePath}`,
        );

        const ingestResult = await runCopy({
          configPath: resolved.configPath,
          remoteName: resolved.remoteName,
          remotePath: inboxRemotePath,
          localPath: inboxLocal,
          direction: "push",
          exclude: resolved.exclude,
          timeoutMs: resolved.timeoutMs,
          verbose: !!logger.debug,
        });

        if (ingestResult.ok) {
          logger.info("[workspace-sync] Ingest sync completed");
        } else {
          logger.warn(`[workspace-sync] Ingest sync failed: ${ingestResult.error}`);
        }
      }
    }
  } catch (err) {
    state.lastSyncOk = false;
    state.errorCount++;
    logger.error(
      `[workspace-sync] Periodic sync error: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    state.syncing = false;
  }
}


/**
 * Bootstrap mailbox directories:
 *  - `rclone mkdir cloud:_outbox` so the local Dropbox client creates the folder
 *  - `mkdir -p <workspace>/_inbox` so the agent has a landing zone
 */
async function bootstrapMailbox(
  syncConfig: WorkspaceSyncConfig,
  workspaceDir: string,
  stateDir: string,
  logger: Logger,
): Promise<void> {
  const resolved = resolveSyncConfig(syncConfig, workspaceDir, stateDir);

  ensureRcloneConfigFromConfig(syncConfig, resolved.configPath, resolved.remoteName);

  const outboxRemotePath = resolved.remotePath
    ? `${resolved.remotePath}/_outbox`
    : "_outbox";

  const mkdirResult = await runMkdir({
    configPath: resolved.configPath,
    remoteName: resolved.remoteName,
    remotePath: outboxRemotePath,
  });

  if (mkdirResult.ok) {
    logger.info(`[workspace-sync] Mailbox: ensured cloud _outbox at ${resolved.remoteName}:${outboxRemotePath}`);
  } else {
    logger.warn(`[workspace-sync] Mailbox: failed to create cloud _outbox: ${mkdirResult.error}`);
  }

  const inboxLocalPath = join(resolved.localPath, "_inbox");
  if (!existsSync(inboxLocalPath)) {
    mkdirSync(inboxLocalPath, { recursive: true });
    logger.info(`[workspace-sync] Mailbox: created local _inbox at ${inboxLocalPath}`);
  }
}

export function startSyncManager(
  syncConfig: WorkspaceSyncConfig,
  workspaceDir: string,
  stateDir: string,
  logger: Logger,
  opts?: { onInboxFiles?: (files: string[]) => void },
): void {
  stopSyncManager();

  currentSyncConfig = syncConfig;
  currentWorkspaceDir = workspaceDir;
  currentStateDir = stateDir;
  currentLogger = logger;
  currentOnInboxFiles = opts?.onInboxFiles ?? null;

  if (!syncConfig.provider || syncConfig.provider === "off") {
    logger.info("[workspace-sync] Workspace sync not configured");
    return;
  }

  if (!syncConfig.mode) {
    logger.error(
      '[workspace-sync] BREAKING: "mode" is now required. Set "mode": "mailbox" (inbox/outbox, safest), "mode": "mirror" (remote→local), or "mode": "bisync" (bidirectional) in your openclaw.json plugin config. Sync will not start until mode is explicitly set.',
    );
    return;
  }

  clearBisyncLocks();

  // Mailbox mode: bootstrap _outbox on cloud and _inbox locally
  if (syncConfig.mode === "mailbox") {
    void bootstrapMailbox(syncConfig, workspaceDir, stateDir, logger);
  }

  const intervalSeconds = syncConfig.interval ?? 0;
  if (intervalSeconds <= 0) {
    logger.info("[workspace-sync] Periodic sync disabled (interval=0)");
    return;
  }

  const effectiveInterval = Math.max(intervalSeconds, 60);
  if (effectiveInterval !== intervalSeconds) {
    logger.warn(
      `[workspace-sync] Interval increased from ${intervalSeconds}s to ${effectiveInterval}s (minimum)`,
    );
  }

  const mode = syncConfig.mode ?? "mirror";
  logger.info(
    `[workspace-sync] Starting periodic sync every ${effectiveInterval}s in ${mode} mode (pure file sync, zero LLM cost)`,
  );

  state.running = true;
  state.intervalMs = effectiveInterval * 1000;

  state.timeoutId = setTimeout(() => {
    void runSyncLoop();
  }, 5000);
}

export function stopSyncManager(): void {
  state.running = false;
  state.syncing = false;
  if (state.timeoutId) {
    clearTimeout(state.timeoutId);
    state.timeoutId = null;
  }
  currentSyncConfig = null;
  currentWorkspaceDir = null;
  currentStateDir = null;
  currentLogger = null;
  currentOnInboxFiles = null;
}

export function getSyncManagerStatus(): {
  running: boolean;
  lastSyncAt: Date | null;
  lastSyncOk: boolean | null;
  syncCount: number;
  errorCount: number;
} {
  return {
    running: state.running,
    lastSyncAt: state.lastSyncAt,
    lastSyncOk: state.lastSyncOk,
    syncCount: state.syncCount,
    errorCount: state.errorCount,
  };
}

export function isSyncing(): boolean {
  return state.syncing;
}

export async function triggerImmediateSync(): Promise<void> {
  await doSync();
}
