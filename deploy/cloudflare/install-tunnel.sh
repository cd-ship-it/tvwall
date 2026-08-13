#!/bin/bash
# Install cloudflared and register it as a macOS service with a Cloudflare tunnel token.
#
# Usage (on the Mac Mini):
#   ./deploy/cloudflare/install-tunnel.sh '<TUNNEL_TOKEN>'
#
# Get the token from: Zero Trust → Networks → Tunnels → Create / Configure → Install connector
set -euo pipefail

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${PATH:-}"

TOKEN="${1:-${CLOUDFLARE_TUNNEL_TOKEN:-}}"
if [[ -z "$TOKEN" ]]; then
  echo "usage: $0 '<TUNNEL_TOKEN>'"
  echo "   or: CLOUDFLARE_TUNNEL_TOKEN=... $0"
  exit 1
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: this installer targets macOS (Mac Mini kiosk)."
  exit 1
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "error: Homebrew not found. Install from https://brew.sh then re-run."
  exit 1
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "installing cloudflared via Homebrew..."
  brew install cloudflare/cloudflare/cloudflared
else
  echo "cloudflared already present: $(command -v cloudflared)"
fi

echo "cloudflared version: $(cloudflared --version 2>&1 | head -1)"

# Remove a previous service quietly so re-install with a new token works.
if cloudflared service uninstall >/dev/null 2>&1; then
  echo "removed previous cloudflared service"
fi
# Older installs used launchctl labels; ignore failures.
sudo launchctl bootout system/com.cloudflare.cloudflared 2>/dev/null || true

echo "installing cloudflared service with tunnel token..."
sudo cloudflared service install "$TOKEN"

echo
echo "Installed. Next:"
echo "  1. In the tunnel dashboard → Public Hostname → HTTP → http://127.0.0.1:3000"
echo "  2. Add Cloudflare Access (see deploy/cloudflare/ACCESS_POLICY.md)"
echo "  3. ./deploy/cloudflare/status.sh"
echo "  4. ./deploy/cloudflare/verify.sh tvwall.YOURDOMAIN"
