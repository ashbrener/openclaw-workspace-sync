#!/bin/sh
# workspace-sync: run a sync operation
# Usage: sync.sh [--direction bisync|push|pull] [--dry-run] [--resync] [--path DIR] [--verbose]
set -e

STATE_DIR="${OPENCLAW_STATE_DIR:-${HOME}/.openclaw}"
RCLONE_CONF="${RCLONE_CONFIG:-${STATE_DIR}/rclone/rclone.conf}"
REMOTE_NAME="${WORKSPACE_SYNC_REMOTE:-cloud}"
REMOTE_PATH="${WORKSPACE_SYNC_REMOTE_PATH:-/}"
LOCAL_SUBDIR="${WORKSPACE_SYNC_LOCAL_PATH:-shared}"
WORKSPACE_DIR="${WORKSPACE_DIR:-$(pwd)}"

DIRECTION="bisync"
DRY_RUN=""
RESYNC=""
VERBOSE=""
CUSTOM_PATH=""

log()  { printf '[workspace-sync] %s\n' "$1"; }
err()  { printf '[workspace-sync] ERROR: %s\n' "$1" >&2; }

# --- Parse arguments ---

while [ $# -gt 0 ]; do
  case "$1" in
    --direction)  DIRECTION="$2"; shift 2 ;;
    --dry-run)    DRY_RUN="--dry-run"; shift ;;
    --resync)     RESYNC="--resync"; shift ;;
    --path)       CUSTOM_PATH="$2"; shift 2 ;;
    --verbose)    VERBOSE="--verbose"; shift ;;
    -h|--help)
      printf 'Usage: sync.sh [--direction bisync|push|pull] [--dry-run] [--resync] [--path DIR] [--verbose]\n'
      exit 0
      ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
done

# Resolve paths
LOCAL_DIR="${WORKSPACE_DIR}/${CUSTOM_PATH:-$LOCAL_SUBDIR}"
REMOTE="${REMOTE_NAME}:${REMOTE_PATH}"
EXCLUDES_FILE="${WORKSPACE_DIR}/.sync-excludes"
LASTRUN_FILE="${WORKSPACE_DIR}/.sync-lastrun"

# Validate
if ! command -v rclone >/dev/null 2>&1; then
  err "rclone not found. Run setup.sh first."
  exit 1
fi

if [ ! -f "$RCLONE_CONF" ]; then
  err "rclone config not found at ${RCLONE_CONF}. Run setup.sh first."
  exit 1
fi

# Ensure local directory exists
mkdir -p "$LOCAL_DIR"

# Build exclude flags
EXCLUDE_FLAGS=""
if [ -f "$EXCLUDES_FILE" ]; then
  EXCLUDE_FLAGS="--exclude-from ${EXCLUDES_FILE}"
fi

# --- Run sync ---

log "Direction: ${DIRECTION}"
log "Local:     ${LOCAL_DIR}"
log "Remote:    ${REMOTE}"
[ -n "$DRY_RUN" ] && log "Mode: DRY RUN (no changes)"
[ -n "$RESYNC" ]  && log "Mode: RESYNC (full baseline)"

RCLONE_COMMON="--config ${RCLONE_CONF} ${EXCLUDE_FLAGS} ${DRY_RUN} ${VERBOSE}"

case "$DIRECTION" in
  bisync)
    # Bisync: bidirectional sync
    # shellcheck disable=SC2086
    rclone bisync "$LOCAL_DIR" "$REMOTE" \
      $RCLONE_COMMON \
      $RESYNC \
      --remove-empty-dirs \
      --check-access=false \
      --no-check-dest \
      2>&1
    ;;
  push)
    # Push: local -> remote (one-way)
    # shellcheck disable=SC2086
    rclone sync "$LOCAL_DIR" "$REMOTE" \
      $RCLONE_COMMON \
      --remove-empty-dirs \
      2>&1
    ;;
  pull)
    # Pull: remote -> local (one-way)
    # shellcheck disable=SC2086
    rclone sync "$REMOTE" "$LOCAL_DIR" \
      $RCLONE_COMMON \
      --remove-empty-dirs \
      2>&1
    ;;
  *)
    err "Invalid direction: ${DIRECTION}. Use bisync, push, or pull."
    exit 1
    ;;
esac

EXIT_CODE=$?

# Record last run timestamp
if [ -z "$DRY_RUN" ] && [ "$EXIT_CODE" -eq 0 ]; then
  date -u '+%Y-%m-%dT%H:%M:%SZ' > "$LASTRUN_FILE"
fi

if [ "$EXIT_CODE" -eq 0 ]; then
  log "Sync complete."
else
  err "Sync finished with errors (exit code ${EXIT_CODE})."
fi

exit "$EXIT_CODE"
