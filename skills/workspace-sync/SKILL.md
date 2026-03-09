---
name: workspace-sync
description: Sync agent workspace with cloud storage (Dropbox, Google Drive, S3, etc.) using rclone.
metadata: {"openclaw":{"emoji":"☁️","requires":{"bins":["rclone"]}}}
---

# workspace-sync

Sync the agent workspace with cloud storage. `mode` is required — choose `mailbox` (inbox/outbox, safest), `mirror` (remote->local), or `bisync` (bidirectional, advanced).

## Trigger

Use this skill when the user asks to:
- Sync workspace to/from cloud
- Back up workspace files
- Check sync status
- Fix sync issues
- Send files to the agent workspace

## Sync modes

| Mode | Direction | Description |
|------|-----------|-------------|
| `mailbox` (recommended) | Push + inbox/outbox | Workspace pushes to cloud; `_outbox` sends files up to the agent's `_inbox`. Safest. |
| `mirror` | Remote → Local | One-way: workspace mirrors down. Safe — local can never overwrite remote. |
| `bisync` | Bidirectional | Two-way sync. Powerful but requires careful setup. |

### Mailbox mode

Each sync cycle: (1) pushes workspace to cloud excluding `_inbox/` and `_outbox/`, (2) drains cloud `_outbox/` into workspace `_inbox/` via `rclone move` (deletes from cloud after transfer). On startup, bootstraps `cloud:_outbox` and local `_inbox/`.

Users drop files in the local `_outbox/` folder (created by the cloud provider's desktop app). Files arrive in the agent's `_inbox/`. The agent or a skill processes them from there.

With `notifyOnInbox: true`, the agent is woken when files land in `_inbox`. A system event lists the new filenames so the agent can process them. Off by default — each notification costs an agent turn.

### Mirror mode with ingest

With `ingest: true`, a local `inbox/` folder syncs one-way **up** to the remote workspace (additive only). For a more robust pattern, use `mailbox` mode instead.

## Commands

### Check sync status
```bash
openclaw workspace-sync status
```

Shows: provider, mode, last sync time, sync count, error count, running state.

### Trigger manual sync
```bash
openclaw workspace-sync sync
```

In `mailbox` mode: pushes workspace and drains `_outbox`. In `mirror` mode: pulls latest from remote. In `bisync` mode: runs bidirectional sync.

### Preview changes
```bash
openclaw workspace-sync sync --dry-run
```

### One-way sync (explicit direction)
```bash
openclaw workspace-sync sync --direction pull   # remote -> local
openclaw workspace-sync sync --direction push   # local -> remote
```

### Force re-establish bisync baseline (destructive)
```bash
openclaw workspace-sync sync --resync
```

**WARNING: `--resync` is destructive (bisync only).** It copies ALL files from both sides to make them identical — deleted files come back, and it transfers everything. Only use when you explicitly need to re-establish the bisync baseline. The plugin never auto-resyncs.

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
          "mode": "mailbox",
          "remotePath": "",
          "localPath": "/",
          "interval": 60,
          "timeout": 1800,
          "onSessionStart": true,
          "onSessionEnd": true,
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
| `mode` | **required** | `mailbox` (inbox/outbox, safest), `mirror` (remote->local), or `bisync` (bidirectional) |
| `ingest` | `false` | Enable local inbox for sending files to the agent (mirror mode only) |
| `ingestPath` | `"inbox"` | Local subfolder name for ingestion |
| `notifyOnInbox` | `false` | Wake the agent when files arrive in `_inbox` (mailbox mode). Costs credits per notification. |
| `remotePath` | `"openclaw-share"` | Folder name in cloud storage |
| `localPath` | `"shared"` | Subfolder within workspace to sync |
| `interval` | `0` | Background sync interval in seconds (0 = manual only, min 60) |
| `timeout` | `1800` | Max seconds for a single sync operation (min 60) |
| `onSessionStart` | `false` | Sync when an agent session begins |
| `onSessionEnd` | `false` | Sync when an agent session ends |
| `conflictResolve` | `"newer"` | `newer`, `local`, or `remote` (bisync only) |
| `exclude` | `**/.DS_Store` | Glob patterns to exclude from sync |

## Automatic sync

When configured, sync runs automatically:
- **On session start**: Pushes workspace and drains outbox (mailbox), pulls latest (mirror), or runs bisync
- **On session end**: Syncs changes after conversation ends
- **Periodic interval**: Background sync every N seconds (no LLM cost)

## Safety notes

- **Mailbox mode is the safest.** Workspace pushes to cloud; users send files via `_outbox`. Streams never overlap.
- **Mirror mode is safe by design.** Remote workspace is the authority. Local is a read-only copy.
- **Bisync requires careful setup.** Both sides must agree. If state is lost, `--resync` is needed and it copies everything.
- **On container platforms** (Fly.io, Railway), bisync state is ephemeral — use `mailbox` or `mirror` mode instead.
- **When changing config** (remotePath, localPath, mode), disable periodic sync first, verify, then re-enable.

## Auto-recovery

- **Stale lock files**: Detected and cleared before retrying (lock files older than 15 min are expired automatically)
- **Interrupted syncs**: Uses `--recover` and `--resilient` flags to resume after interruptions (bisync only)
- **Resync never automatic**: If bisync state is lost, the plugin logs a message but does NOT auto-resync

## Troubleshooting

### "rclone not configured"
Run the setup wizard:
```bash
openclaw workspace-sync setup
```

### "requires --resync" (bisync only)
Bisync state was lost. **Before running `--resync`, verify both sides are correct**:
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

- `mode` is **required** — set `mailbox` (inbox/outbox, safest), `mirror` (remote→local), or `bisync` (bidirectional)
- Mailbox mode bootstraps `_outbox` on cloud and `_inbox` on workspace at startup
- Bisync is available for power users who need bidirectional sync
- Ingest inbox (mirror mode only) is additive only — cannot delete remote files
- Only `**/.DS_Store` excluded by default — add your own excludes in config
- Sync operations run in background (no LLM tokens used)
- All rclone activity is logged at info level for visibility
