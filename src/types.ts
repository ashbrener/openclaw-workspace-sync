/**
 * Workspace sync provider modes.
 * - off: no sync
 * - dropbox: Dropbox via rclone
 * - gdrive: Google Drive via rclone
 * - onedrive: OneDrive via rclone
 * - s3: S3-compatible storage via rclone
 * - custom: custom rclone remote (user-configured)
 */
export type WorkspaceSyncProvider = "off" | "dropbox" | "gdrive" | "onedrive" | "s3" | "custom";

/**
 * Workspace sync modes.
 * - mirror: one-way remote→local (safe, simple)
 * - mailbox: inbox/outbox pattern — workspace mirrors down, _outbox sends files up (safest)
 * - bisync: bidirectional via rclone bisync (advanced, risky on ephemeral platforms)
 */
export type WorkspaceSyncMode = "mirror" | "mailbox" | "bisync";

/** What to include in a backup snapshot. */
export type BackupIncludeItem =
  | "workspace"
  | "config"
  | "cron"
  | "memory"
  | "sessions"
  | "credentials"
  | "skills"
  | "hooks"
  | "extensions"
  | "env"
  | "agents"
  | "pages"
  | "transcripts";

/** Retention policy: a number (keep N most recent) or tiered object. */
export type BackupRetain = number | {
  daily?: number;
  weekly?: number;
  monthly?: number;
};

/** Backup configuration — optional block within the plugin config. */
export type BackupConfig = {
  enabled?: boolean;
  /** Cloud provider for backup storage (can differ from sync provider). Defaults to the parent sync provider. */
  provider?: WorkspaceSyncProvider;
  /** rclone remote name for backup (separate from sync remote). Default: "backup". */
  remoteName?: string;
  /** Path to rclone config file for backup remote. */
  configPath?: string;
  /** Remote path/prefix for snapshots. */
  remotePath?: string;
  /** S3 bucket name (shorthand — also settable via s3.bucket). */
  bucket?: string;
  /** Prefix within the bucket/remote for this agent's snapshots. */
  prefix?: string;
  /** Backup interval in seconds (default: 86400 = daily). */
  interval?: number;
  /** Encrypt snapshots with AES-256 before upload. */
  encrypt?: boolean;
  /** Encryption passphrase. Use env var reference like ${BACKUP_PASSPHRASE}. */
  passphrase?: string;
  /** What to include in the backup. Default: ["workspace", "config", "cron", "memory"]. */
  include?: BackupIncludeItem[];
  /** Retention policy. Number = keep N most recent. Object = tiered retention. Default: 7. */
  retain?: BackupRetain;
  /** Glob patterns to exclude from workspace backup. Inherits from parent exclude if not set. */
  exclude?: string[];
  /** Provider-specific overrides for the backup remote. */
  s3?: {
    endpoint?: string;
    bucket?: string;
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
  };
  dropbox?: {
    appFolder?: boolean;
    appKey?: string;
    appSecret?: string;
    token?: string;
  };
  gdrive?: {
    token?: string;
    teamDrive?: string;
    rootFolderId?: string;
  };
  onedrive?: {
    token?: string;
    driveId?: string;
    driveType?: "personal" | "business" | "sharepoint";
  };
  custom?: {
    rcloneType: string;
    rcloneOptions?: Record<string, string>;
  };
};

/**
 * Workspace sync configuration — matches the plugin configSchema.
 */
export type WorkspaceSyncConfig = {
  provider?: WorkspaceSyncProvider;
  /** Sync mode: "mailbox" (inbox/outbox, safest), "mirror" (remote→local), or "bisync" (bidirectional, advanced). */
  mode?: WorkspaceSyncMode;
  /** Enable a local inbox folder that syncs one-way up to the remote workspace (mirror mode only). */
  ingest?: boolean;
  /** Local subfolder name for ingestion, relative to localPath. Default: "inbox". Mirror mode only. */
  ingestPath?: string;
  /** Notify the agent when files arrive in _inbox after a mailbox drain. Off by default to avoid waking the agent and burning credits. */
  notifyOnInbox?: boolean;
  remotePath?: string;
  localPath?: string;
  interval?: number;
  /** Max seconds to wait for a single rclone sync operation (default: 1800 = 30 min). */
  timeout?: number;
  onSessionStart?: boolean;
  onSessionEnd?: boolean;
  remoteName?: string;
  configPath?: string;
  conflictResolve?: "newer" | "local" | "remote";
  exclude?: string[];
  copySymlinks?: boolean;
  /** Backup configuration — encrypted snapshots to cloud storage. */
  backup?: BackupConfig;
  s3?: {
    endpoint?: string;
    bucket?: string;
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
  };
  dropbox?: {
    appFolder?: boolean;
    appKey?: string;
    appSecret?: string;
    token?: string;
  };
  gdrive?: {
    token?: string;
    teamDrive?: string;
    rootFolderId?: string;
  };
  onedrive?: {
    token?: string;
    driveId?: string;
    driveType?: "personal" | "business" | "sharepoint";
  };
  custom?: {
    rcloneType: string;
    rcloneOptions?: Record<string, string>;
  };
};
