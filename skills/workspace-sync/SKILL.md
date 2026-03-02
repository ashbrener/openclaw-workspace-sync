---
name: workspace-sync
description: Sync agent workspace with cloud storage (Dropbox, Google Drive, S3, etc.) using rclone.
metadata: {"openclaw":{"emoji":"☁️","requires":{"bins":["rclone"]}}}
---

# workspace-sync

Bidirectional sync between the agent workspace and cloud storage. Useful for backing up workspace files, sharing across devices, or restoring after migrations.

## Trigger

Use this skill when the user asks to:
- Sync workspace to/from cloud
- Back up workspace files
- Check sync status
- Fix sync issues

## Commands

### Check sync status
```bash
openclaw workspace-sync status
```

Shows: provider, last sync time, sync count, error count, running state.

### Trigger manual sync
```bash
openclaw workspace-sync sync
```

Runs a bidirectional sync immediately. Use after bulk workspace changes.

### First-time sync (required once)
```bash
openclaw workspace-sync sync --resync
```

Required on first run to establish baseline. Only needed once per remote.

### View remote files
```bash
openclaw workspace-sync list
```

Lists files in the configured cloud storage path.

## Configuration

Workspace sync is configured via the plugin entry in `openclaw.json`:

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
          "timeout": 1800,
          "onSessionStart": true,
          "onSessionEnd": true,
          "conflictResolve": "newer",
          "exclude": [".git/**", "node_modules/**", "*.log"]
        }
      }
    }
  }
}
```

### Config keys

| Key | Default | Description |
|-----|---------|-------------|
| `provider` | `"off"` | `dropbox`, `gdrive`, `onedrive`, `s3`, `custom`, or `off` |
| `remotePath` | `"openclaw-share"` | Folder name in cloud storage |
| `localPath` | `"shared"` | Subfolder within workspace to sync |
| `interval` | `0` | Background sync interval in seconds (0 = manual only, min 60) |
| `timeout` | `1800` | Max seconds for a single sync operation (min 60) |
| `onSessionStart` | `false` | Sync when an agent session begins |
| `onSessionEnd` | `false` | Sync when an agent session ends |
| `conflictResolve` | `"newer"` | `newer`, `local`, or `remote` |
| `exclude` | see below | Glob patterns to exclude from sync |

Default excludes: `.git/**`, `node_modules/**`, `.venv/**`, `__pycache__/**`, `*.log`, `.DS_Store`

## Automatic sync

When configured, sync runs automatically:
- **On session start**: Before you start working (pulls latest from cloud)
- **On session end**: After conversation ends (pushes changes to cloud)
- **Periodic interval**: Background sync every N seconds (no LLM cost)

## Auto-recovery

The plugin automatically handles common rclone failures:
- **Stale lock files**: Detected and cleared before retrying (lock files older than 15 min are expired automatically)
- **Resync required**: If bisync state is lost, automatically retries with `--resync`
- **Interrupted syncs**: Uses `--recover` and `--resilient` flags to resume after interruptions

## Troubleshooting

### "rclone not configured"
Run the setup wizard:
```bash
openclaw workspace-sync setup
```

### "requires --resync"
First sync needs to establish baseline:
```bash
openclaw workspace-sync sync --resync
```

### Sync times out
Increase the `timeout` in your config (default is 1800 seconds / 30 min):
```json
{ "timeout": 3600 }
```

### Check rclone directly
```bash
rclone lsd cloud:/
rclone ls cloud:openclaw-share
```

## Notes

- Sync is bidirectional (changes flow both ways)
- Conflicts resolve by newest file (configurable via `conflictResolve`)
- `.git/` and `node_modules/` excluded by default
- Sync operations run in background (no LLM tokens used)
- All rclone activity is logged at info level for visibility
