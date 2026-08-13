#!/bin/bash
# Uninstall the cloudflared macOS service (does not delete the tunnel in the Cloudflare dashboard).
set -euo pipefail

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${PATH:-}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared not on PATH; nothing to uninstall."
  exit 0
fi

echo "uninstalling cloudflared service..."
sudo cloudflared service uninstall || true
sudo launchctl bootout system/com.cloudflare.cloudflared 2>/dev/null || true

echo "Done. Delete the tunnel + Access application in the Cloudflare dashboard if you no longer need them."
echo "Optional: brew uninstall cloudflared"
