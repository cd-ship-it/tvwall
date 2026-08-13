#!/bin/bash
# Check local readiness for Cloudflare Tunnel (domain is a manual dashboard step).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${PATH:-}"

PORT=3000
if [[ -f "$ROOT/.env" ]]; then
  env_port="$(grep -E '^PORT=' "$ROOT/.env" | head -1 | cut -d= -f2- | tr -d '[:space:]' | tr -d '"' | tr -d "'")"
  if [[ -n "${env_port:-}" ]]; then
    PORT="$env_port"
  fi
fi

echo "=== TV Wall Cloudflare prereqs ==="
echo "repo: $ROOT"
echo

ok=1

echo -n "Express on 127.0.0.1:${PORT} ... "
if curl -sf -o /dev/null --connect-timeout 2 "http://127.0.0.1:${PORT}/"; then
  echo "OK"
else
  echo "MISSING (start with pm2 / npm start / deploy/kiosk)"
  ok=0
fi

echo -n "CONTROL_PASSWORD not default ... "
if [[ -f "$ROOT/.env" ]] && grep -qE '^CONTROL_PASSWORD=changeme[[:space:]]*$' "$ROOT/.env"; then
  echo "FAIL (still changeme — change before exposing via Cloudflare)"
  ok=0
elif [[ -f "$ROOT/.env" ]] && grep -qE '^CONTROL_PASSWORD=.' "$ROOT/.env"; then
  echo "OK (set in .env)"
else
  echo "WARN (no .env CONTROL_PASSWORD found)"
  ok=0
fi

echo -n "Homebrew ... "
if command -v brew >/dev/null 2>&1; then
  echo "OK ($(command -v brew))"
else
  echo "MISSING (install from https://brew.sh or install cloudflared manually)"
  ok=0
fi

echo -n "cloudflared ... "
if command -v cloudflared >/dev/null 2>&1; then
  echo "OK ($(cloudflared --version 2>&1 | head -1))"
else
  echo "not installed yet (install-tunnel.sh will install it)"
fi

echo
echo "Dashboard (manual):"
echo "  1. Domain must be added to Cloudflare with NS pointed at Cloudflare"
echo "  2. Zero Trust → Networks → Tunnels → Create tunnel → copy token"
echo "  3. Run: ./deploy/cloudflare/install-tunnel.sh '<TUNNEL_TOKEN>'"
echo "  4. Follow README.md Steps 3–4 (public hostname + Access)"
echo

if [[ "$ok" -eq 1 ]]; then
  echo "Local prereqs: READY"
  exit 0
fi
echo "Local prereqs: FIX ITEMS ABOVE"
exit 1
