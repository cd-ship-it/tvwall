#!/bin/bash
# Verify local app + optional public Cloudflare hostname after setup / reboot.
#
# Usage:
#   ./deploy/cloudflare/verify.sh
#   ./deploy/cloudflare/verify.sh tvwall.example.com
#   ./deploy/cloudflare/verify.sh   # reads deploy/cloudflare/hostname.txt if present
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${PATH:-}"

PORT=3000
if [[ -f "$ROOT/.env" ]]; then
  env_port="$(grep -E '^PORT=' "$ROOT/.env" | head -1 | cut -d= -f2- | tr -d '[:space:]' | tr -d '"' | tr -d "'")"
  if [[ -n "${env_port:-}" ]]; then
    PORT="$env_port"
  fi
fi

HOST="${1:-}"
if [[ -z "$HOST" && -f "$DIR/hostname.txt" ]]; then
  HOST="$(tr -d '[:space:]' <"$DIR/hostname.txt")"
fi

fail=0

echo "=== 1. Local Express ==="
if curl -sf -o /dev/null --connect-timeout 2 "http://127.0.0.1:${PORT}/"; then
  echo "OK  http://127.0.0.1:${PORT}/"
else
  echo "FAIL http://127.0.0.1:${PORT}/ not responding"
  fail=1
fi

echo
echo "=== 2. cloudflared service ==="
if command -v cloudflared >/dev/null 2>&1; then
  if sudo launchctl print system/com.cloudflare.cloudflared >/dev/null 2>&1; then
    echo "OK  com.cloudflare.cloudflared loaded"
  else
    echo "FAIL cloudflared service not loaded (run install-tunnel.sh)"
    fail=1
  fi
else
  echo "FAIL cloudflared not installed"
  fail=1
fi

echo
echo "=== 3. Kiosk must use localhost (not Cloudflare URL) ==="
if grep -q '127.0.0.1' "$ROOT/deploy/kiosk/start-chrome.sh"; then
  echo "OK  deploy/kiosk/start-chrome.sh targets 127.0.0.1"
else
  echo "FAIL start-chrome.sh does not appear to use 127.0.0.1"
  fail=1
fi

echo
echo "=== 4. Public hostname ==="
if [[ -z "$HOST" ]]; then
  echo "SKIP (pass hostname or write deploy/cloudflare/hostname.txt)"
  echo "     example: $0 tvwall.example.com"
else
  HOST="${HOST#https://}"
  HOST="${HOST%%/*}"
  # Access may return 302 to login; basic auth may return 401 — all mean edge is up.
  for path in "/" "/control"; do
    url="https://${HOST}${path}"
    echo "GET $url"
    code="$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 10 "$url" || echo "000")"
    case "$code" in
      200|301|302|303|307|308|401|403)
        echo "OK  HTTP $code"
        ;;
      *)
        echo "FAIL unexpected HTTP $code from $url"
        fail=1
        ;;
    esac
  done
fi

echo
if [[ "$fail" -eq 0 ]]; then
  echo "VERIFY PASSED"
  echo "Manual: from a phone off office Wi-Fi, open https://${HOST:-tvwall.YOURDOMAIN}/control"
  exit 0
fi
echo "VERIFY FAILED"
exit 1
