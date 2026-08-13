#!/bin/bash
# Remove TV Wall kiosk LaunchAgents installed by install.sh.
set -euo pipefail

AGENTS="${HOME}/Library/LaunchAgents"
SERVER_PLIST="$AGENTS/org.tvwall.server.plist"
CHROME_PLIST="$AGENTS/org.tvwall.chrome.plist"
uid="$(id -u)"

launchctl bootout "gui/${uid}/org.tvwall.chrome" 2>/dev/null || true
launchctl bootout "gui/${uid}/org.tvwall.server" 2>/dev/null || true
launchctl unload "$CHROME_PLIST" 2>/dev/null || true
launchctl unload "$SERVER_PLIST" 2>/dev/null || true

rm -f "$SERVER_PLIST" "$CHROME_PLIST"

echo "Removed org.tvwall.server and org.tvwall.chrome LaunchAgents."
echo "pm2 process (if any) was left running; stop with: pm2 delete tvwall && pm2 save"
