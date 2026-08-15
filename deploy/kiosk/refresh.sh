#!/bin/bash
# Clean refresh of the TV Wall on the Mac Mini: pull latest code, install
# deps, restart the Express server (pm2), restart Chrome kiosk.
#
# Run over SSH as the auto-login user (same user that owns the LaunchAgents):
#   ssh ssh-tvwall.xpch.cc '~/TVWall/deploy/kiosk/refresh.sh'
#
# Prints to the terminal (not just the LaunchAgent logs) so you can watch it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${PATH:-}"
# Don't hang on a git credential prompt over SSH.
export GIT_TERMINAL_PROMPT=0

if [[ -s "${HOME}/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  source "${HOME}/.nvm/nvm.sh"
fi

step() {
  echo
  echo "==== $* ===="
}

die() {
  echo "error: $*" >&2
  exit 1
}

PORT=3000
if [[ -f "$ROOT/.env" ]]; then
  env_port="$(grep -E '^PORT=' "$ROOT/.env" | head -1 | cut -d= -f2- | tr -d '[:space:]' | tr -d '"' | tr -d "'")"
  if [[ -n "${env_port:-}" ]]; then
    PORT="$env_port"
  fi
fi
URL="http://127.0.0.1:${PORT}/"

wait_for_server() {
  local max="${1:-60}"
  local i
  for ((i = 1; i <= max; i++)); do
    if curl -sf -o /dev/null --connect-timeout 1 "$URL"; then
      echo "server ready at $URL after ${i}s"
      return 0
    fi
    sleep 1
  done
  die "server not reachable at $URL after ${max}s"
}

echo "TV Wall refresh  $(date '+%Y-%m-%d %H:%M:%S')"
echo "root=$ROOT"
echo "node=$(command -v node || echo MISSING)  $({ node -v; } 2>/dev/null || true)"
echo "pm2=$(command -v pm2 || echo MISSING)"
echo "npm=$(command -v npm || echo MISSING)"

command -v git >/dev/null 2>&1 || die "git not found"
command -v npm >/dev/null 2>&1 || die "npm not found"
command -v pm2 >/dev/null 2>&1 || die "pm2 not found (npm install -g pm2)"
command -v node >/dev/null 2>&1 || die "node not found"

# ---- match GitHub (discard local edits to tracked files) -------------------
step "git fetch + reset to GitHub"

if ! upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)"; then
  die "this branch has no upstream (git branch -u origin/<branch>)"
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "discarding local changes to tracked files (GitHub wins):"
  git status --short --untracked-files=no
fi

before="$(git rev-parse --short HEAD)"
git fetch --prune
git reset --hard "$upstream"
after="$(git rev-parse --short HEAD)"
echo "HEAD $before -> $after  ($(git log -1 --pretty=format:'%s'))"
echo "untracked / gitignored files (.env, wall-config.json, media, credentials) left alone"

# ---- install deps (no compile step in this repo) ---------------------------
step "npm install"
npm install

# ---- restart server --------------------------------------------------------
step "restart server (pm2 tvwall)"
if pm2 describe tvwall >/dev/null 2>&1; then
  pm2 restart tvwall
else
  echo "tvwall is not registered in pm2; starting it"
  "$ROOT/deploy/kiosk/start-server.sh"
fi
wait_for_server 60
pm2 describe tvwall | head -n 16 || true

# ---- restart Chrome kiosk --------------------------------------------------
step "restart Chrome kiosk"
uid="$(id -u)"
label="gui/${uid}/org.tvwall.chrome"

# Prefer launchd so KeepAlive / the wait-for-server wrapper stay in charge.
# From SSH the gui domain is usually reachable as the same logged-in user;
# if kickstart fails, killing the dedicated kiosk profile lets KeepAlive relaunch.
if launchctl kickstart -k "$label" 2>/dev/null; then
  echo "kicked $label"
else
  echo "launchctl kickstart failed (common if this SSH user is not the GUI user)"
  echo "killing kiosk Chrome so LaunchAgent KeepAlive relaunches it"
  pkill -f "TVWallChrome" >/dev/null 2>&1 || true
fi

step "done"
echo "code:    $after"
echo "server:  $URL"
echo "chrome:  launchd $label (see ~/Library/Logs/TVWall/chrome.log)"
echo
echo "If the wall is still on the old page, give Chrome a few seconds to"
echo "come back — start-chrome.sh waits until $URL answers, then kiosks."
