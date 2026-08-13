#!/bin/bash
# Wait until the local TV Wall server answers, then exec Chrome in kiosk mode.
# launchd KeepAlive tracks this process: we exec Chrome so a crash relaunches us.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${PATH:-}"

if [[ -s "${HOME}/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  source "${HOME}/.nvm/nvm.sh"
fi

LOG_DIR="${HOME}/Library/Logs/TVWall"
mkdir -p "$LOG_DIR"
# Keep stdout/stderr for the wait loop; Chrome inherits after exec so we only
# tee the preamble. reopen log on each launchd restart.
exec >>"$LOG_DIR/chrome.log" 2>&1

echo "---- $(date '+%Y-%m-%d %H:%M:%S') start-chrome ----"

PORT=3000
if [[ -f "$ROOT/.env" ]]; then
  env_port="$(grep -E '^PORT=' "$ROOT/.env" | head -1 | cut -d= -f2- | tr -d '[:space:]' | tr -d '"' | tr -d "'")"
  if [[ -n "${env_port:-}" ]]; then
    PORT="$env_port"
  fi
fi

URL="http://127.0.0.1:${PORT}/"
MAX_WAIT_SEC="${TVWALL_CHROME_WAIT_SEC:-180}"

echo "root=$ROOT port=$PORT url=$URL max_wait=${MAX_WAIT_SEC}s"

CHROME="${TVWALL_CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
if [[ ! -x "$CHROME" ]]; then
  echo "error: Chrome not found at: $CHROME"
  exit 1
fi

# Dedicated profile avoids "Chrome didn't shut down correctly" restore bubbles
# and keeps kiosk cookies/permissions separate from any interactive profile.
USER_DATA_DIR="${HOME}/Library/Application Support/TVWallChrome"
mkdir -p "$USER_DATA_DIR"

ok=0
for ((i = 1; i <= MAX_WAIT_SEC; i++)); do
  if curl -sf -o /dev/null --connect-timeout 1 "$URL"; then
    echo "server ready after ${i}s"
    ok=1
    break
  fi
  sleep 1
done

if [[ "$ok" -ne 1 ]]; then
  echo "error: server not reachable at $URL after ${MAX_WAIT_SEC}s"
  exit 1
fi

# Drop any leftover Chrome from a previous partial boot so we don't stack windows.
# Only targets this kiosk profile's process tree via a clean relaunch.
pkill -f "TVWallChrome" >/dev/null 2>&1 || true
sleep 1

echo "launching Chrome kiosk -> $URL"
exec "$CHROME" \
  --user-data-dir="$USER_DATA_DIR" \
  --kiosk \
  --app="$URL" \
  --noerrdialogs \
  --disable-session-crashed-bubble \
  --disable-infobars \
  --disable-translate \
  --disable-features=TranslateUI \
  --check-for-update-interval=31536000 \
  --autoplay-policy=no-user-gesture-required \
  --no-first-run \
  --disable-pinch \
  --overscroll-history-navigation=0
