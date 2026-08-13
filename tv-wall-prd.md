# TV Wall Display System - PRD

## 1. Overview

A headless Mac Mini drives a 3x2 video wall of six Volanti VW-47X panels. Content is managed remotely: media lives in Google Drive, event metadata lives in a synced `events.json`, and the wall runs unattended with automatic recovery from crashes or reboots. A separate control interface, reachable remotely over Tailscale, lets the operator override what's playing at any time.

Each physical wall serves exactly one campus (selected via `CAMPUS` in `.env`).

## 2. Goals

- Display three template zones on a fixed 2880×1080 canvas:
  - **Upcoming** (left) — text cards for upcoming events
  - **Featured** (center) — looping photos and videos
  - **Recent** (right) — recent event photos with titles
- Cut Featured over to a live external webcam feed on a schedule
- Manage media remotely via Google Drive (no SSH required for routine content changes)
- Recover automatically from crashes, reboots, and temporary network loss
- Keep the operator's control surface separate from the public-facing display

## 3. Hardware

- Mac Mini, 2017, Intel
- Six Volanti Displays VW-47X panels in a 3x2 grid
- Plain 1-to-6 HDMI distribution box, mirrors the identical signal to all six panels
- Each panel configured in its own tile/multi-display mode: H monitors 3, V monitors 2, correct position number 1 through 6 per panel
- External USB webcam or capture card, plugged directly into the Mac Mini

## 4. Display Output

- Output resolution: 2880x1080, applied via SwitchResX as a custom resolution (not available in standard macOS display settings)
- This is half of the panels' native combined 5760x2160 canvas, same 8:3 aspect ratio. Lower pixel count reduces load on the Mac's integrated graphics and HDMI bandwidth; each panel's own scaler handles the upscale
- Verify this resolution is still applied after any macOS update or reboot
- Before writing app code, verify the resolution and panel alignment using a static test pattern (circles per tile, position numbers, boundary markers) rendered full screen in Chrome kiosk mode

## 5. Content & Media Management

### 5.1 Layout model (three zones)

The wall layout is defined by two separate images, not one:

| File | Purpose | Displayed? |
|---|---|---|
| `wall_template_default.jpg` | Scan-only - three solid-green placeholder boxes. Scanning writes CSS coordinates, but only runs when manually triggered (`/control` button or `npm run scan-template`) - not automatically on server start, since this file only changes a few times a year. | Never |
| `wall_background.jpg` | The actual visible art behind every zone (dark theme, logo/tagline/static labels baked in) | Yes |

Splitting these avoids the scanned green ever peeking through the rounded zone corners (5.3) - the corners reveal the polished background art instead.

Product names:

| Position | Name | Content |
|---|---|---|
| Left | **Upcoming** | Plain white-text overlay, from `events.json` → `events` |
| Center | **Featured** | Photos + videos from Drive `featured/`, rounded corners |
| Right | **Recent** | Photos from Drive `recent/` + titles from `events.json` → `recent_events`, rounded corners |

There is no sidebar and no hand-edited `playlist.json`.

### 5.2 Drive folder structure

```
DRIVE_ROOT_FOLDER_ID/
  <campus>/
    featured/       # Featured zone media (photos + videos)
    recent/         # Recent zone photos
    events.json     # Upcoming events + Recent event titles / photo refs
```

- Google Drive is the source of truth for media and `events.json`
- The Express backend syncs the campus folder to a local `media/<campus>/` cache
- Playback always reads from the local cache, never streamed live from Drive
- Sync schedule: every 15 minutes by default; every 1 minute on Sundays; plus a manual "check now" from `/control`
- A local upload route (multer) can drop a file into the Featured cache on-site as a fallback

### 5.3 Zone behavior

**Featured**
- Auto-built alphabetically from every recognized file in `featured/`
- Images use a configurable duration; videos always play to completion
- Media is expected to be curated close to the box's aspect ratio (~4:3); when it doesn't match, the letterboxed foreground is backed by a blurred/darkened copy filling the gap - for photos, the photo itself; for video, the first decoded frame, captured client-side into a canvas (no ffmpeg/native deps)
- Corners rounded via a CSS variable (`--featured-radius`, easy to retune)
- Webcam schedule windows replace Featured with the live USB feed

**Recent**
- Play titled events from `recent_events` in source order; for each event with ≥1 resolvable photo, show its title above the box and cycle through that event's photos; **skip events with no photos entirely** (no title)
- Then play orphan photos in `recent/` not referenced by any event (title hidden)
- If there is nothing to show at all → white background with the text **"coming soon"**
- One consistent slide duration for all Recent photos
- Title sits above the box, same width as the image; height capped (default 200px, CSS-editable); font shrinks so characters are never chopped
- Photo corners rounded via a separate CSS variable (`--recent-radius`, independent of Featured's)

**Upcoming**
- Plain white/light text overlay, no card background of its own - the "card" look and any branding are baked into `wall_background.jpg`
- Text cards from `events.json` → `events`, one at a time, source order
- Schema is intentionally loose (upstream newsletter scrape); typography is a starting point, not final

### 5.4 Local config

Webcam schedule windows and per-zone slide durations live in git-tracked `wall-config.json` at the repo root (not Drive-synced). Editable by hand or via `/control`.

## 6. Scheduling & Playback Logic

- `node-cron` inside the Express backend evaluates the webcam schedule
- During a webcam schedule window, **Featured** switches from its playlist to the live USB feed
- Outside those windows, Featured loops its Drive-synced playlist
- If the webcam feed is unavailable or fails during a scheduled window, show a static "feed unavailable" slide instead of falling back to the regular playlist or showing a blank screen
- Upcoming and Recent rotate independently of Featured, each on its own configured duration

## 7. Webcam / Video Feed

- Source connects via USB directly to the Mac Mini (webcam or capture card)
- Captured in-browser using `getUserMedia`, no ffmpeg or RTSP handling needed
- On capture failure or device disconnect during a scheduled window, display the "feed unavailable" slide and keep attempting to reconnect in the background
- Automatically resume the live feed once the device reconnects, if still within the scheduled window

## 8. Rendering & Kiosk Display

- Chrome, launched with `--kiosk`, pointed at a locally served page (`localhost` or the machine's own address)
- Fixed 2880×1080 canvas; zone positions come from the green-box template scan (not a CSS Grid main/sidebar split)
- Auto-login enabled on the Mac Mini so it boots straight to desktop and launches the kiosk browser with no manual intervention

## 9. Control Interface

- A separate route on the same Express server (e.g. `/control`), not part of the kiosk display
- Since the Mac Mini runs headless, this is reached remotely over Tailscale rather than only via localhost
- Protected with basic auth, since it can change what's showing on a public display
- Functions:
  - View current Featured playlist and webcam schedule
  - Adjust slide timing for Featured / Recent / Upcoming (and ticker speed)
  - Force the webcam feed on/off outside its normal schedule
  - Skip to a specific Featured playlist item
  - Trigger an immediate Drive sync check
  - View sync status/last sync time, for troubleshooting
  - Toggle the news ticker on/off
  - Manually trigger a green-box template re-scan, and view last scan status/zone sizes (not run automatically on boot - see 5.1)

## 10. Remote Access

- Tailscale provides a private network address for the Mac Mini, reachable from any of the operator's devices without exposing ports on the public internet
- Used for both SSH access to the machine itself and for reaching the `/control` web interface

## 11. Process Management & Reliability

- `launchd` starts Chrome in kiosk mode and starts the Express server automatically on boot
- `pm2` supervises the Express process and restarts it automatically on crash
- The system needs to recover unattended after a crash, reboot, or temporary network loss, with no one on site to intervene
- Production starts with `npm start` (`node server/index.js`), not `npm run dev` (nodemon is a local-dev dependency only)

## 12. Tech Stack Summary

- Display: macOS + SwitchResX (custom 2880x1080 resolution)
- Rendering: Chrome in kiosk mode, template-scanned zone layout
- Backend: Node.js + Express
- Scheduling: node-cron
- Content: Drive folders `featured/` + `recent/` + campus-root `events.json`; timing/webcam in `wall-config.json`
- Media storage: Google Drive (source of truth) + local disk cache (playback source)
- File uploads (local fallback): multer
- Remote access: Tailscale
- Process supervision: launchd + pm2

## 13. Development & Proof-of-Concept Plan

The Mac Mini and Volanti panels are not yet online. Development starts on a regular dev machine connected to a standard 16:9 monitor, so the plan splits into what can be built and verified now versus what needs the real hardware.

### 13.1 Build now, on the dev machine

Everything except the physical resolution/skew fix is hardware-independent and can be fully built and tested now:

- Backend: Express server, Google Drive sync, `events.json` / zone playlists, node-cron scheduling logic
- Webcam capture and the "feed unavailable" fallback slide
- Control interface (`/control`) and its functions
- Frontend layout: the app renders into a fixed 2880x1080 container, sized independently of whatever monitor it's displayed on, not sized to fill the dev screen
- Template green-box scan → zone CSS generation

### 13.2 Dev-time viewing setup

- View the app at true scale by launching Chrome with a fixed window size matching the real canvas, rather than full kiosk mode, e.g.:
  `open -a "Google Chrome" --args --window-size=2880,1080 --app=http://localhost:3000`
- If 2880 pixels doesn't fit the dev monitor, scale proportionally (e.g. 1440x540) to preserve the 8:3 ratio
- Build a dev-only six-panel simulator page: six iframes in a 3x2 CSS Grid, each loading the real app URL and clipped with CSS to show only its own 960x540 slice. This approximates what each physical panel would display and surfaces layout issues at tile boundaries without needing the wall itself. Worth keeping this tool around after launch for faster layout iteration.

### 13.3 Requires the real hardware, cannot be verified on the dev machine

- SwitchResX correctly applying and holding the 2880x1080 custom resolution
- Each panel's tile mode cropping its assigned slice correctly
- The wall test pattern (circles, position numbers, boundary markers) rendered on the actual panels

### 13.4 Proof-of-concept definition of done

The POC is considered complete, and ready to move to hardware verification, once all of the following run correctly on the dev machine:

- Featured loops photos/videos from the synced `featured/` folder with correct timing (videos play full length)
- Recent plays titled event photos, then orphans, else shows "coming soon"
- Upcoming rotates text cards from `events.json`
- Google Drive sync pulls new/changed files into the local media cache on schedule and on manual trigger
- Webcam feed activates during its scheduled window and the "feed unavailable" slide displays correctly when the feed is forced offline
- Control panel can view status, adjust Upcoming/Featured/Recent timing, force the webcam on/off, skip Featured items, and trigger a manual sync
- The six-panel simulator shows no unexpected cropping or misalignment issues in the layout itself (separate from the physical skew issue, which is a hardware verification step)

Once these pass, move to the Mac Mini: apply SwitchResX, set panel tile positions, run the wall test pattern, then deploy the app.

## 14. Out of Scope / Future Considerations

- Non-technical content editing UI (not needed, operator edits Drive / JSON directly)
- Apple Silicon migration: SwitchResX is less capable on Apple Silicon; if hardware changes, BetterDisplay's EDID override should be tested before committing, not assumed to work the same way
- Google Sheets as an editing surface instead of raw JSON, if editing JSON by hand ever becomes a bottleneck
- Multi-wall support beyond one-campus-per-machine, if a second display wall is added later
- Upcoming card typography / field fine-tuning (deferred; schema rendering works, polish later)
