# OpenClaw Workspace Cloud Sync Plugin

Bidirectional workspace sync between your OpenClaw agent and cloud storage via [rclone](https://rclone.org/).

Supports **Dropbox, Google Drive, OneDrive, S3/R2/Minio**, and [70+ cloud providers](https://rclone.org/overview/).

## How it works

<p align="center">
  <img src="https://raw.githubusercontent.com/ashbrener/openclaw-workspace-sync/main/docs/how-it-works.png" alt="How it works — Local Machine syncs to Cloud Provider syncs to Remote Gateway" width="600" />
</p>

Drop a file locally — it appears on the remote Gateway (and vice versa).

**Zero LLM cost.** All sync operations are pure rclone file operations — they never wake the bot or trigger LLM calls.

## Architecture

<p align="center">
  <img src="https://raw.githubusercontent.com/ashbrener/openclaw-workspace-sync/main/docs/architecture.png" alt="Plugin architecture — CLI, Hooks, and Sync Manager feed into rclone wrapper" width="600" />
</p>

## Install

```bash
openclaw plugins install openclaw-workspace-sync
```

Or clone into your extensions directory:

```bash
cd ~/.openclaw/extensions
git clone https://github.com/ashbrener/openclaw-workspace-sync workspace-sync
cd workspace-sync && npm install --omit=dev
```

## Quick start

```bash
# Interactive setup wizard (recommended)
openclaw workspace setup
```

The setup wizard guides you through:
1. Checking/installing rclone
2. Selecting cloud provider
3. Dropbox app folder option (for scoped access)
4. Background sync interval
5. OAuth authorization
6. First sync

Or configure manually — see [Configuration](#configuration) below.

## Configuration

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-workspace-sync": {
        "enabled": true,
        "config": {
          "provider": "dropbox",
          "remotePath": "openclaw-share",
          "localPath": "shared",
          "interval": 300,
          "onSessionStart": true,
          "onSessionEnd": false,
          "conflictResolve": "newer",
          "exclude": [".git/**", "node_modules/**", "*.log"]
        }
      }
    }
  }
}
```

### Config reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `provider` | string | `"off"` | `dropbox` \| `gdrive` \| `onedrive` \| `s3` \| `custom` \| `off` |
| `remotePath` | string | `"openclaw-share"` | Folder name in cloud storage |
| `localPath` | string | `"shared"` | Subfolder within workspace to sync |
| `interval` | number | `0` | Background sync interval in seconds (0 = manual only, min 60) |
| `onSessionStart` | boolean | `false` | Sync when an agent session begins |
| `onSessionEnd` | boolean | `false` | Sync when an agent session ends |
| `remoteName` | string | `"cloud"` | rclone remote name |
| `configPath` | string | auto | Path to rclone.conf |
| `conflictResolve` | string | `"newer"` | `newer` \| `local` \| `remote` |
| `exclude` | string[] | see below | Glob patterns to exclude |
| `copySymlinks` | boolean | `false` | Follow symlinks during sync |

Default excludes: `.git/**`, `node_modules/**`, `.venv/**`, `__pycache__/**`, `*.log`, `.DS_Store`

### Provider-specific options

**Dropbox with app folder (recommended for security):**

```json
{
  "provider": "dropbox",
  "remotePath": "",
  "dropbox": {
    "appFolder": true,
    "appKey": "your-app-key",
    "appSecret": "your-app-secret",
    "token": "{\"access_token\":\"...\"}"
  }
}
```

**Google Drive:**

```json
{
  "provider": "gdrive",
  "remotePath": "openclaw-sync",
  "gdrive": {
    "token": "{\"access_token\":\"...\"}",
    "teamDrive": "0ABcDeFgHiJ",
    "rootFolderId": "folder-id"
  }
}
```

`teamDrive` and `rootFolderId` are optional — omit them for personal Google Drive.

**OneDrive:**

```json
{
  "provider": "onedrive",
  "remotePath": "openclaw-sync",
  "onedrive": {
    "token": "{\"access_token\":\"...\"}",
    "driveId": "drive-id",
    "driveType": "business"
  }
}
```

`driveType` can be `personal`, `business`, or `sharepoint`. Both fields are optional.

**S3 / Cloudflare R2 / Minio:**

```json
{
  "provider": "s3",
  "remotePath": "openclaw-sync",
  "s3": {
    "endpoint": "https://s3.us-east-1.amazonaws.com",
    "bucket": "your-bucket",
    "region": "us-east-1",
    "accessKeyId": "AKID...",
    "secretAccessKey": "SECRET..."
  }
}
```

**Any rclone backend (SFTP, B2, Mega, pCloud, etc.):**

```json
{
  "provider": "custom",
  "remotePath": "openclaw-sync",
  "custom": {
    "rcloneType": "sftp",
    "rcloneOptions": {
      "host": "example.com",
      "user": "deploy",
      "key_file": "/path/to/key"
    }
  }
}
```

The `custom` provider accepts any [rclone backend type](https://rclone.org/overview/) and passes `rcloneOptions` directly to the rclone config. This gives you config-driven access to all 70+ providers without manually editing `rclone.conf`.

## CLI commands

```bash
# Interactive setup wizard
openclaw workspace setup

# Check sync status
openclaw workspace status

# Sync bidirectionally
openclaw workspace sync

# First sync (required once to establish baseline)
openclaw workspace sync --resync

# Preview changes without syncing
openclaw workspace sync --dry-run

# One-way sync
openclaw workspace sync --direction pull   # remote -> local
openclaw workspace sync --direction push   # local -> remote

# Authorize with cloud provider
openclaw workspace authorize
openclaw workspace authorize --provider gdrive

# List remote files
openclaw workspace list
```

## Auto-sync

### Session hooks

Sync automatically when sessions start or end. These run during existing agent activity and incur zero LLM cost:

```json
{
  "onSessionStart": true,
  "onSessionEnd": false
}
```

### Periodic background sync

Set `interval` to enable automatic background sync (in seconds):

```json
{
  "interval": 300
}
```

The gateway runs rclone bisync in the background at this interval. Minimum interval is 60 seconds.

### External cron (alternative)

```bash
# Add to crontab (crontab -e)
*/5 * * * * openclaw workspace sync >> /var/log/openclaw-sync.log 2>&1
```

## Supported providers

| Provider | Config value | Auth method | Config-driven |
|----------|-------------|-------------|---------------|
| Dropbox | `dropbox` | OAuth token | Full (token, appKey, appSecret, appFolder) |
| Google Drive | `gdrive` | OAuth token | Full (token, teamDrive, rootFolderId) |
| OneDrive | `onedrive` | OAuth token | Full (token, driveId, driveType) |
| S3/R2/Minio | `s3` | Access keys | Full (endpoint, bucket, region, credentials) |
| Any rclone backend | `custom` | Varies | Full (rcloneType + rcloneOptions) |

All providers are fully config-driven — no manual `rclone.conf` editing needed. The `custom` provider gives access to all [70+ rclone backends](https://rclone.org/overview/) (SFTP, B2, Mega, pCloud, Azure Blob, etc.).

## Manual setup (without wizard)

If you prefer to skip the interactive wizard, configure the plugin in `openclaw.json` and use the CLI:

```bash
# 1. Authorize with your cloud provider
openclaw workspace authorize --provider dropbox

# 2. Run the first sync (establishes baseline)
openclaw workspace sync --resync
```

The plugin handles rclone installation, config generation, and token storage automatically based on your `openclaw.json` settings.

## Dropbox app folder access (recommended)

For better security, create a scoped Dropbox app that only accesses a single folder:

1. Go to [Dropbox App Console](https://www.dropbox.com/developers/apps)
2. Click **Create app** > **Scoped access** > **App folder**
3. Name it (e.g., `openclaw-sync`)
4. In **Permissions** tab, enable:
   - `files.metadata.read` / `files.metadata.write`
   - `files.content.read` / `files.content.write`
5. Copy **App key** and **App secret** from Settings

Benefits:
- Token only accesses one folder, not your entire Dropbox
- If token is compromised, blast radius is limited
- Clean separation — sync folder lives under `Apps/`

## Troubleshooting

### Token expired

```bash
openclaw workspace authorize
```

### Conflicts

Files modified on both sides get `.conflict` suffix:

```bash
find <workspace>/shared -name "*.conflict"
```

### First sync fails

```bash
openclaw workspace sync --resync
```

### Permission errors

```bash
chmod -R 755 <workspace>/shared
```

## Security notes

- **Token storage**: rclone tokens are stored in `rclone.conf` with `0600` permissions
- **Sensitive files**: Don't sync secrets, API keys, or credentials
- **Encryption**: Consider [rclone crypt](https://rclone.org/crypt/) for sensitive data
- **App folder**: Use Dropbox app folder access for minimal permissions

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Type check
npx tsc --noEmit
```

## License

MIT
