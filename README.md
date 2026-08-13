# TV Wall Display System

See `tv-wall-prd.md` for the full spec. This is the POC build (PRD section 13) - runs entirely on a dev machine, no Mac Mini / Volanti panels required yet.

Requirement change: this is evolving into a **multi-campus system**. Each physical Mac Mini/wall serves exactly one campus, selected via `CAMPUS` in `.env` - see "Drive folder structure" below.

Deviation from the original PRD: there is no hand-edited `playlist.json` and no sidebar. The layout is template-based with **three** fixed zones — **Upcoming** (left), **Featured** (center), **Recent** (right) — see "Layout template & zone names" below. Featured and Recent media come from Drive subfolders; Upcoming + Recent titles come from `events.json`. The webcam schedule still needs explicit curation (there's no way to infer "cut to webcam 9-10:30am Sundays" from a folder of files), so that lives in a small `wall-config.json` - but that file is **not** synced from Drive. It's a git-tracked file at the repo root, edited directly on whichever machine (dev now, the Mac Mini later) and deployed the normal way (edit, commit, `git pull` on the other machine). Drive stays the source of truth for media only.

## Setup

```
npm install
cp .env.example .env
```

Edit `.env`:
- `DRIVE_ROOT_FOLDER_ID` - the Google Drive organization root folder (contains one subfolder per campus).
- `CAMPUS` - which campus subfolder this machine serves, e.g. `milpitas`. Matched case-insensitively against subfolder names directly under `DRIVE_ROOT_FOLDER_ID`.
- `CONTROL_USER` / `CONTROL_PASSWORD` - basic auth for `/control`. **Change `CONTROL_PASSWORD` before exposing `/control` over Tailscale or Cloudflare** (see `.env.example`).

Google Drive OAuth credentials were copied from the `heart` project (`credentials/client_secret.json`, `credentials/drive_token.json`) - already authenticated as cd@crosspointchurchsv.org with Drive scope, so no fresh consent flow is needed. Both files are gitignored.

## Mac Mini kiosk (production)

LaunchAgents + wrappers live in `deploy/kiosk/`:

- `start-server.sh` — starts/resurrects the Express app under pm2 if `tvwall` is not online (also used as a 2‑minute watchdog)
- `start-chrome.sh` — waits for `http://127.0.0.1:$PORT/`, then `exec`s Chrome in `--kiosk` with a dedicated profile (**always localhost**, even if Cloudflare exposes `/control` publicly)
- `install.sh` / `uninstall.sh` — render plist templates into `~/Library/LaunchAgents` and load/unload them

On the Mini (auto-login user), after `.env` / credentials / `npm install` / a working `pm2 start` + `pm2 save`:

```
./deploy/kiosk/install.sh
```

Logs: `~/Library/Logs/TVWall/`. See script headers for smoke-test commands.

## Cloudflare Tunnel + Access (remote `/control`)

Staff can open `/control` from any browser without Tailscale. Artifacts live in `deploy/cloudflare/`:

1. Domain on Cloudflare — see [`deploy/cloudflare/DOMAIN_SETUP.md`](deploy/cloudflare/DOMAIN_SETUP.md)
2. Create tunnel in Zero Trust, then on the Mini: `./deploy/cloudflare/install-tunnel.sh '<TOKEN>'`
3. Public hostname → `http://127.0.0.1:3000`
4. Access policy — [`deploy/cloudflare/ACCESS_POLICY.md`](deploy/cloudflare/ACCESS_POLICY.md)
5. `./deploy/cloudflare/verify.sh tvwall.YOURDOMAIN`

Full walkthrough: [`deploy/cloudflare/README.md`](deploy/cloudflare/README.md). Hostname mapping: [`PUBLIC_HOSTNAME.md`](deploy/cloudflare/PUBLIC_HOSTNAME.md). Access: [`ACCESS_POLICY.md`](deploy/cloudflare/ACCESS_POLICY.md). Keep SSH on Tailscale; keep kiosk Chrome on localhost.

## Run

```
npm run dev
```

Then, per PRD 13.2, view at true scale instead of full kiosk mode:

```
open -a "Google Chrome" --args --window-size=2880,1080 --app=http://localhost:3000
```

If 2880px doesn't fit your monitor, scale proportionally, e.g. `--window-size=1440,540`.

## Dev tools

- `http://localhost:3000/` - the kiosk display itself (fixed 2880x1080 canvas)
- `http://localhost:3000/simulator.html` - six-panel simulator (six iframes clipped to their 960x540 slice), for catching layout/seam issues without the real wall
- `http://localhost:3000/test-pattern.html` - static alignment test pattern (circles, position numbers, boundary markers per tile); load this on the real hardware first, before the app, per PRD section 4
- `http://localhost:3000/control` - control panel (basic auth)

## Drive folder structure

```
DRIVE_ROOT_FOLDER_ID/
  milpitas/              <- matched against CAMPUS (case-insensitive)
    featured/            <- Featured zone (center) photos + videos
    recent/              <- Recent zone (right) photos
    events.json          <- Upcoming text + Recent event titles/photo refs
  <other-campus>/
    featured/
    recent/
    events.json
```

Sync resolves the campus subfolder by name first, then mirrors each zone subfolder into a matching local `media/<campus>/<zone>/` directory (e.g. `media/milpitas/featured/`, `media/milpitas/recent/`), so the local cache mirrors the full Drive path. Loose `.json` files at the campus folder root (e.g. `events.json`) are synced into `media/<campus>/` too; any other loose file type is skipped with a warning. Every sync run logs what it found to the server console. `getCampusDir()` / `getFeaturedDir()` / `getRecentDir()` in `server/services/playlist.js` resolve these paths from `CAMPUS` at call time.

**Important:** Drive zone folders must be named `featured` and `recent` (case-insensitive). The old `main/` name is obsolete.

## How content is split up

**Featured (center) - fully automatic.** Every recognized media file in `media/<campus>/featured/` plays, in alphabetical order. Videos (`.mp4 .mov .m4v .webm .avi`) always play their natural length; images (`.jpg .jpeg .png .gif .webp`) each show for `mainSlideDuration` seconds. Unrecognized types are skipped. Drop a file in Drive's `featured/` subfolder, it syncs, it plays. Media is expected to be curated close to the box's aspect ratio (roughly 4:3), but when it doesn't match exactly, the letterboxed (`object-fit: contain`) foreground is backed by a blurred, darkened copy filling the gap instead of plain black bars - for photos that's the photo itself; for video, `app.js` (`SequencePlayer._captureVideoFrame`) grabs the first decoded frame into an offscreen canvas and uses that as the backdrop, no black bars. The box's corners are rounded via `--featured-radius` in `public/style.css` (default `24px`, easy to retune). Webcam schedule windows replace Featured with the live USB feed when active.

**Recent (right) - titled event photos, then orphans.** `media/<campus>/events.json` has a `recent_events` array: `[{ event_title, photos: [{ id, url }] }]`. Each photo `id` is resolved to a local file in `media/<campus>/recent/` via the sync manifest. Playback order:
1. Events in source order — for each event with at least one resolvable photo, show the title above the box and cycle through that event's photos one at a time; events with **no** photos are skipped entirely (no title).
2. Then any **orphan** images in `recent/` not referenced by any event — shown untitled (title hidden).
3. If there is **nothing** to show at all → white background with **"coming soon"**.

One consistent duration (`recentRoundDuration`) for every Recent photo. Title sits above the green box, same width as the image; height is capped by `--recent-title-max-height` in `public/style.css` (default **200px**, hand-editable); font shrinks so the full title always fits without chopping characters. The photo itself has rounded corners via `--recent-radius` in `public/style.css` (default `16px`, independent from Featured's radius). Videos in `recent/` are ignored (photo-only slot).

**Upcoming (left) - plain text overlay, no card.** `.zone-left` has no background fill of its own (transparent) - the "card" look, and any logo/branding, comes entirely from whatever's baked into `wall_background.jpg` at that spot (see "Layout template & zone names" below). Code only renders white/light text on top: reads `events.json`'s `events` array (same file as Recent), one event at a time, source order, every `eventsDuration` seconds. Schema is deliberately loose (plain `date`, or `date_range` + `recurrence`, or `dates` array, plus optional location/address/notes/cost/speakers/etc.) — `formatSchedule()` / `renderEventCard()` in `public/app.js` render whatever fields are present; `public/style.css`'s `.event-card`/`.event-title-*`/`.event-schedule`/`.event-location`/`.event-notes` control the (currently minimal, not-yet-final) typography. Missing file / empty list leaves the box blank. The old `mp_upcoming_events.json` source is obsolete.

**Slide timing - adjustable from `/control`.** Featured (`mainSlideDuration`), Recent (`recentRoundDuration`), and Upcoming (`eventsDuration`) are three separate values, editable live from "Slide Timing" (`POST /control/api/settings`). Takes effect on the next state poll (~5s). Stored in `wall-config.json`.

**Webcam schedule - curated via `wall-config.json`.** Can't be inferred from a folder of files, so it's still hand-edited (no `/control` UI for this one). Lives at the repo root — not in `media/`, not in Drive:

```json
{
  "webcamSchedule": [
    { "start": "09:00", "end": "10:30", "days": ["Sun"] }
  ],
  "mainSlideDuration": 8,
  "recentRoundDuration": 8,
  "eventsDuration": 5
}
```

- `webcamSchedule` entries are `{ start, end, days }` in 24h `HH:MM`, local time. Omit `days` for "every day." Outside these windows (or with no `wall-config.json` at all), the wall only cuts to webcam when forced on manually from `/control`.
- Any field missing or the whole file missing/malformed falls back to defaults (`mainSlideDuration`/`recentRoundDuration` 8s, `eventsDuration` 5s, no scheduled windows) - Featured playlist keeps working either way.
- Drive sync explicitly skips any file named `wall-config.json` if one ever ends up in the Drive folder too, so there's never ambiguity about which copy is real - the git-tracked one at the repo root always wins.
- Backups/versioning are on you (as requested) - this file is no longer synced anywhere automatically, so keep it committed and pushed. `/control`'s settings save does a read-modify-write against it, so hand edits and UI edits share the same file without clobbering each other's fields.

**News ticker - not one of the template's 3 zones.** A full-width overlay bar, ~100px tall, pinned to the bottom of the canvas and rendered on top of every zone (`z-index: 1000` - explicit, not just relying on DOM order). Blue background, white text, continuous right-to-left scroll. Content comes from a local `news*.txt` in the campus directory (e.g. `media/milpitas/newsticcker.txt` - matched broadly by prefix/extension rather than trying to pattern-match "ticker" spelling variants, since a typo can break a literal substring match anyway), whitespace-collapsed into one line. Scroll speed (`tickerSpeed`, pixels/second) is adjustable live from `/control`'s "Slide Timing" section, defaults to 30. Implemented as a `requestAnimationFrame` loop in `public/app.js` (not a CSS animation) specifically so a live speed change takes effect immediately without recalculating/restarting an animation-duration; looping is seamless regardless of text length vs. container width via the standard duplicate-text-plus-modulo-wrap marquee technique. Can be switched fully on/off from `/control`'s "News Ticker" section (`POST /control/api/ticker`, `tickerEnabled` in `wall-config.json`) - when off, the bar is hidden (`display: none`) and the animation loop itself stops (`cancelAnimationFrame`), not just visually hidden while still running.

**Refresh Display / Restart Server - remote deploys from `/control`.** The "Display & Server" section covers the two things a `git pull` on the Mini needs, so a code update doesn't require SSH plus a Chrome restart:

- **Refresh Display** (`POST /control/api/reload-display`) bumps `state.reload.nonce`; the kiosk page sees the new value on its next `/api/state` poll (~5s) and calls `location.reload()`. Picks up changed HTML/CSS/JS. Same nonce-vs-last-seen trick as "skip to item", so a lingering value can't cause reload loops.
- **Restart Server** (`POST /control/api/restart-server`) responds, then exits the process 250ms later so the supervisor starts a fresh one - that's how changed *server* code takes effect. Under pm2 that's autorestart, with `deploy/kiosk`'s 2-minute LaunchAgent watchdog as a backstop. The button then polls `/control/api/status` until the new process answers. Under `npm run dev` there's no supervisor (nodemon treats a clean exit as "done"), so the response reports `supervised: false` and the UI says nothing restarted it - use this on the Mini, not in dev.

The wall keeps showing its current slides through a server restart; `pollState()` swallows the failed polls and resumes when the server is back.

## Layout template & zone names

Two separate images, deliberately not one dual-purpose file:

| File | Purpose | Ever displayed? |
|---|---|---|
| `wall_template_default.jpg` (repo root) | **Scan-only.** A 2880x1080 image with **three** placeholder boxes in solid green (a fuzzy range around `#00ff2a`-`#24ff00`) marking where each zone sits. | No - purely a coordinate source. |
| `wall_background.jpg` (repo root) | **Display-only.** The actual polished art shown behind every zone - dark theme, any logo/tagline/static labels baked in, no green needed. | Yes - served at `/assets/wall-background.jpg`. |

They're split like this so rounded zone corners (see below) reveal tasteful background art at the corners instead of leftover scan-green. `wall_background.jpg` doesn't ship in the repo by default - until you drop one in, `server/index.js`'s route for it responds with no content and `.wall`'s CSS `background: #000` fallback just shows plain black.

Canonical product names (use these everywhere):

| Position | Name | Role |
|---|---|---|
| Left | **Upcoming** | Plain white-text overlay (upcoming events) |
| Center | **Featured** | Featured photos + videos, rounded corners |
| Right | **Recent** | Recent event photos, rounded corners, title above the box |

**Positions come from a manually-triggered scan**, not hardcoded - `server/services/templateScan.js` decodes the current `wall_template_default.jpg` (pure-JS JPEG decode via `jpeg-js`, no native deps or Python needed), flood-fills the green channel to find the three blobs, and classifies them by shape/position (biggest = Featured/middle, left-half = Upcoming, right-half = Recent). `server/services/zonePositions.js` writes the result to `public/zone-positions.css` (gitignored - it's a build artifact), which `index.html` loads after `style.css` so its values win. None of this changed by the two-file split above - only what's *displayed* changed, not what's *scanned*.

**The scan does NOT run automatically on server start** (dev, prod, or pm2) - `wall_template_default.jpg` only changes a handful of times a year, so re-scanning on every boot/nodemon-restart just risked clobbering hand-tuned CSS for no benefit. Trigger it manually instead, whichever's more convenient:
- **"Scan Template Now"** button on `/control` (Wall Template Scan section) - shows last scan time/result/zone sizes right there, no SSH needed.
- `npm run scan-template` from the CLI - same scan, standalone, without booting the server.

This means: **replacing `wall_template_default.jpg` with a new design that keeps the green boxes in roughly the same places just works** - drop in the new file, then click "Scan Template Now" (or run the CLI command). No `/control` settings change, no JSON, no code change. Updating `wall_background.jpg` (the visible art) is even simpler - just replace the file, no scan involved at all.

If a template swap is a **real structural change** (different number of boxes, or a box that no longer falls cleanly on the left/right half), the scan fails on purpose rather than guessing wrong - it logs a clear error (surfaced on `/control` too), keeps the previous `zone-positions.css` (last known good) in place, and the wall keeps running on the old layout. That's the signal that `templateScan.js`'s classification logic needs an actual code update, not just a new image.

Until the first-ever scan (e.g. a brand new checkout, since `zone-positions.css` is gitignored), the hardcoded fallback values at the top of `public/style.css` apply - they match the current `wall_template_default.jpg`, so nothing looks broken, but run one manual scan after setup to be sure.

**Rounded corners.** Featured and Recent each clip to rounded corners (`.zone`'s existing `overflow: hidden` does the clipping) via independent CSS variables in `public/style.css`: `--featured-radius` (default `24px`) and `--recent-radius` (default `16px`). Upcoming has no box fill of its own, so no radius applies there - see "Upcoming" above.

Last measured positions (for reference - always trust `public/zone-positions.css` / the server log over this table, since this one doesn't auto-update):

| Zone | x, y | w × h |
|---|---|---|
| **Upcoming (left)** | 97, 558 | 501 × 458 |
| **Featured (center)** | 841, 95 | 1198 × 895 |
| **Recent (right)** | 2175, 366 | 600 × 447 |

Content-model mapping:
- **Featured** - auto-synced from Drive `featured/` (photos + videos)
- **Recent** - `events.json` `recent_events` (titled), then orphan photos in `recent/`, else "coming soon"
- **Upcoming** - `events.json` `events` text cards

## Known gaps / next steps

- `npm audit` reports moderate transitive vulnerabilities (`uuid`) via `googleapis` and `node-cron`; fixing requires a node-cron major bump (v3 -> v4). Not addressed yet - low risk on a private, Tailscale-only network, but worth revisiting.
- Everything under PRD 13.3 (SwitchResX resolution, panel tile-mode cropping, wall test pattern on real hardware) is untestable until the Mac Mini and panels are online.
# tvwall
