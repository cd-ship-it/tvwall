#!/bin/bash
# Install LaunchAgents for TV Wall kiosk boot (server via pm2 + Chrome kiosk).
#
# Usage (on the Mac Mini, as the auto-login user):
#   cd /path/to/TVWall
#   ./deploy/kiosk/install.sh
#
# Prerequisites: Node, pm2 (`npm i -g pm2`), Google Chrome, repo configured (.env, credentials).
# First time only, after a manual `pm2 start` works: `pm2 save` so resurrect has a dump.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$ROOT/deploy/kiosk"
AGENTS="${HOME}/Library/LaunchAgents"
LOG_DIR="${HOME}/Library/Logs/TVWall"

mkdir -p "$AGENTS" "$LOG_DIR"
chmod +x "$DIR/start-server.sh" "$DIR/start-chrome.sh"

render() {
  local src="$1"
  local dest="$2"
  sed \
    -e "s|__TVWALL_HOME__|${ROOT}|g" \
    -e "s|__HOME__|${HOME}|g" \
    "$src" >"$dest"
}

SERVER_PLIST="$AGENTS/org.tvwall.server.plist"
CHROME_PLIST="$AGENTS/org.tvwall.chrome.plist"

# Unload existing agents if present (ignore errors on first install).
launchctl bootout "gui/$(id -u)/org.tvwall.server" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/org.tvwall.chrome" 2>/dev/null || true
# Older macOS / leftover labels:
launchctl unload "$SERVER_PLIST" 2>/dev/null || true
launchctl unload "$CHROME_PLIST" 2>/dev/null || true

render "$DIR/org.tvwall.server.plist.template" "$SERVER_PLIST"
render "$DIR/org.tvwall.chrome.plist.template" "$CHROME_PLIST"

# Prefer modern bootstrap; fall back to load for older macOS (2017 Mini may be older).
uid="$(id -u)"
if launchctl bootstrap "gui/${uid}" "$SERVER_PLIST" 2>/dev/null; then
  launchctl bootstrap "gui/${uid}" "$CHROME_PLIST"
  launchctl enable "gui/${uid}/org.tvwall.server" 2>/dev/null || true
  launchctl enable "gui/${uid}/org.tvwall.chrome" 2>/dev/null || true
else
  launchctl load "$SERVER_PLIST"
  launchctl load "$CHROME_PLIST"
fi

echo "Installed:"
echo "  $SERVER_PLIST"
echo "  $CHROME_PLIST"
echo
echo "Logs:"
echo "  $LOG_DIR/server.log"
echo "  $LOG_DIR/chrome.log"
echo "  $LOG_DIR/launchd-*.log"
echo
echo "Smoke-test without reboot:"
echo "  $DIR/start-server.sh"
echo "  # wait a moment, then:"
echo "  $DIR/start-chrome.sh"
echo
echo "Or kick the agents:"
echo "  launchctl kickstart -k gui/${uid}/org.tvwall.server"
echo "  launchctl kickstart -k gui/${uid}/org.tvwall.chrome"
