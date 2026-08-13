#!/bin/bash
# Print a strong CONTROL_PASSWORD candidate for .env (does not modify files).
set -euo pipefail

pw="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)"
echo "Add to .env (then: pm2 restart tvwall):"
echo "CONTROL_PASSWORD=${pw}"
