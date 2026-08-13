# Public hostname (Step 3)

In the Cloudflare tunnel → **Public Hostname** → Add:

| Field | Value |
|--------|--------|
| Subdomain | `tvwall` (or `tvwall-milpitas`) |
| Domain | your Cloudflare zone |
| Path | *(leave empty)* |
| Service type | HTTP |
| URL | `http://127.0.0.1:3000` |

Save. Cloudflare creates the DNS CNAME automatically.

Then on the Mini:

```bash
echo 'tvwall.YOURDOMAIN' > deploy/cloudflare/hostname.txt
./deploy/cloudflare/verify.sh
```

Smoke test before Access: `https://tvwall.YOURDOMAIN/` should load the wall (or redirect once Access is on).
