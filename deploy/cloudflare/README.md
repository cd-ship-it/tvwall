# Cloudflare Tunnel + Access (TV Wall)

Expose `/control` to trusted people on any browser **without** opening router ports.
The physical kiosk keeps using `http://127.0.0.1:3000/` (see `deploy/kiosk/start-chrome.sh`).

```
Operator browser → Cloudflare Access → cloudflared (Mini) → Express :3000
```

## Prerequisites checklist

- [ ] Cloudflare account
- [ ] A domain added to Cloudflare (nameservers at Cloudflare). Free plan is enough.
- [ ] Express running on the Mini (`pm2` / `deploy/kiosk`) on port 3000
- [ ] Brew available on the Mini (or install cloudflared another way)

Confirm locally:

```bash
./deploy/cloudflare/check-prereqs.sh
```

If you do not have a domain yet: register one → Cloudflare Dashboard → **Add a site** → point nameservers → wait until active → continue.

## Step 1 — Create a Tunnel (dashboard)

1. Open [Cloudflare Zero Trust](https://one.dash.cloudflare.com/)
2. **Networks → Tunnels → Create a tunnel**
3. Connector: **Cloudflared**
4. Name: e.g. `tvwall-milpitas`
5. Copy the **tunnel token** (long string). Leave the tab open.

## Step 2 — Install cloudflared on the Mac Mini

On the Mini (as an admin user):

```bash
cd /path/to/TVWall
./deploy/cloudflare/install-tunnel.sh '<TUNNEL_TOKEN>'
```

This installs `cloudflared` via Homebrew (if needed) and registers the macOS service so the tunnel survives reboot.

Check:

```bash
./deploy/cloudflare/status.sh
```

## Step 3 — Public hostname → localhost

In the tunnel → **Public Hostname** → Add:

| Field | Value |
|--------|--------|
| Subdomain | `tvwall` (or `tvwall-milpitas`) |
| Domain | your Cloudflare zone |
| Path | *(empty)* |
| Type | HTTP |
| URL | `http://127.0.0.1:3000` |

Save. Cloudflare creates DNS automatically.

Smoke test (before Access): open `https://tvwall.YOURDOMAIN/` — you should see the wall page.

Record the hostname for later verify:

```bash
# on the Mini, optional helper file (gitignored if you put secrets elsewhere)
echo 'tvwall.YOURDOMAIN' > deploy/cloudflare/hostname.txt
```

## Step 4 — Cloudflare Access

1. Zero Trust → **Access → Applications → Add application → Self-hosted**
2. Name: `TV Wall Control`
3. Session duration: e.g. 24 hours
4. Application domain: `tvwall.YOURDOMAIN` (same hostname as Step 3)
5. Policy **Allow staff**:
   - Action: **Allow**
   - Include: **Emails** — your address + trusted staff
6. Identity: enable **One-time PIN** (email). Optionally add Google.
7. Save.

Visit `https://tvwall.YOURDOMAIN/control` in a private window:
Cloudflare login → then app basic auth.

See [ACCESS_POLICY.md](./ACCESS_POLICY.md) for exact policy notes and revoke steps.

## Step 5 — Harden app auth

On the Mini `.env`:

```
CONTROL_USER=admin
CONTROL_PASSWORD=<long random password>
```

Then restart the app (`pm2 restart tvwall`). Keep basic auth even with Access.

Kiosk Chrome must stay on **localhost** — never point `start-chrome.sh` at the Cloudflare URL.

## Step 6 — Add / remove people

- Add: edit the Access policy email list (or IdP group)
- Remove: delete their email from the policy
- They use any machine/browser; no Tailscale required for `/control`

## Step 7 — Reboot verify

```bash
./deploy/cloudflare/verify.sh tvwall.YOURDOMAIN
```

Or after reboot:

1. Express up on `:3000`
2. `./deploy/cloudflare/status.sh` shows tunnel healthy
3. From phone **off office Wi‑Fi**: open `https://tvwall.YOURDOMAIN/control`

## Uninstall

```bash
./deploy/cloudflare/uninstall-tunnel.sh
```

Also delete the tunnel + Access app in the Cloudflare dashboard if you are done with them.

## SSH / git pull

Cloudflare here is for **HTTP `/control` only**. Keep Tailscale (or on-site) for SSH.
