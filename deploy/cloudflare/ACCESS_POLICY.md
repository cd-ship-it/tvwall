# Cloudflare Access policy (TV Wall)

Use this when creating the Access application in Step 4, at [one.dash.cloudflare.com](https://one.dash.cloudflare.com).

Dashboard labels have changed over time. Current names:

| What you want | Where it lives now |
|---|---|
| Create the app | **Access controls → Applications → Add an application** |
| App type for a public hostname | **Public DNS** (formerly "Self-hosted") |
| Login methods / OTP | **Integrations → Identity providers** |
| Policies (reusable objects) | **Access controls → Policies** |

## Enable One-time PIN first

New Zero Trust organizations default to the **Cloudflare** identity provider, which only admits members of your Cloudflare account - logging in with any other address fails with "Cloudflare sign-in is restricted to members of the account." OTP is no longer added automatically, so add it before testing:

**Integrations → Identity providers → Add new identity provider → One-time PIN**

## Application

| Setting | Recommended |
|---------|-------------|
| Name | `TV Wall Control` |
| Session duration | 24 hours |
| Application domain | `tvwall.<your-domain>` (exact public hostname from the tunnel) |
| Path | leave empty (protect whole hostname; simplest) |

Protecting only `/control*` is optional. For a small trusted set, whole-hostname Access is fine — operators should not share the URL as a public display link anyway. The physical wall uses localhost kiosk.

## Policy: Allow staff

Created under **Access controls → Policies**, then attached to the application.

- **Action:** Allow
- **Include:** Emails
  - Your email
  - Each trusted operator email
- **Exclude:** (none)

Do **not** write the include rule as Login Methods → One-time PIN on its own: that lets anyone with any email address request a code. Always scope the include to a specific email list.

## Operator login flow

1. Open `https://tvwall.<your-domain>/control`
2. Cloudflare Access challenge (email PIN or Google)
3. App basic auth (`CONTROL_USER` / `CONTROL_PASSWORD` from `.env`)

## Add a person

**Access controls → Policies → Allow staff → Configure** → add their email → Save. Since policies are reusable, the change applies everywhere the policy is attached.

## Revoke a person

Remove their email from the policy. Their Access session stops working after expiry or next login attempt; for immediate lockout, also change `CONTROL_PASSWORD` and restart pm2 if you believe credentials were shared.
