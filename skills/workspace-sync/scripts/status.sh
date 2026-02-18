#!/bin/sh
# workspace-sync: show sync status and health
set -e

STATE_DIR="${OPENCLAW_STATE_DIR:-${HOME}/.openclaw}"
RCLONE_CONF="${RCLONE_CONFIG:-${STATE_DIR}/rclone/rclone.conf}"
REMOTE_NAME="${WORKSPACE_SYNC_REMOTE:-cloud}"
REMOTE_PATH="${WORKSPACE_SYNC_REMOTE_PATH:-/}"
LOCAL_SUBDIR="${WORKSPACE_SYNC_LOCAL_PATH:-shared}"
WORKSPACE_DIR="${WORKSPACE_DIR:-$(pwd)}"

LOCAL_DIR="${WORKSPACE_DIR}/${LOCAL_SUBDIR}"
REMOTE="${REMOTE_NAME}:${REMOTE_PATH}"
EXCLUDES_FILE="${WORKSPACE_DIR}/.sync-excludes"
LASTRUN_FILE="${WORKSPACE_DIR}/.sync-lastrun"

log()  { printf '[workspace-sync] %s\n' "$1"; }
err()  { printf '[workspace-sync] ERROR: %s\n' "$1" >&2; }

printf '=== Workspace Sync Status ===\n\n'

# --- rclone binary ---

printf '## rclone\n'
if command -v rclone >/dev/null 2>&1; then
  RCLONE_PATH="$(command -v rclone)"
  RCLONE_VER="$(rclone --version 2>/dev/null | head -1 || echo 'unknown')"
  printf '  Binary:  %s\n' "$RCLONE_PATH"
  printf '  Version: %s\n' "$RCLONE_VER"
else
  printf '  Status: NOT INSTALLED\n'
  printf '  Fix:    Run setup.sh or install rclone manually\n'
fi

# --- rclone config ---

printf '\n## Configuration\n'
if [ -f "$RCLONE_CONF" ]; then
  printf '  Config:      %s\n' "$RCLONE_CONF"
  # Check if the remote is configured
  if RCLONE_CONFIG="$RCLONE_CONF" rclone listremotes 2>/dev/null | grep -q "^${REMOTE_NAME}:$"; then
    PROVIDER="$(RCLONE_CONFIG="$RCLONE_CONF" rclone config show "${REMOTE_NAME}" 2>/dev/null | grep '^type' | sed 's/type = //' || echo 'unknown')"
    printf '  Remote:      %s\n' "$REMOTE"
    printf '  Provider:    %s\n' "$PROVIDER"
  else
    printf '  Remote:      %s (NOT CONFIGURED)\n' "$REMOTE_NAME"
    printf '  Fix:         Run setup.sh\n'
  fi
else
  printf '  Config: NOT FOUND at %s\n' "$RCLONE_CONF"
  printf '  Fix:    Run setup.sh\n'
fi

# --- Local paths ---

printf '\n## Local\n'
printf '  Workspace:   %s\n' "$WORKSPACE_DIR"
printf '  Sync dir:    %s\n' "$LOCAL_DIR"
if [ -d "$LOCAL_DIR" ]; then
  FILE_COUNT="$(find "$LOCAL_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')"
  printf '  Files:       %s\n' "$FILE_COUNT"
else
  printf '  Sync dir:    DOES NOT EXIST (will be created on first sync)\n'
fi

if [ -f "$EXCLUDES_FILE" ]; then
  EXCLUDE_COUNT="$(grep -c -v '^$' "$EXCLUDES_FILE" 2>/dev/null || echo 0)"
  printf '  Excludes:    %s (%s rules)\n' "$EXCLUDES_FILE" "$EXCLUDE_COUNT"
else
  printf '  Excludes:    none (default rclone behavior)\n'
fi

# --- Last sync ---

printf '\n## Last Sync\n'
if [ -f "$LASTRUN_FILE" ]; then
  LAST_SYNC="$(cat "$LASTRUN_FILE")"
  printf '  Timestamp:   %s\n' "$LAST_SYNC"
else
  printf '  Status:      Never synced\n'
  printf '  Fix:         Run sync.sh --resync\n'
fi

# --- Connection health ---

printf '\n## Connection\n'
if [ -f "$RCLONE_CONF" ] && command -v rclone >/dev/null 2>&1; then
  if RCLONE_CONFIG="$RCLONE_CONF" rclone lsd "${REMOTE}/" >/dev/null 2>&1; then
    printf '  Health:      OK (remote reachable)\n'
  else
    printf '  Health:      FAILED (cannot reach remote)\n'
    printf '  Fix:         Check credentials or run: rclone config reconnect %s:\n' "$REMOTE_NAME"
  fi

  # Storage usage (best-effort, not all providers support this)
  ABOUT="$(RCLONE_CONFIG="$RCLONE_CONF" rclone about "${REMOTE_NAME}:" 2>/dev/null || true)"
  if [ -n "$ABOUT" ]; then
    printf '\n## Storage\n'
    printf '%s\n' "$ABOUT" | sed 's/^/  /'
  fi
else
  printf '  Health:      SKIPPED (rclone not configured)\n'
fi

printf '\n'
