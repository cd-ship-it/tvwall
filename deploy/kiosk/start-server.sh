#!/bin/bash
# Ensure the TV Wall Express server is running under pm2.
# Safe to run repeatedly (boot LaunchAgent + optional StartInterval watchdog).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# launchd PATH is minimal; cover Intel Homebrew, Apple Silicon Homebrew, and common locals.
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${PATH:-}"

# Optional nvm (common on manually provisioned Minis).
if [[ -s "${HOME}/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  source "${HOME}/.nvm/nvm.sh"
fi

LOG_DIR="${HOME}/Library/Logs/TVWall"
mkdir -p "$LOG_DIR"
exec >>"$LOG_DIR/server.log" 2>&1

echo "---- $(date '+%Y-%m-%d %H:%M:%S') start-server ----"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "error: pm2 not found on PATH=$PATH"
  echo "install with: npm install -g pm2"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: node not found on PATH=$PATH"
  exit 1
fi

echo "node=$(command -v node) ($(node -v))"
echo "pm2=$(command -v pm2)"
echo "root=$ROOT"

# After reboot the pm2 daemon is gone. Prefer resurrecting the last dump;
# fall back to a fresh start if nothing named tvwall is registered.
pm2 resurrect >/dev/null 2>&1 || true

if pm2 describe tvwall >/dev/null 2>&1; then
  # Already registered: bring it online if stopped/errored. No-op if online
  # (pm2 exits non-zero with "already online" - ignore that).
  if pm2 start tvwall >/dev/null 2>&1; then
    echo "started existing pm2 app tvwall"
  else
    echo "tvwall already online (or start returned non-zero; checking)"
  fi
else
  echo "starting new pm2 app tvwall"
  pm2 start "$ROOT/server/index.js" --name tvwall --cwd "$ROOT"
  pm2 save
fi

pm2 describe tvwall | head -n 20 || true
