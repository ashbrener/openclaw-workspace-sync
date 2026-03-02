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

### Force re-establish baseline (destructive)
```bash
openclaw workspace-sync sync --resync
```

**WARNING: `--resync` is destructive.** It copies ALL files from both sides to make them identical — deleted files come back, and it transfers everything, not just changes. Only use when you explicitly need to re-establish the bisync baseline (e.g., after first install or after wiping one side). The plugin never auto-resyncs.

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

Default excludes: `**/.DS_Store` only. Add your own patterns for `.git`, `node_modules`, etc.

## Automatic sync

When configured, sync runs automatically:
- **On session start**: Before you start working (pulls latest from cloud)
- **On session end**: After conversation ends (pushes changes to cloud)
- **Periodic interval**: Background sync every N seconds (no LLM cost)

## Auto-recovery

The plugin automatically handles common rclone failures:
- **Stale lock files**: Detected and cleared before retrying (lock files older than 15 min are expired automatically)
- **Interrupted syncs**: Uses `--recover` and `--resilient` flags to resume after interruptions
- **Resync never automatic**: If bisync state is lost, the plugin logs a message but does NOT auto-resync. You must explicitly run `openclaw workspace-sync sync --resync` after confirming both sides are correct.

## Troubleshooting

### "rclone not configured"
Run the setup wizard:
```bash
openclaw workspace-sync setup
```

### "requires --resync"
Bisync state was lost. **Before running `--resync`, verify both sides are in the state you want** — resync copies everything from both sides to make them identical:
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
- Only `**/.DS_Store` excluded by default — add your own excludes in config
- Sync operations run in background (no LLM tokens used)
- All rclone activity is logged at info level for visibility
