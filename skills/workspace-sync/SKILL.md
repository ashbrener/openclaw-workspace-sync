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
openclaw workspace status
```

Shows: provider, last sync time, sync count, error count, running state.

### Trigger manual sync
```bash
openclaw workspace sync
```

Runs a bidirectional sync immediately. Use after bulk workspace changes.

### First-time sync (required once)
```bash
openclaw workspace sync --resync
```

Required on first run to establish baseline. Only needed once per remote.

### View remote files
```bash
openclaw workspace list
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
          "onSessionStart": true,
          "onSessionEnd": true
        }
      }
    }
  }
}
```

## Automatic sync

When configured, sync runs automatically:
- **On session start**: Before you start working (pulls latest from cloud)
- **On session end**: After conversation ends (pushes changes to cloud)
- **Periodic interval**: Background sync every N seconds (no LLM cost)

## Troubleshooting

### "rclone not configured"
Run the setup wizard:
```bash
openclaw workspace setup
```

### "requires --resync"
First sync needs to establish baseline:
```bash
openclaw workspace sync --resync
```

### Check rclone directly
```bash
rclone lsd cloud:/
rclone ls cloud:openclaw-share
```

## Notes

- Sync is bidirectional (changes flow both ways)
- Conflicts resolve by newest file (configurable)
- `.git/` and `node_modules/` excluded by default
- Sync operations run in background (no LLM tokens used)
