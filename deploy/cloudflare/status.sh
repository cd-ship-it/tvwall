#!/bin/bash
# Show cloudflared / tunnel status on this machine.
set -euo pipefail

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${PATH:-}"

echo "=== cloudflared ==="
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared: not installed"
  exit 1
fi

cloudflared --version 2>&1 | head -1
echo

echo "=== launchctl (system service) ==="
if sudo launchctl print system/com.cloudflare.cloudflared 2>/dev/null | head -n 40; then
  :
else
  echo "(service not loaded or no permission — try: sudo launchctl list | grep -i cloud)"
  sudo launchctl list 2>/dev/null | grep -i cloud || true
fi

echo
echo "=== recent unified log (cloudflared, last 5m) ==="
log show --predicate 'process == "cloudflared"' --last 5m --style compact 2>/dev/null | tail -n 30 || \
  echo "(log show unavailable; check Console.app for cloudflared)"
