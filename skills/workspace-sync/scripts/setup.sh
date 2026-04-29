#!/bin/sh
# workspace-sync setup wizard
# Checks rclone, selects provider, runs OAuth, creates excludes, tests connection.
set -e

STATE_DIR="${OPENCLAW_STATE_DIR:-${HOME}/.openclaw}"
RCLONE_CONF="${RCLONE_CONFIG:-${STATE_DIR}/rclone/rclone.conf}"
REMOTE_NAME="${WORKSPACE_SYNC_REMOTE:-cloud}"
WORKSPACE_DIR="${1:-$(pwd)}"
EXCLUDES_FILE="${WORKSPACE_DIR}/.sync-excludes"

log()  { printf '[workspace-sync] %s\n' "$1"; }
err()  { printf '[workspace-sync] ERROR: %s\n' "$1" >&2; }
ask()  { printf '%s ' "$1"; read -r REPLY; }

# --- Step 1: Check / install rclone ---

check_rclone() {
  if command -v rclone >/dev/null 2>&1; then
    log "rclone found: $(rclone version --check 2>/dev/null | head -1 || rclone --version 2>/dev/null | head -1)"
    return 0
  fi
  return 1
}

install_rclone() {
  # Only use OS package managers — never pipe a remote script to a shell.
  log "rclone not found. Attempting install via your OS package manager..."

  OS="$(uname -s)"
  if [ "$OS" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    log "Installing via Homebrew..."
    brew install rclone
  elif [ "$OS" = "Linux" ] && command -v apt-get >/dev/null 2>&1; then
    log "Installing via apt-get..."
    sudo apt-get update && sudo apt-get install -y rclone
  elif [ "$OS" = "Linux" ] && command -v dnf >/dev/null 2>&1; then
    log "Installing via dnf..."
    sudo dnf install -y rclone
  elif [ "$OS" = "Linux" ] && command -v yum >/dev/null 2>&1; then
    log "Installing via yum..."
    sudo yum install -y rclone
  elif [ "$OS" = "Linux" ] && command -v pacman >/dev/null 2>&1; then
    log "Installing via pacman..."
    sudo pacman -S --noconfirm rclone
  elif [ "$OS" = "Linux" ] && command -v apk >/dev/null 2>&1; then
    log "Installing via apk..."
    sudo apk add rclone
  else
    err "No supported package manager found."
    err "Please install rclone manually: https://rclone.org/install/"
    err "Then re-run this setup."
    exit 1
  fi

  if ! command -v rclone >/dev/null 2>&1; then
    err "rclone installation failed. Install manually: https://rclone.org/install/"
    exit 1
  fi
  log "rclone installed successfully."
}

if ! check_rclone; then
  printf '\n[workspace-sync] rclone is not installed.\n'
  printf '[workspace-sync] This script can install it via your OS package manager (brew/apt/dnf/yum/pacman/apk).\n'
  printf '[workspace-sync] We will NOT pipe any remote scripts to your shell.\n'
  printf '[workspace-sync] If you prefer to install manually: https://rclone.org/install/\n\n'
  ask "Install rclone via your OS package manager now? [Y/n]"
  case "$REPLY" in
    [nN]*) err "rclone is required. Install it manually and re-run setup."; exit 1 ;;
    *) install_rclone ;;
  esac
fi

# --- Step 2: Select provider ---

printf '\nSelect a cloud storage provider:\n'
printf '  1) Dropbox\n'
printf '  2) Google Drive\n'
printf '  3) Amazon S3 (or S3-compatible: R2, B2, MinIO)\n'
printf '  4) OneDrive\n'
printf '  5) Other (manual rclone config)\n'
ask "Choice [1-5]:"

case "$REPLY" in
  1) PROVIDER_TYPE="dropbox";   PROVIDER_LABEL="Dropbox" ;;
  2) PROVIDER_TYPE="drive";     PROVIDER_LABEL="Google Drive" ;;
  3) PROVIDER_TYPE="s3";        PROVIDER_LABEL="Amazon S3" ;;
  4) PROVIDER_TYPE="onedrive";  PROVIDER_LABEL="OneDrive" ;;
  5) PROVIDER_TYPE="";          PROVIDER_LABEL="Custom" ;;
  *) err "Invalid choice."; exit 1 ;;
esac

# --- Step 3: Run rclone config ---

mkdir -p "$(dirname "$RCLONE_CONF")"

log "Configuring ${PROVIDER_LABEL}..."
log "rclone config path: ${RCLONE_CONF}"

if [ -n "$PROVIDER_TYPE" ]; then
  RCLONE_CONFIG="$RCLONE_CONF" rclone config create "$REMOTE_NAME" "$PROVIDER_TYPE"
  log "Running authorization flow..."
  RCLONE_CONFIG="$RCLONE_CONF" rclone config reconnect "${REMOTE_NAME}:" 2>/dev/null || true
else
  log "Opening interactive rclone config..."
  RCLONE_CONFIG="$RCLONE_CONF" rclone config
fi

# --- Step 4: Create default excludes ---

if [ ! -f "$EXCLUDES_FILE" ]; then
  log "Creating default excludes at ${EXCLUDES_FILE}"
  cat > "$EXCLUDES_FILE" << 'EXCLUDES'
.git/**
node_modules/**
__pycache__/**
.venv/**
venv/**
*.log
.env*
.DS_Store
Thumbs.db
*.tmp
*.swp
*~
EXCLUDES
  log "Edit ${EXCLUDES_FILE} to customize which files are excluded from sync."
else
  log "Excludes file already exists: ${EXCLUDES_FILE}"
fi

# --- Step 5: Test connection ---

log "Testing connection to ${REMOTE_NAME}:..."

if RCLONE_CONFIG="$RCLONE_CONF" rclone lsd "${REMOTE_NAME}:/" >/dev/null 2>&1; then
  log "Connection successful."
  printf '\nRemote root contents:\n'
  RCLONE_CONFIG="$RCLONE_CONF" rclone lsd "${REMOTE_NAME}:/" 2>/dev/null || true
else
  err "Connection test failed. Run 'rclone config reconnect ${REMOTE_NAME}:' to re-authorize."
  exit 1
fi

# --- Done ---

printf '\n'
log "Setup complete."
log "Next steps:"
log "  1. Run first sync:  sh scripts/sync.sh --resync"
log "  2. Check status:    sh scripts/status.sh"
