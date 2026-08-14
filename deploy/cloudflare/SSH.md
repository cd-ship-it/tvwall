# SSH to the Mac Mini over Cloudflare

Single admin (you), so client-side `cloudflared` is fine and there's no need for
Tailscale. SSH rides the same tunnel that serves `/control`.

```
your Mac → cloudflared access ssh → Cloudflare Access → cloudflared (Mini) → sshd :22
```

## On the Mac Mini (one time)

1. Enable SSH: System Settings → General → **Sharing** → **Remote Login** on.
   Restrict it to your admin user, not "All users".
2. Add your public key to `~/.ssh/authorized_keys` so logins don't need a password.
3. Confirm the connector is installed (`deploy/cloudflare/install-tunnel.sh`).

## Dashboard (one time)

**Add the SSH route** — on the tunnel → Routes → **Add route** → Published application:

| Field | Value |
|---|---|
| Subdomain | `ssh-tvwall` |
| Domain | `xpch.cc` |
| Service | **SSH** |
| URL | `localhost:22` |

**Protect it with Access** — Access controls → Applications → Add an application →
**Public DNS**, domain `ssh-tvwall.xpch.cc`, attach the same `Allow staff` policy
(see [ACCESS_POLICY.md](./ACCESS_POLICY.md)). Never leave this hostname unprotected:
without a policy it is an SSH endpoint exposed to the internet.

## On your laptop (each client machine)

```bash
brew install cloudflared
```

Add to `~/.ssh/config`:

```
Host ssh-tvwall.xpch.cc
  User <your-mini-username>
  ProxyCommand /opt/homebrew/bin/cloudflared access ssh --hostname %h
```

Check the binary path with `brew --prefix cloudflared` if it differs (Intel Homebrew
uses `/usr/local/bin`).

Then:

```bash
ssh ssh-tvwall.xpch.cc
```

The first connection opens a browser for the Access login (email one-time PIN); the
token is cached under `~/.cloudflared/` until the app's session duration expires.

## Day-to-day deploys

```bash
ssh ssh-tvwall.xpch.cc
cd ~/TVWall
git pull
pm2 restart tvwall     # or click Restart Server on /control
```

Frontend-only changes need no SSH at all — use **Refresh Display** on `/control`.

## Notes

- SSH is streamed over a WebSocket, so very long idle sessions can drop. Reconnect,
  or use `ServerAliveInterval 30` in `~/.ssh/config` to keep it warm.
- If `ssh` hangs with no browser prompt, run
  `cloudflared access login https://ssh-tvwall.xpch.cc` once to refresh the token.
- Locked out (tunnel down, Access misconfigured)? You need physical access or a
  local-network SSH to the Mini's LAN address, so keep that path known.
