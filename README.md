# OpenClaw Workspace Cloud Sync Plugin

Bidirectional workspace sync between your OpenClaw agent and cloud storage via [rclone](https://rclone.org/).

Supports **Dropbox, Google Drive, OneDrive, S3/R2/Minio**, and [70+ cloud providers](https://rclone.org/overview/).

## How it works

```
Local Machine              Cloud Provider              Remote Gateway
~/Dropbox/openclaw/    <->    Dropbox/GDrive/etc    <->    <workspace>/shared/
   (native app)               (any provider)              (rclone bisync)
```

- **Local**: Native cloud app syncs `~/Dropbox/openclaw/` (or equivalent)
- **Remote**: rclone bisync keeps `<workspace>/shared/` in sync with the cloud
- **Result**: Drop a file locally, it appears on the remote Gateway (and vice versa)

**Zero LLM cost.** All sync operations are pure rclone file operations — they never wake the bot or trigger LLM calls.

## Install

```bash
openclaw plugins install @openclaw/workspace-sync
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
      "workspace-sync": {
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

| Provider | Config value | Auth method |
|----------|-------------|-------------|
| Dropbox | `dropbox` | OAuth token |
| Google Drive | `gdrive` | OAuth token |
| OneDrive | `onedrive` | OAuth token |
| S3/R2/Minio | `s3` | Access keys |
| Custom rclone | `custom` | Manual rclone config |

For the full list of 70+ providers, see [rclone overview](https://rclone.org/overview/).

## Manual setup (without wizard)

### 1. Install rclone

- **macOS**: `brew install rclone`
- **Linux**: `curl -s https://rclone.org/install.sh | sudo bash`
- **Docker**: `RUN curl -s https://rclone.org/install.sh | bash`

### 2. Authorize rclone (from your local machine)

Run on a machine with a browser:

```bash
rclone authorize "dropbox"   # or: gdrive, onedrive
```

Copy the JSON token it outputs.

### 3. Configure on the Gateway

```bash
mkdir -p ~/.openclaw/.config/rclone

cat > ~/.openclaw/.config/rclone/rclone.conf << 'EOF'
[cloud]
type = dropbox
token = {"access_token":"YOUR_TOKEN_HERE","token_type":"bearer","expiry":"..."}
EOF
```

### 4. First sync

```bash
openclaw workspace sync --resync
```

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
pnpm install

# Run tests
pnpm test

# Type check
pnpm tsgo --noEmit
```

## License

MIT
