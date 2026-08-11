# TV Wall Display System - PRD

## 1. Overview

A headless Mac Mini drives a 3x2 video wall of six Volanti VW-47X panels. Content is managed remotely: media lives in Google Drive, playlist and schedule are defined in a JSON file synced from Drive, and the wall runs unattended with automatic recovery from crashes or reboots. A separate control interface, reachable remotely over Tailscale, lets the operator override what's playing at any time.

## 2. Goals

- Display a looping playlist of videos/slides on the main area, with branding and promotions rotating in a sidebar
- Cut over to a live external webcam feed on a schedule
- Manage all content remotely, without SSHing in to edit files by hand for routine changes
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

- Google Drive is the source of truth for media. A designated Drive folder holds video/slide files, sidebar branding assets, and the playlist config
- The Express backend syncs that Drive folder to a local media cache on the Mac Mini using the Drive API
- Playback always reads from the local cache, never streamed live from Drive, so playback isn't affected by network conditions
- Sync schedule:
  - Every 15 minutes by default
  - Every 1 minute on Sundays
  - A manual "check now" trigger, available from the control panel, for immediate updates
- `playlist.json` lives in the synced Drive folder and defines:
  - Main playlist entries (order, duration, file reference)
  - Sidebar rotation content (branding/promotions, order, duration)
  - Webcam schedule windows (start/end times)
- Editing `playlist.json` in Drive is the primary way to change what's showing; no admin UI is built for this, since the operator is comfortable editing the file directly
- A local upload route (using multer) on the Express server allows dropping a file directly into the local media cache when on-site, as a fallback to editing Drive remotely

## 6. Scheduling & Playback Logic

- `node-cron` inside the Express backend evaluates the schedule
- During a webcam schedule window, the main area switches from the playlist to the live USB feed
- Outside those windows, the main area loops through the playlist as defined in `playlist.json`
- If the webcam feed is unavailable or fails during a scheduled window, show a static "feed unavailable" slide instead of falling back to the regular playlist or showing a blank screen
- Sidebar rotates independently of the main area, on its own timing defined in `playlist.json`

## 7. Webcam / Video Feed

- Source connects via USB directly to the Mac Mini (webcam or capture card)
- Captured in-browser using `getUserMedia`, no ffmpeg or RTSP handling needed
- On capture failure or device disconnect during a scheduled window, display the "feed unavailable" slide and keep attempting to reconnect in the background
- Automatically resume the live feed once the device reconnects, if still within the scheduled window

## 8. Rendering & Kiosk Display

- Chrome, launched with `--kiosk`, pointed at a locally served page (`localhost` or the machine's own address)
- CSS Grid lays out the main area and sidebar within the 2880x1080 canvas
- Auto-login enabled on the Mac Mini so it boots straight to desktop and launches the kiosk browser with no manual intervention

## 9. Control Interface

- A separate route on the same Express server (e.g. `/control`), not part of the kiosk display
- Since the Mac Mini runs headless, this is reached remotely over Tailscale rather than only via localhost
- Protected with basic auth, since it can change what's showing on a public display
- Functions:
  - View current playlist and schedule
  - Force the webcam feed on/off outside its normal schedule
  - Skip to a specific playlist item
  - Trigger an immediate Drive sync check
  - View sync status/last sync time, for troubleshooting

## 10. Remote Access

- Tailscale provides a private network address for the Mac Mini, reachable from any of the operator's devices without exposing ports on the public internet
- Used for both SSH access to the machine itself and for reaching the `/control` web interface

## 11. Process Management & Reliability

- `launchd` starts Chrome in kiosk mode and starts the Express server automatically on boot
- `pm2` supervises the Express process and restarts it automatically on crash
- The system needs to recover unattended after a crash, reboot, or temporary network loss, with no one on site to intervene

## 12. Tech Stack Summary

- Display: macOS + SwitchResX (custom 2880x1080 resolution)
- Rendering: Chrome in kiosk mode, CSS Grid layout
- Backend: Node.js + Express
- Scheduling: node-cron
- Content config: JSON (`playlist.json`), synced from Google Drive
- Media storage: Google Drive (source of truth) + local disk cache (playback source)
- File uploads (local fallback): multer
- Remote access: Tailscale
- Process supervision: launchd + pm2

## 13. Development & Proof-of-Concept Plan

The Mac Mini and Volanti panels are not yet online. Development starts on a regular dev machine connected to a standard 16:9 monitor, so the plan splits into what can be built and verified now versus what needs the real hardware.

### 13.1 Build now, on the dev machine

Everything except the physical resolution/skew fix is hardware-independent and can be fully built and tested now:

- Backend: Express server, Google Drive sync, `playlist.json` parsing, node-cron scheduling logic
- Webcam capture and the "feed unavailable" fallback slide
- Control interface (`/control`) and its functions
- Frontend layout: the app renders into a fixed 2880x1080 container, sized independently of whatever monitor it's displayed on, not sized to fill the dev screen

### 13.2 Dev-time viewing setup

- View the app at true scale by launching Chrome with a fixed window size matching the real canvas, rather than full kiosk mode, e.g.:
  `open -a "Google Chrome" --args --window-size=2880,1080 --app=http://localhost:3000`
- If 2880 pixels doesn't fit the dev monitor, scale proportionally (e.g. 1440x540) to preserve the 8:3 ratio
- Build a dev-only six-panel simulator page: six iframes in a 3x2 CSS Grid, each loading the real app URL and clipped with CSS to show only its own 960x540 slice. This approximates what each physical panel would display and surfaces layout issues at tile boundaries (content cropping awkwardly at a seam, sidebar text cut off, etc.) without needing the wall itself. Worth keeping this tool around after launch for faster layout iteration.

### 13.3 Requires the real hardware, cannot be verified on the dev machine

- SwitchResX correctly applying and holding the 2880x1080 custom resolution
- Each panel's tile mode cropping its assigned slice correctly
- The wall test pattern (circles, position numbers, boundary markers) rendered on the actual panels

### 13.4 Proof-of-concept definition of done

The POC is considered complete, and ready to move to hardware verification, once all of the following run correctly on the dev machine:

- Playlist loops through content read from `playlist.json` in the correct order and timing
- Sidebar rotates branding/promotions independently of the main playlist
- Google Drive sync pulls new/changed files into the local media cache on schedule (15 min default, 1 min Sundays) and on manual trigger
- Webcam feed activates during its scheduled window and the "feed unavailable" slide displays correctly when the feed is forced offline
- Control panel can view status, force the webcam on/off, skip playlist items, and trigger a manual sync
- The six-panel simulator shows no unexpected cropping or misalignment issues in the layout itself (separate from the physical skew issue, which is a hardware verification step)

Once these pass, move to the Mac Mini: apply SwitchResX, set panel tile positions, run the wall test pattern, then deploy the app.

## 14. Out of Scope / Future Considerations

- Non-technical content editing UI (not needed, operator edits JSON directly)
- Apple Silicon migration: SwitchResX is less capable on Apple Silicon; if hardware changes, BetterDisplay's EDID override should be tested before committing, not assumed to work the same way
- Google Sheets as a playlist editing surface instead of raw JSON, if editing JSON by hand ever becomes a bottleneck
- Multi-wall support, if a second display wall is added later
