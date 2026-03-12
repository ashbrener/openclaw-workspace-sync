/**
 * Backup manager — encrypted snapshot backups to cloud storage.
 *
 * Creates timestamped tar.gz archives of workspace, config, cron, memory, etc.,
 * optionally encrypts them with AES-256, uploads via rclone, and prunes old snapshots.
 */

import { execFile, spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { pipeline } from "node:stream/promises";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import type { BackupConfig, BackupIncludeItem, BackupRetain, WorkspaceSyncConfig, WorkspaceSyncProvider } from "./types.js";
import {
  getRcloneBinary,
  isRcloneInstalled,
  isRcloneConfigured,
  ensureRcloneConfigFromConfig,
  getDefaultRcloneConfigPath,
  generateRcloneConfig,
  writeRcloneConfig,
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
  const extensionsDir = join(dirname(stateDir), "extensions");

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
    transcripts: join(stateDir, "agents"),
  };

  return include.map((item) => {
    const p = map[item];
    return { item, path: p, exists: existsSync(p) };
  });
}

// ── Archive ──────────────────────────────────────────────────────────

function createTarGz(
  sources: Array<{ item: string; path: string }>,
  outputPath: string,
  exclude: string[],
  logger: Logger,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const dir = dirname(outputPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const args = ["czf", outputPath];

    for (const pattern of exclude) {
      args.push(`--exclude=${pattern}`);
    }

    for (const src of sources) {
      const stat = statSync(src.path);
      if (stat.isDirectory()) {
        args.push("-C", dirname(src.path), basename(src.path));
      } else {
        args.push("-C", dirname(src.path), basename(src.path));
      }
    }

    logger.info(`[backup] Creating archive: ${outputPath}`);

    execFile("tar", args, { maxBuffer: 10_000_000 }, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(`tar failed: ${stderr || err.message}`));
        return;
      }
      resolve();
    });
  });
}

// ── Encryption ───────────────────────────────────────────────────────

const SALT_LEN = 16;
const IV_LEN = 16;
const KEY_LEN = 32;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN);
}

async function encryptFile(inputPath: string, outputPath: string, passphrase: string): Promise<void> {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-cbc", key, iv);

  const out = createWriteStream(outputPath);
  out.write(salt);
  out.write(iv);

  const input = createReadStream(inputPath);
  await pipeline(input, cipher, out);
}

async function decryptFile(inputPath: string, outputPath: string, passphrase: string): Promise<void> {
  const fd = await import("node:fs/promises");
  const handle = await fd.open(inputPath, "r");
  try {
    const saltBuf = Buffer.alloc(SALT_LEN);
    const ivBuf = Buffer.alloc(IV_LEN);
    await handle.read(saltBuf, 0, SALT_LEN, 0);
    await handle.read(ivBuf, 0, IV_LEN, SALT_LEN);

    const key = deriveKey(passphrase, saltBuf);
    const decipher = createDecipheriv("aes-256-cbc", key, ivBuf);

    const input = createReadStream(inputPath, { start: SALT_LEN + IV_LEN });
    const out = createWriteStream(outputPath);
    await pipeline(input, decipher, out);
  } finally {
    await handle.close();
  }
}

// ── rclone upload / list / delete ────────────────────────────────────

function resolveBackupRcloneConfig(
  syncConfig: WorkspaceSyncConfig,
  backupConfig: BackupConfig,
  stateDir: string,
): { configPath: string; remoteName: string; remotePath: string; provider: WorkspaceSyncProvider } {
  const provider = backupConfig.provider ?? syncConfig.provider ?? "s3";
  const remoteName = backupConfig.remoteName ?? "backup";
  const configPath = backupConfig.configPath ?? syncConfig.configPath ?? getDefaultRcloneConfigPath(stateDir);

  let remotePath = backupConfig.remotePath ?? "";
  if (backupConfig.bucket) {
    remotePath = backupConfig.bucket;
  } else if (backupConfig.s3?.bucket) {
    remotePath = backupConfig.s3.bucket;
  }
  if (backupConfig.prefix) {
    remotePath = remotePath ? `${remotePath}/${backupConfig.prefix}` : backupConfig.prefix;
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

async function uploadFile(
  localPath: string,
  configPath: string,
  remoteName: string,
  remotePath: string,
  logger: Logger,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const binary = await getRcloneBinary();
    const dest = remotePath ? `${remoteName}:${remotePath}` : `${remoteName}:`;
    const args = [
      "copyto",
      localPath,
      `${dest}/${basename(localPath)}`,
      "--config", configPath,
    ];

    logger.info(`[backup] Uploading ${basename(localPath)} → ${dest}/`);

    return new Promise((resolve) => {
      execFile(binary, args, { timeout: 600_000 }, (err, _stdout, stderr) => {
        if (err) {
          resolve({ ok: false, error: stderr || err.message });
        } else {
          resolve({ ok: true });
        }
      });
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
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
): Promise<void> {
  const binary = await getRcloneBinary();
  const remote = remotePath ? `${remoteName}:${remotePath}/${fileName}` : `${remoteName}:${fileName}`;
  await new Promise<void>((resolve) => {
    execFile(binary, ["deletefile", remote, "--config", configPath], { timeout: 30_000 }, () => {
      resolve();
    });
  });
}

async function downloadFile(
  configPath: string,
  remoteName: string,
  remotePath: string,
  fileName: string,
  localPath: string,
  logger: Logger,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const binary = await getRcloneBinary();
    const remote = remotePath ? `${remoteName}:${remotePath}/${fileName}` : `${remoteName}:${fileName}`;
    const args = ["copyto", remote, localPath, "--config", configPath];

    logger.info(`[backup] Downloading ${fileName} → ${localPath}`);

    return new Promise((resolve) => {
      execFile(binary, args, { timeout: 600_000 }, (err, _stdout, stderr) => {
        if (err) {
          resolve({ ok: false, error: stderr || err.message });
        } else {
          resolve({ ok: true });
        }
      });
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
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
    const m = name.match(/backup-(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
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
  const excludePatterns = backup.exclude ?? syncConfig.exclude ?? ["**/.git/**", "**/node_modules/**"];
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

  const timestamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15) + "Z";
  const tmpDir = join(stateDir, ".backup-tmp");
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

  const archiveName = `backup-${timestamp}.tar.gz`;
  const archivePath = join(tmpDir, archiveName);

  try {
    await createTarGz(existing, archivePath, excludePatterns, logger);

    let uploadPath = archivePath;
    let uploadName = archiveName;

    if (doEncrypt && passphrase) {
      const encPath = `${archivePath}.enc`;
      logger.info("[backup] Encrypting snapshot (AES-256)");
      await encryptFile(archivePath, encPath, passphrase);
      unlinkSync(archivePath);
      uploadPath = encPath;
      uploadName = `${archiveName}.enc`;
    }

    const stat = statSync(uploadPath);
    logger.info(`[backup] Snapshot size: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);

    const uploadResult = await uploadFile(uploadPath, configPath, remoteName, remotePath, logger);

    unlinkSync(uploadPath);

    if (isErr(uploadResult)) {
      return { ok: false, error: `Upload failed: ${uploadResult.error}` };
    }

    logger.info(`[backup] Snapshot uploaded: ${uploadName}`);

    await pruneSnapshots(configPath, remoteName, remotePath, backup.retain, logger);

    return {
      ok: true,
      snapshotName: uploadName,
      encrypted: doEncrypt,
      sizeBytes: stat.size,
    };
  } catch (err) {
    if (existsSync(archivePath)) unlinkSync(archivePath);
    if (existsSync(`${archivePath}.enc`)) unlinkSync(`${archivePath}.enc`);
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
    await deleteRemoteFile(configPath, remoteName, remotePath, file);
    logger.info(`[backup] Deleted: ${file}`);
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

  const tmpDir = join(stateDir, ".backup-tmp");
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

  const downloadPath = join(tmpDir, targetSnapshot);

  try {
    const dlResult = await downloadFile(configPath, remoteName, remotePath, targetSnapshot, downloadPath, logger);
    if (isErr(dlResult)) return { ok: false, error: `Download failed: ${dlResult.error}` };

    let archivePath = downloadPath;

    if (targetSnapshot.endsWith(".enc")) {
      if (!passphrase) return { ok: false, error: "Snapshot is encrypted but no passphrase" };
      const decPath = downloadPath.replace(/\.enc$/, "");
      logger.info("[backup] Decrypting snapshot");
      await decryptFile(downloadPath, decPath, passphrase);
      unlinkSync(downloadPath);
      archivePath = decPath;
    }

    const restoreDir = restoreTo;
    if (!existsSync(restoreDir)) mkdirSync(restoreDir, { recursive: true });

    logger.info(`[backup] Extracting to ${restoreDir}`);

    await new Promise<void>((resolve, reject) => {
      execFile("tar", ["xzf", archivePath, "-C", restoreDir], { timeout: 300_000 }, (err) => {
        if (err) reject(new Error(`tar extract failed: ${err.message}`));
        else resolve();
      });
    });

    unlinkSync(archivePath);

    logger.info(`[backup] Restore complete: ${targetSnapshot} → ${restoreDir}`);

    return { ok: true, snapshotName: targetSnapshot, restoredTo: restoreDir };
  } catch (err) {
    if (existsSync(downloadPath)) unlinkSync(downloadPath);
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
  const intervalMs = (bkSyncConfig.backup.interval ?? 86400) * 1000;
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
