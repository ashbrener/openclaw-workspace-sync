/**
 * Backup manager — encrypted snapshot backups to cloud storage.
 *
 * Streams tar | [openssl enc] | rclone rcat directly to the remote —
 * zero local disk usage. Optionally encrypts with AES-256 via openssl.
 * Prunes old snapshots based on retention policy.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import type { BackupConfig, BackupIncludeItem, BackupRetain, WorkspaceSyncConfig, WorkspaceSyncProvider } from "./types.js";
import {
  getRcloneBinary,
  isRcloneInstalled,
  isRcloneConfigured,
  ensureRcloneConfigFromConfig,
  getDefaultRcloneConfigPath,
} from "./rclone.js";

function isErr<T extends { ok: boolean }>(r: T): r is Extract<T, { ok: false }> {
  return !r.ok;
}

type Logger = {
  debug?: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

// ── Paths for each include item ──────────────────────────────────────

function resolveIncludePaths(
  include: BackupIncludeItem[],
  workspaceDir: string,
  stateDir: string,
): Array<{ item: BackupIncludeItem; path: string; exists: boolean }> {
  const extensionsDir = join(stateDir, "extensions");

  const map: Record<BackupIncludeItem, string> = {
    workspace: workspaceDir,
    config: join(stateDir, "openclaw.json"),
    cron: join(stateDir, "cron"),
    memory: join(workspaceDir, "memory"),
    sessions: join(stateDir, "sessions"),
    credentials: join(stateDir, "credentials"),
    skills: join(workspaceDir, "skills"),
    hooks: join(stateDir, "hooks"),
    extensions: existsSync(extensionsDir) ? extensionsDir : join(stateDir, "extensions"),
    env: join(workspaceDir, ".env"),
    agents: join(stateDir, "agents"),
    pages: join(workspaceDir, "pages"),
    transcripts: join(stateDir, "sessions"),
  };

  return include.map((item) => {
    const p = map[item];
    return { item, path: p, exists: existsSync(p) };
  });
}

// ── Archive ──────────────────────────────────────────────────────────

function buildTarArgs(
  sources: Array<{ item: string; path: string }>,
  exclude: string[],
): string[] {
  const args = ["cz"];

  for (const pattern of exclude) {
    args.push(`--exclude=${pattern}`);
  }

  for (const src of sources) {
    args.push("-C", dirname(src.path), basename(src.path));
  }

  return args;
}

/**
 * Stream tar output directly to rclone rcat — no local temp file needed.
 * For encryption, pipes through openssl enc in between.
 */
async function streamBackup(params: {
  sources: Array<{ item: string; path: string }>;
  exclude: string[];
  remoteDest: string;
  configPath: string;
  encrypt: boolean;
  passphrase?: string;
  logger: Logger;
}): Promise<{ ok: true; sizeBytes: number } | { ok: false; error: string }> {
  const { sources, exclude, remoteDest, configPath, encrypt, passphrase, logger } = params;

  const rcloneBinary = await getRcloneBinary();
  const tarArgs = buildTarArgs(sources, exclude);

  return new Promise((resolve) => {
    const tar = spawn("tar", tarArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let lastStdout = tar.stdout;
    let encExitCode: number | null = null;

    if (encrypt && passphrase) {
      const enc = spawn("openssl", [
        "enc", "-aes-256-cbc", "-salt", "-pbkdf2", "-iter", "100000",
        "-pass", "env:OPENCLAW_BACKUP_PASS",
      ], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, OPENCLAW_BACKUP_PASS: passphrase },
      });

      tar.stdout.pipe(enc.stdin);
      enc.stderr.on("data", (chunk: Buffer) => {
        const msg = chunk.toString().trim();
        if (msg) logger.warn(`[backup] openssl: ${msg}`);
      });
      enc.on("error", (err) => {
        resolve({ ok: false, error: `openssl spawn failed: ${err.message}` });
      });
      enc.on("close", (code) => { encExitCode = code; });
      lastStdout = enc.stdout;
    }

    const rcat = spawn(rcloneBinary, [
      "rcat", remoteDest, "--config", configPath,
    ], { stdio: ["pipe", "pipe", "pipe"] });

    lastStdout.pipe(rcat.stdin);

    let sizeBytes = 0;
    lastStdout.on("data", (chunk: Buffer) => {
      sizeBytes += chunk.length;
    });

    let tarErr = "";
    let tarExitCode: number | null = null;
    tar.stderr.on("data", (chunk: Buffer) => { tarErr += chunk.toString(); });
    tar.on("close", (code) => { tarExitCode = code; });

    let rcatErr = "";
    rcat.stderr.on("data", (chunk: Buffer) => { rcatErr += chunk.toString(); });

    rcat.on("close", (code) => {
      if (tarExitCode !== 0 && tarExitCode !== null) {
        resolve({ ok: false, error: `tar failed (exit ${tarExitCode}): ${tarErr}` });
      } else if (encExitCode !== 0 && encExitCode !== null) {
        resolve({ ok: false, error: `openssl enc failed (exit ${encExitCode})` });
      } else if (code !== 0) {
        resolve({ ok: false, error: `rclone rcat failed (exit ${code}): ${rcatErr}` });
      } else {
        resolve({ ok: true, sizeBytes });
      }
    });

    tar.on("error", (err) => {
      resolve({ ok: false, error: `tar spawn failed: ${err.message}` });
    });
    rcat.on("error", (err) => {
      resolve({ ok: false, error: `rclone rcat spawn failed: ${err.message}` });
    });
  });
}

// ── rclone list / delete ─────────────────────────────────────────────

function resolveBackupRcloneConfig(
  syncConfig: WorkspaceSyncConfig,
  backupConfig: BackupConfig,
  stateDir: string,
): { configPath: string; remoteName: string; remotePath: string; provider: WorkspaceSyncProvider } {
  const rawProvider = backupConfig.provider ?? syncConfig.provider;
  const provider = (rawProvider === "off" || !rawProvider) ? "s3" : rawProvider;
  const remoteName = backupConfig.remoteName ?? "backup";
  const configPath = backupConfig.configPath ?? syncConfig.configPath ?? getDefaultRcloneConfigPath(stateDir);

  let remotePath = (backupConfig.remotePath ?? "").replace(/^\/+|\/+$/g, "");
  if (backupConfig.bucket) {
    remotePath = backupConfig.bucket.replace(/^\/+|\/+$/g, "");
  } else if (backupConfig.s3?.bucket) {
    remotePath = backupConfig.s3.bucket.replace(/^\/+|\/+$/g, "");
  }
  const prefix = (backupConfig.prefix ?? "").replace(/^\/+|\/+$/g, "");
  if (prefix) {
    remotePath = remotePath ? `${remotePath}/${prefix}` : prefix;
  }

  return { configPath, remoteName, remotePath, provider };
}

function ensureBackupRcloneConfig(
  syncConfig: WorkspaceSyncConfig,
  backupConfig: BackupConfig,
  configPath: string,
  remoteName: string,
  provider: WorkspaceSyncProvider,
): void {
  if (isRcloneConfigured(configPath, remoteName)) return;

  const providerConfig = backupConfig.s3 ?? backupConfig.dropbox ?? backupConfig.gdrive ??
    backupConfig.onedrive ?? backupConfig.custom ??
    syncConfig.s3 ?? syncConfig.dropbox ?? syncConfig.gdrive ??
    syncConfig.onedrive ?? syncConfig.custom;

  if (!providerConfig) return;

  const effectiveSyncConfig: WorkspaceSyncConfig = {
    provider,
    s3: backupConfig.s3 ?? syncConfig.s3,
    dropbox: backupConfig.dropbox ?? syncConfig.dropbox,
    gdrive: backupConfig.gdrive ?? syncConfig.gdrive,
    onedrive: backupConfig.onedrive ?? syncConfig.onedrive,
    custom: backupConfig.custom ?? syncConfig.custom,
  };

  ensureRcloneConfigFromConfig(effectiveSyncConfig, configPath, remoteName);
}

async function listSnapshots(
  configPath: string,
  remoteName: string,
  remotePath: string,
): Promise<{ ok: true; files: string[] } | { ok: false; error: string }> {
  try {
    const binary = await getRcloneBinary();
    const remote = remotePath ? `${remoteName}:${remotePath}` : `${remoteName}:`;
    const args = ["lsf", remote, "--config", configPath, "--files-only"];

    return new Promise((resolve) => {
      execFile(binary, args, { timeout: 30_000, maxBuffer: 1_000_000 }, (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, error: stderr || err.message });
          return;
        }
        const files = stdout
          .split("\n")
          .map((f) => f.trim())
          .filter((f) => f.startsWith("backup-"))
          .sort();
        resolve({ ok: true, files });
      });
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function deleteRemoteFile(
  configPath: string,
  remoteName: string,
  remotePath: string,
  fileName: string,
  logger: Logger,
): Promise<void> {
  const binary = await getRcloneBinary();
  const remote = remotePath ? `${remoteName}:${remotePath}/${fileName}` : `${remoteName}:${fileName}`;
  await new Promise<void>((resolve) => {
    execFile(binary, ["deletefile", remote, "--config", configPath], { timeout: 30_000 }, (err, _stdout, stderr) => {
      if (err) {
        logger.warn(`[backup] Failed to delete ${fileName}: ${stderr || err.message}`);
      } else {
        logger.info(`[backup] Deleted: ${fileName}`);
      }
      resolve();
    });
  });
}

// ── Retention / pruning ──────────────────────────────────────────────

function resolveRetainCount(retain: BackupRetain | undefined): number {
  if (retain === undefined) return 7;
  if (typeof retain === "number") return Math.max(retain, 1);
  return Math.max(
    (retain.daily ?? 7) + (retain.weekly ?? 0) + (retain.monthly ?? 0),
    1,
  );
}

function selectSnapshotsToKeep(
  files: string[],
  retain: BackupRetain | undefined,
): Set<string> {
  if (retain === undefined || typeof retain === "number") {
    const count = resolveRetainCount(retain);
    const sorted = [...files].sort().reverse();
    return new Set(sorted.slice(0, count));
  }

  const keep = new Set<string>();
  const sorted = [...files].sort().reverse();

  const dailyCount = retain.daily ?? 7;
  const weeklyCount = retain.weekly ?? 0;
  const monthlyCount = retain.monthly ?? 0;

  function extractDate(name: string): string | null {
    const m = name.match(/backup-(\d{4})(\d{2})(\d{2})T/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }

  const seenDays = new Set<string>();
  const seenWeeks = new Set<string>();
  const seenMonths = new Set<string>();

  for (const file of sorted) {
    const date = extractDate(file);
    if (!date) continue;

    const d = new Date(date);
    const dayKey = date;
    const weekNum = Math.floor(d.getTime() / (7 * 86400000));
    const weekKey = `${weekNum}`;
    const monthKey = `${d.getFullYear()}-${d.getMonth()}`;

    if (seenDays.size < dailyCount && !seenDays.has(dayKey)) {
      keep.add(file);
      seenDays.add(dayKey);
    } else if (seenWeeks.size < weeklyCount && !seenWeeks.has(weekKey)) {
      keep.add(file);
      seenWeeks.add(weekKey);
    } else if (seenMonths.size < monthlyCount && !seenMonths.has(monthKey)) {
      keep.add(file);
      seenMonths.add(monthKey);
    }
  }

  if (keep.size === 0 && sorted.length > 0) keep.add(sorted[0]);
  return keep;
}

// ── Public API ───────────────────────────────────────────────────────

export type BackupResult =
  | { ok: true; snapshotName: string; encrypted: boolean; sizeBytes: number }
  | { ok: false; error: string };

export type RestoreResult =
  | { ok: true; snapshotName: string; restoredTo: string }
  | { ok: false; error: string };

export async function runBackup(params: {
  syncConfig: WorkspaceSyncConfig;
  workspaceDir: string;
  stateDir: string;
  logger: Logger;
}): Promise<BackupResult> {
  const { syncConfig, workspaceDir, stateDir, logger } = params;
  const backup = syncConfig.backup;

  if (!backup?.enabled) {
    return { ok: false, error: "Backup not enabled" };
  }

  const installed = await isRcloneInstalled();
  if (!installed) {
    return { ok: false, error: "rclone not installed" };
  }

  const include: BackupIncludeItem[] = backup.include ?? ["workspace", "config", "cron", "memory"];
  const excludePatterns = (backup.exclude ?? syncConfig.exclude ?? [".git", "node_modules", "__pycache__", ".venv", "venv"])
    .map((p) => p.replace(/^\*\*\//, "").replace(/\/\*\*$/, ""));
  const doEncrypt = backup.encrypt ?? false;
  const passphrase = backup.passphrase;

  if (doEncrypt && !passphrase) {
    return { ok: false, error: "Backup encryption enabled but no passphrase configured" };
  }

  const { configPath, remoteName, remotePath, provider } = resolveBackupRcloneConfig(syncConfig, backup, stateDir);

  ensureBackupRcloneConfig(syncConfig, backup, configPath, remoteName, provider);

  if (!isRcloneConfigured(configPath, remoteName)) {
    return { ok: false, error: `rclone not configured for backup remote "${remoteName}"` };
  }

  const paths = resolveIncludePaths(include, workspaceDir, stateDir);
  const existing = paths.filter((p) => p.exists);

  if (existing.length === 0) {
    return { ok: false, error: "No backup sources found" };
  }

  logger.info(`[backup] Starting backup: ${existing.map((p) => p.item).join(", ")}`);

  const now = new Date();
  const timestamp = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
    "T",
    String(now.getUTCHours()).padStart(2, "0"),
    String(now.getUTCMinutes()).padStart(2, "0"),
    String(now.getUTCSeconds()).padStart(2, "0"),
    "Z",
  ].join("");
  const ext = doEncrypt ? ".tar.gz.enc" : ".tar.gz";
  const snapshotName = `backup-${timestamp}${ext}`;

  const dest = remotePath ? `${remoteName}:${remotePath}/${snapshotName}` : `${remoteName}:${snapshotName}`;

  logger.info(`[backup] Streaming to ${dest} (no local temp file needed)`);

  try {
    const result = await streamBackup({
      sources: existing,
      exclude: excludePatterns,
      remoteDest: dest,
      configPath,
      encrypt: doEncrypt,
      passphrase,
      logger,
    });

    if (isErr(result)) {
      return { ok: false, error: result.error };
    }

    logger.info(`[backup] Snapshot uploaded: ${snapshotName} (~${(result.sizeBytes / 1024 / 1024).toFixed(1)} MB)`);

    await pruneSnapshots(configPath, remoteName, remotePath, backup.retain, logger);

    return { ok: true, snapshotName, encrypted: doEncrypt, sizeBytes: result.sizeBytes };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function pruneSnapshots(
  configPath: string,
  remoteName: string,
  remotePath: string,
  retain: BackupRetain | undefined,
  logger: Logger,
): Promise<void> {
  const listResult = await listSnapshots(configPath, remoteName, remotePath);
  if (isErr(listResult)) {
    logger.warn(`[backup] Could not list snapshots for pruning: ${listResult.error}`);
    return;
  }

  const keep = selectSnapshotsToKeep(listResult.files, retain);
  const toDelete = listResult.files.filter((f) => !keep.has(f));

  if (toDelete.length === 0) return;

  logger.info(`[backup] Pruning ${toDelete.length} old snapshot(s), keeping ${keep.size}`);

  for (const file of toDelete) {
    await deleteRemoteFile(configPath, remoteName, remotePath, file, logger);
  }
}

export async function listBackupSnapshots(params: {
  syncConfig: WorkspaceSyncConfig;
  stateDir: string;
  logger: Logger;
}): Promise<{ ok: true; snapshots: string[] } | { ok: false; error: string }> {
  const { syncConfig, stateDir, logger } = params;
  const backup = syncConfig.backup;

  if (!backup) {
    return { ok: false, error: "Backup not configured" };
  }

  const { configPath, remoteName, remotePath, provider } = resolveBackupRcloneConfig(syncConfig, backup, stateDir);
  ensureBackupRcloneConfig(syncConfig, backup, configPath, remoteName, provider);

  const result = await listSnapshots(configPath, remoteName, remotePath);
  if (isErr(result)) return { ok: false, error: result.error };

  return { ok: true, snapshots: result.files.sort().reverse() };
}

export async function runRestore(params: {
  syncConfig: WorkspaceSyncConfig;
  workspaceDir: string;
  stateDir: string;
  snapshotName: string | "latest";
  restoreTo: string;
  logger: Logger;
}): Promise<RestoreResult> {
  const { syncConfig, workspaceDir, stateDir, snapshotName, restoreTo, logger } = params;
  const backup = syncConfig.backup;

  if (!backup) {
    return { ok: false, error: "Backup not configured" };
  }

  const installed = await isRcloneInstalled();
  if (!installed) {
    return { ok: false, error: "rclone not installed" };
  }

  const doEncrypt = backup.encrypt ?? false;
  const passphrase = backup.passphrase;

  if (doEncrypt && !passphrase) {
    return { ok: false, error: "Backup is encrypted but no passphrase configured" };
  }

  const { configPath, remoteName, remotePath, provider } = resolveBackupRcloneConfig(syncConfig, backup, stateDir);
  ensureBackupRcloneConfig(syncConfig, backup, configPath, remoteName, provider);

  let targetSnapshot = snapshotName;
  if (targetSnapshot === "latest") {
    const listResult = await listSnapshots(configPath, remoteName, remotePath);
    if (isErr(listResult)) return { ok: false, error: `Cannot list snapshots: ${listResult.error}` };
    if (listResult.files.length === 0) return { ok: false, error: "No snapshots found" };
    targetSnapshot = listResult.files.sort().reverse()[0];
  }

  logger.info(`[backup] Restoring snapshot: ${targetSnapshot}`);

  const restoreDir = restoreTo;
  if (!existsSync(restoreDir)) mkdirSync(restoreDir, { recursive: true });

  const rcloneBinary = await getRcloneBinary();
  const remoteSrc = remotePath
    ? `${remoteName}:${remotePath}/${targetSnapshot}`
    : `${remoteName}:${targetSnapshot}`;

  try {
    logger.info(`[backup] Streaming restore to ${restoreDir} (no local temp file needed)`);

    await new Promise<void>((resolve, reject) => {
      const rcat = spawn(rcloneBinary, [
        "cat", remoteSrc, "--config", configPath,
      ], { stdio: ["ignore", "pipe", "pipe"] });

      let lastStdout = rcat.stdout;

      if (targetSnapshot.endsWith(".enc")) {
        if (!passphrase) { reject(new Error("Snapshot is encrypted but no passphrase")); return; }
        const dec = spawn("openssl", [
          "enc", "-d", "-aes-256-cbc", "-salt", "-pbkdf2", "-iter", "100000",
          "-pass", "env:OPENCLAW_BACKUP_PASS",
        ], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, OPENCLAW_BACKUP_PASS: passphrase },
        });

        rcat.stdout.pipe(dec.stdin);
        dec.stderr.on("data", (chunk: Buffer) => {
          const msg = chunk.toString().trim();
          if (msg) logger.warn(`[backup] openssl: ${msg}`);
        });
        lastStdout = dec.stdout;
        dec.on("error", (err) => reject(new Error(`openssl spawn failed: ${err.message}`)));
      }

      const tar = spawn("tar", ["xz", "--no-same-owner", "-C", restoreDir], { stdio: ["pipe", "ignore", "pipe"] });
      lastStdout.pipe(tar.stdin);

      let tarErr = "";
      tar.stderr.on("data", (chunk: Buffer) => { tarErr += chunk.toString(); });

      let rcatErr = "";
      rcat.stderr.on("data", (chunk: Buffer) => { rcatErr += chunk.toString(); });

      tar.on("close", (code) => {
        if (code !== 0) reject(new Error(`tar extract failed (exit ${code}): ${tarErr}`));
        else resolve();
      });

      rcat.on("close", (code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`rclone cat failed (exit ${code}): ${rcatErr}`));
        }
      });

      rcat.on("error", (err) => reject(err));
      tar.on("error", (err) => reject(err));
    });

    logger.info(`[backup] Restore complete: ${targetSnapshot} → ${restoreDir}`);

    return { ok: true, snapshotName: targetSnapshot, restoredTo: restoreDir };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Background service ───────────────────────────────────────────────

type BackupManagerState = {
  timeoutId: ReturnType<typeof setTimeout> | null;
  running: boolean;
  lastBackupAt: Date | null;
  lastBackupOk: boolean | null;
  backupCount: number;
  errorCount: number;
};

const backupState: BackupManagerState = {
  timeoutId: null,
  running: false,
  lastBackupAt: null,
  lastBackupOk: null,
  backupCount: 0,
  errorCount: 0,
};

let bkSyncConfig: WorkspaceSyncConfig | null = null;
let bkWorkspaceDir: string | null = null;
let bkStateDir: string | null = null;
let bkLogger: Logger | null = null;

function scheduleNextBackup(): void {
  if (!backupState.running || !bkSyncConfig?.backup) return;
  const intervalMs = Math.max(bkSyncConfig.backup.interval ?? 86400, 300) * 1000;
  if (intervalMs <= 0) return;

  backupState.timeoutId = setTimeout(() => {
    void doBackupLoop();
  }, intervalMs);
}

async function doBackupLoop(): Promise<void> {
  if (!bkSyncConfig || !bkWorkspaceDir || !bkStateDir || !bkLogger) return;

  try {
    const result = await runBackup({
      syncConfig: bkSyncConfig,
      workspaceDir: bkWorkspaceDir,
      stateDir: bkStateDir,
      logger: bkLogger,
    });

    backupState.lastBackupAt = new Date();
    backupState.backupCount++;

    if (result.ok) {
      backupState.lastBackupOk = true;
      bkLogger.info(`[backup] Scheduled backup complete: ${result.snapshotName} (${(result.sizeBytes / 1024 / 1024).toFixed(1)} MB)`);
    } else if (isErr(result)) {
      backupState.lastBackupOk = false;
      backupState.errorCount++;
      bkLogger.error(`[backup] Scheduled backup failed: ${result.error}`);
    }
  } catch (err) {
    backupState.lastBackupOk = false;
    backupState.errorCount++;
    bkLogger?.error(`[backup] Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }

  scheduleNextBackup();
}

export function startBackupManager(
  syncConfig: WorkspaceSyncConfig,
  workspaceDir: string,
  stateDir: string,
  logger: Logger,
): void {
  stopBackupManager();

  const backup = syncConfig.backup;
  if (!backup?.enabled) return;

  bkSyncConfig = syncConfig;
  bkWorkspaceDir = workspaceDir;
  bkStateDir = stateDir;
  bkLogger = logger;

  const intervalSeconds = backup.interval ?? 86400;
  if (intervalSeconds <= 0) {
    logger.info("[backup] Scheduled backups disabled (interval=0)");
    return;
  }

  const effectiveInterval = Math.max(intervalSeconds, 300);
  backupState.running = true;

  logger.info(`[backup] Backup service started — every ${effectiveInterval}s`);

  backupState.timeoutId = setTimeout(() => {
    void doBackupLoop();
  }, 30_000);
}

export function stopBackupManager(): void {
  backupState.running = false;
  if (backupState.timeoutId) {
    clearTimeout(backupState.timeoutId);
    backupState.timeoutId = null;
  }
  bkSyncConfig = null;
  bkWorkspaceDir = null;
  bkStateDir = null;
  bkLogger = null;
}

export function getBackupManagerStatus(): {
  running: boolean;
  lastBackupAt: Date | null;
  lastBackupOk: boolean | null;
  backupCount: number;
  errorCount: number;
} {
  return {
    running: backupState.running,
    lastBackupAt: backupState.lastBackupAt,
    lastBackupOk: backupState.lastBackupOk,
    backupCount: backupState.backupCount,
    errorCount: backupState.errorCount,
  };
}
