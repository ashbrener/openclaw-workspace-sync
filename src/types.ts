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
 * Workspace sync configuration — matches the plugin configSchema.
 */
export type WorkspaceSyncConfig = {
  provider?: WorkspaceSyncProvider;
  remotePath?: string;
  localPath?: string;
  interval?: number;
  onSessionStart?: boolean;
  onSessionEnd?: boolean;
  remoteName?: string;
  configPath?: string;
  conflictResolve?: "newer" | "local" | "remote";
  exclude?: string[];
  copySymlinks?: boolean;
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
