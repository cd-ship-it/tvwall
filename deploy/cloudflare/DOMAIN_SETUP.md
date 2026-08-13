# Domain setup (Cloudflare zone)

Before creating a tunnel you need a domain whose DNS is managed by Cloudflare.

## If you already have a domain on Cloudflare

1. Dashboard → select the zone
2. Confirm **Status: Active**
3. Proceed to Zero Trust → Tunnels

## If the domain is elsewhere

1. Cloudflare Dashboard → **Add a site** → enter the domain
2. Choose Free plan
3. Cloudflare shows two nameservers — set those at your registrar
4. Wait until the zone is **Active** (can take minutes to hours)
5. Proceed to create the tunnel

## Quick tunnel (trycloudflare.com) — not for this project

`cloudflared tunnel --url http://127.0.0.1:3000` gives a temporary `*.trycloudflare.com` URL **without** Access policies. Do not use that for `/control` in production; use a real zone + Access as in README.md.

## Checklist

- [ ] Zone active in Cloudflare
- [ ] You can create DNS records in that zone (tunnel public hostname will auto-create a CNAME)
- [ ] Zero Trust / Teams is available on the account (free Zero Trust tier is enough to start)
