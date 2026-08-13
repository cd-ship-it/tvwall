# Cloudflare Access policy (TV Wall)

Use this when creating the Zero Trust **Self-hosted** application in Step 4.

## Application

| Setting | Recommended |
|---------|-------------|
| Name | `TV Wall Control` |
| Session duration | 24 hours |
| Application domain | `tvwall.<your-domain>` (exact public hostname from the tunnel) |
| Path | leave empty (protect whole hostname; simplest) |

Protecting only `/control*` is optional. For a small trusted set, whole-hostname Access is fine — operators should not share the URL as a public display link anyway. The physical wall uses localhost kiosk.

## Policy: Allow staff

- **Action:** Allow
- **Include:** Emails
  - Your email
  - Each trusted operator email
- **Exclude:** (none)

## Identity providers

1. Enable **One-time PIN** (email) — works for anyone with an inbox, no Google Workspace required.
2. Optionally enable **Google** if staff already use Google accounts.

## Operator login flow

1. Open `https://tvwall.<your-domain>/control`
2. Cloudflare Access challenge (email PIN or Google)
3. App basic auth (`CONTROL_USER` / `CONTROL_PASSWORD` from `.env`)

## Add a person

Zero Trust → Access → Applications → TV Wall Control → Policies → edit **Allow staff** → add email → Save.

## Revoke a person

Remove their email from the policy. Their Access session stops working after expiry or next login attempt; for immediate lockout, also change `CONTROL_PASSWORD` and restart pm2 if you believe credentials were shared.
