/**
 * Background workspace sync manager — runs as a plugin service.
 *
 * Runs rclone bisync at configured intervals WITHOUT involving the agent/LLM.
 * Pure file operation, zero token cost.
 */

import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { WorkspaceSyncConfig } from "./types.js";
import {
  isRcloneInstalled,
  isRcloneConfigured,
  ensureRcloneConfigFromConfig,
  resolveSyncConfig,
  runBisync,
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
  hasSuccessfulSync: boolean;
  running: boolean;
  intervalMs: number;
};

const state: SyncManagerState = {
  timeoutId: null,
  lastSyncAt: null,
  lastSyncOk: null,
  syncCount: 0,
  errorCount: 0,
  hasSuccessfulSync: false,
  running: false,
  intervalMs: 0,
};

let currentSyncConfig: WorkspaceSyncConfig | null = null;
let currentWorkspaceDir: string | null = null;
let currentStateDir: string | null = null;
let currentLogger: Logger | null = null;

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

  const syncConfig = currentSyncConfig;
  if (!syncConfig.provider || syncConfig.provider === "off") return;

  const logger = currentLogger;

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

    logger.info(
      `[workspace-sync] Running periodic sync: ${resolved.remoteName}:${resolved.remotePath}`,
    );

    const needsResync = !state.hasSuccessfulSync;

    let result = await runBisync({
      configPath: resolved.configPath,
      remoteName: resolved.remoteName,
      remotePath: resolved.remotePath,
      localPath: resolved.localPath,
      conflictResolve: resolved.conflictResolve,
      exclude: resolved.exclude,
      copySymlinks: resolved.copySymlinks,
      resync: needsResync,
    });

    if (!result.ok && result.error?.includes("--resync") && !needsResync) {
      logger.info("[workspace-sync] First-time sync detected, running with --resync");
      result = await runBisync({
        configPath: resolved.configPath,
        remoteName: resolved.remoteName,
        remotePath: resolved.remotePath,
        localPath: resolved.localPath,
        conflictResolve: resolved.conflictResolve,
        exclude: resolved.exclude,
        copySymlinks: resolved.copySymlinks,
        resync: true,
      });
    }

    state.lastSyncAt = new Date();
    state.syncCount++;

    if (result.ok) {
      state.lastSyncOk = true;
      state.hasSuccessfulSync = true;
      logger.info("[workspace-sync] Periodic sync completed");
    } else {
      state.lastSyncOk = false;
      state.errorCount++;
      logger.warn(`[workspace-sync] Periodic sync failed: ${result.error}`);

      if (result.error?.includes("lock file found") || result.error?.includes(".lck")) {
        logger.info("[workspace-sync] Clearing lock file for next sync attempt");
        clearStaleLocks(logger);
      }
    }
  } catch (err) {
    state.lastSyncOk = false;
    state.errorCount++;
    logger.error(
      `[workspace-sync] Periodic sync error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function clearStaleLocks(logger: Logger): void {
  const lockDir = join(homedir(), ".cache", "rclone", "bisync");
  try {
    if (!existsSync(lockDir)) return;
    const files = readdirSync(lockDir);
    for (const f of files.filter((f) => f.endsWith(".lck"))) {
      try {
        unlinkSync(join(lockDir, f));
        logger.info(`[workspace-sync] Cleared stale lock: ${f}`);
      } catch {
        // ignore
      }
    }
  } catch {
    // lock dir doesn't exist
  }
}

export function startSyncManager(
  syncConfig: WorkspaceSyncConfig,
  workspaceDir: string,
  stateDir: string,
  logger: Logger,
): void {
  stopSyncManager();

  currentSyncConfig = syncConfig;
  currentWorkspaceDir = workspaceDir;
  currentStateDir = stateDir;
  currentLogger = logger;

  if (!syncConfig.provider || syncConfig.provider === "off") {
    logger.info("[workspace-sync] Workspace sync not configured");
    return;
  }

  clearStaleLocks(logger);

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

  logger.info(
    `[workspace-sync] Starting periodic sync every ${effectiveInterval}s (pure file sync, zero LLM cost)`,
  );

  state.running = true;
  state.intervalMs = effectiveInterval * 1000;

  state.timeoutId = setTimeout(() => {
    void runSyncLoop();
  }, 5000);
}

export function stopSyncManager(): void {
  state.running = false;
  if (state.timeoutId) {
    clearTimeout(state.timeoutId);
    state.timeoutId = null;
  }
  currentSyncConfig = null;
  currentWorkspaceDir = null;
  currentStateDir = null;
  currentLogger = null;
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

export async function triggerImmediateSync(): Promise<void> {
  await doSync();
}
