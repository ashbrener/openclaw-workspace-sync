# Troubleshooting & Maintenance

Common problems, recovery procedures, and maintenance tips for `openclaw-workspace-sync`.

## Quick diagnostics

```bash
# Check plugin status and remote connectivity
openclaw workspace-sync status

# See what a sync would do without changing anything
openclaw workspace-sync sync --dry-run

# Compare local and remote without making changes
rclone check <remote>:<path> /data/workspace/ --config <config-path>

# List remote contents
rclone ls <remote>:<path> --config <config-path> --max-depth 1
```

## Common problems

### Files deleted unexpectedly after enabling mailbox mode

**Cause:** Mailbox mode pushes local → cloud on every sync cycle. If local was empty or stale when you enabled it, the push made cloud match local — deleting cloud files that weren't present locally.

**Prevention:** Always align local with remote before enabling mailbox mode. See [Before your first sync](./README.md#before-your-first-sync).

**Recovery:**
1. Disable the plugin immediately (`"enabled": false` in `openclaw.json`, restart gateway)
2. Check your cloud provider's trash/version history (Dropbox keeps deleted files for 30 days)
3. Restore from cloud trash or a backup
4. Re-pull from cloud to align local:
   ```bash
   rclone sync <remote>:<path> /data/workspace/ --config <config-path> --verbose
   ```
5. Verify local matches remote, then re-enable the plugin

### Duplicate folders from case-sensitivity mismatch

**Cause:** macOS and Dropbox are case-insensitive (`code` = `CODE`), but Linux is case-sensitive. Renaming a folder on your Mac (e.g. `code` → `CODE`) propagates to Dropbox, but when rclone pulls to Linux, it may create both `code` and `CODE` as separate directories.

**Symptoms:** You see `code`, `CODE`, and/or intermediate names like `code1` on the server.

**Fix:**
1. Check which folder has the most complete contents:
   ```bash
   ls /data/workspace/code/ | wc -l
   ls /data/workspace/CODE/ | wc -l
   ```
2. Keep the most complete one, delete the others:
   ```bash
   rm -rf /data/workspace/CODE /data/workspace/code1
   ```
3. Re-pull from cloud to fill in anything missing:
   ```bash
   rclone sync <remote>:<path> /data/workspace/ --config <config-path> --verbose
   ```

**Prevention:** Avoid renaming top-level folders on macOS when syncing to a Linux server via Dropbox. If you need uppercase names, rename on the server side and let it sync down.

### "directory not found" errors during sync

**Cause:** Ghost directory entries on the cloud provider — the directory name exists but the contents are gone. Common after case-sensitivity renames or interrupted uploads.

**Impact:** Harmless. rclone skips these entries and continues. Your sync still works.

**Fix:** If the errors bother you, clean up the ghost entries via your cloud provider's web UI (e.g. dropbox.com). You can also run `rclone check` to confirm actual files are in sync despite the errors.

### Sync interrupted / incomplete

**Cause:** Network timeout, process killed, SSH disconnection, container restart.

**Impact:** The sync was partial — some files were transferred, others weren't. No data corruption, but local and remote may be out of sync.

**Fix:** Re-run the sync. rclone is idempotent — it only transfers files that differ:
```bash
rclone sync <remote>:<path> /data/workspace/ --config <config-path> --verbose
```

**Tip:** For long syncs over SSH, use `tmux` or `screen` so the sync survives disconnections:
```bash
tmux new -s sync
rclone sync <remote>:<path> /data/workspace/ --config <config-path> --verbose
# Ctrl+B, D to detach; tmux attach -t sync to reconnect
```

### "directory not found" with Dropbox app folder

**Cause:** Your `remotePath` is set to the app folder name (e.g. `"openclaw-sync"`) instead of `""`. With Dropbox app folders, the app folder IS the root — rclone sees it as `/`.

**Fix:** Set `"remotePath": ""` in your config.

### OAuth token expired

**Cause:** Dropbox tokens expire if unused for 90+ days or if the app's permissions change.

**Symptoms:** Sync fails with 401/403 errors or "token expired" messages.

**Fix:**
```bash
openclaw workspace-sync setup
# Re-run OAuth authorization step
```

Or manually re-authorize rclone:
```bash
rclone config reconnect <remote>: --config <config-path>
```

## Switching modes

Changing sync mode requires care. Follow this procedure:

1. **Disable periodic sync** — set `"enabled": false` or remove `interval` from config, restart gateway
2. **Align local and remote** — run `rclone check` to verify, or pull/push to align
3. **Change the mode** in `openclaw.json`
4. **Run a dry-run** — `openclaw workspace-sync sync --dry-run` to verify behavior
5. **Run the first sync** under the new mode
6. **Re-enable periodic sync**

### Switching to `mailbox` from `mirror` or `bisync`

Mirror pulls from cloud; mailbox pushes to cloud. Before switching:
- Ensure local is up to date (run one last mirror pull)
- Then switch to mailbox — the first push should be a no-op if both sides match

### Switching to `mirror` from `mailbox` or `bisync`

Safe — mirror only pulls. Just switch the mode. The first sync downloads the workspace.

### Switching to `bisync` from another mode

Requires `--resync` to establish the baseline. Verify both sides are aligned first.

## Maintenance

### Periodic health checks

```bash
# Compare local and remote (no changes)
rclone check <remote>:<path> /data/workspace/ --config <config-path>

# Check disk usage
du -sh /data/workspace/

# Check rclone version
rclone version
```

### Backup recommendations

- **Container platforms (Fly.io, Railway):** Use a separate persistent volume for the workspace. Volumes can be snapshotted for backup.
- **VPS:** Schedule daily backups of the workspace directory (cron + tar, or your provider's snapshot feature).
- **Cloud provider:** Most providers (Dropbox, Google Drive, OneDrive) have built-in version history and trash. Verify these are enabled.

### Keeping excludes clean

Large or frequently-changing directories waste sync bandwidth. Review your `exclude` patterns periodically:

```json
"exclude": [
  "**/.DS_Store",
  "**/.git/**",
  "**/__pycache__/**",
  "**/.venv/**",
  "**/venv/**",
  "**/node_modules/**",
  "*.log",
  "DUPLICATES/**"
]
```

Common additions:
- `"**/dist/**"` — build output
- `"**/.cache/**"` — tool caches
- `"**/tmp/**"` — temporary files
- `"**/*.pyc"` — compiled Python

### Updating the plugin

```bash
openclaw plugins install openclaw-workspace-sync
# or
cd ~/.openclaw/extensions/workspace-sync && git pull && npm install --omit=dev
```

After updating, restart the gateway to pick up the new version.

## Emergency: stop all syncing

If something is going wrong and you need to stop immediately:

1. **Disable the plugin:**
   ```json
   "openclaw-workspace-sync": {
     "enabled": false
   }
   ```
2. **Restart the gateway**
3. **Assess the damage** — compare local and remote with `rclone check`
4. **Recover** — use cloud provider trash/version history if needed
5. **Fix the root cause** before re-enabling
