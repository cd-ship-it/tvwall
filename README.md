# TV Wall Display System

See `tv-wall-prd.md` for the full spec. This is the POC build (PRD section 13) - runs entirely on a dev machine, no Mac Mini / Volanti panels required yet.

Requirement change: this is evolving into a **multi-campus system**. Each physical Mac Mini/wall serves exactly one campus, selected via `CAMPUS` in `.env` - see "Drive folder structure" below.

Deviation from the original PRD: the main playlist is no longer hand-edited via JSON - it's built automatically from whatever files are currently in the synced Drive folder. There's no "sidebar" concept anymore either - the layout is template-based (see "Layout template & zone names" below): each of the five fixed zones reads its own Drive subfolder directly. The webcam schedule still needs explicit curation (there's no way to infer "cut to webcam 9-10:30am Sundays" from a folder of files), so that lives in a small `wall-config.json` - but that file is **not** synced from Drive. It's a git-tracked file at the repo root, edited directly on whichever machine (dev now, the Mac Mini later) and deployed the normal way (edit, commit, `git pull` on the other machine). Drive stays the source of truth for media only.

## Setup

```
npm install
cp .env.example .env
```

Edit `.env`:
- `DRIVE_ROOT_FOLDER_ID` - the Google Drive organization root folder (contains one subfolder per campus).
- `CAMPUS` - which campus subfolder this machine serves, e.g. `milpitas`. Matched case-insensitively against subfolder names directly under `DRIVE_ROOT_FOLDER_ID`.
- `CONTROL_USER` / `CONTROL_PASSWORD` - basic auth for `/control`. Change these before this is reachable over Tailscale.

Google Drive OAuth credentials were copied from the `heart` project (`credentials/client_secret.json`, `credentials/drive_token.json`) - already authenticated as cd@crosspointchurchsv.org with Drive scope, so no fresh consent flow is needed. Both files are gitignored.

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
    main/                <- middle box content
    recent/               <- "Recent Moments" right boxes (not wired up yet)
  <other-campus>/
    main/
    recent/
```

Sync resolves the campus subfolder by name first, then mirrors each zone subfolder inside it into a matching local `media/<campus>/<zone>/` directory (e.g. `media/milpitas/main/`, `media/milpitas/recent/`), so the local cache mirrors the full Drive path, not just the zone name. Loose `.json` files sitting directly in the campus folder root (not inside a zone subfolder) - e.g. `events.json` - are synced straight into `media/<campus>/` too, since that's legitimate data the frontend reads directly, not a wall zone; any other loose file type is skipped with a warning logged rather than guessed into a zone. Every sync run logs what it found and did (folder discovery, per-file download/skip/up-to-date) to the server console - useful for confirming what actually made it down. `getCampusDir()` / `getMainDir()` in `server/services/playlist.js` resolve these paths from `CAMPUS` at call time.

## How content is split up

`server/services/playlist.js` reads `media/<campus>/main/` (populated by Drive sync from the campus's `main/` subfolder) on every request:

**Main playlist (middle box) - fully automatic.** Every recognized media file in `media/<campus>/main/` plays, in alphabetical order. Recognized video extensions (`.mp4 .mov .m4v .webm .avi`) play their natural length (always - duration below never applies to video); recognized image extensions (`.jpg .jpeg .png .gif .webp`) each show for `mainSlideDuration` seconds. Unrecognized file types are skipped. No JSON needed to add content - drop a file in Drive's `main/` subfolder, it syncs, it plays. Photos are letterboxed (`object-fit: contain`) with a blurred, darkened copy of the same photo filling the gap; video gets plain black bars.

**Recent Moments (right box top/middle/bottom) - named event photo groups, from `events.json`.** `media/<campus>/events.json` (synced by driveSync from the loose Drive file of the same name at the campus root - see above) has a `recent_events` array: `[{ event_title, photos: [{ id, url }] }]`. Each photo's Drive file `id` is resolved back to its local filename in `media/<campus>/recent/` via the same sync manifest driveSync uses to skip re-downloading unchanged files. All three boxes swap to the next event simultaneously every `recentRoundDuration` seconds, cycling sequentially through `recent_events` (source order, like the left box - not shuffled); within one event, its own photos fill the three boxes (repeating to fill if it has fewer than 3, distinct if it has >= 3). The event's `event_title` is shown in a small label above the top box while its photos are showing. If `events.json` is missing or has no `recent_events`, falls back to a fully automatic, untitled mode: every image in `media/<campus>/recent/` becomes eligible, and a fresh Fisher-Yates shuffle each round picks 3 distinct photos (or repeats, below 3). Photos are cropped to fill (`object-fit: cover`), not letterboxed. Videos in `recent/` are ignored - these are photo-only slots.

**Upcoming events (left box) - text cards, not media.** Reads `media/<campus>/events.json`'s `events` array (same file as Recent Moments above). One event shown at a time, in the order given in the JSON (not shuffled - source order is assumed meaningful), advancing every `eventsDuration` seconds. White background, black text, per spec. The event schema is deliberately loose (a plain `date`, or `date_range` + `recurrence`, or a `dates` array, plus optional `location`/`address`/`notes`/`cost`/`speakers`/`special_guest`/`doors_open`) since it comes from an upstream newsletter scrape - `formatSchedule()`/`renderEventCard()` in `public/app.js` render whatever fields happen to be present rather than assuming a fixed shape. Missing file or no events found in it just leaves the box blank, doesn't break anything else.

**Slide timing - adjustable from `/control`, no restart needed.** `mainSlideDuration` (middle box), `recentRoundDuration` (right boxes), and `eventsDuration` (left box) are three separate values, all editable live from the "Slide Timing" section of `/control` (`POST /control/api/settings`). Takes effect on the next state poll (~5s), no server restart. All three are stored in `wall-config.json`, so they're also hand-editable there and survive restarts.

**Webcam schedule - curated via `wall-config.json`.** Can't be inferred from a folder of files, so it's still hand-edited (no `/control` UI for this one - the operator is expected to edit the file directly, per the original PRD's design intent). Lives at the repo root (`wall-config.json`) - not in `media/`, not in Drive:

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
- Any field missing or the whole file missing/malformed falls back to defaults (`mainSlideDuration`/`recentRoundDuration` 8s, `eventsDuration` 5s, no scheduled windows) - main playlist keeps working either way.
- Drive sync explicitly skips any file named `wall-config.json` if one ever ends up in the Drive folder too, so there's never ambiguity about which copy is real - the git-tracked one at the repo root always wins.
- Backups/versioning are on you (as requested) - this file is no longer synced anywhere automatically, so keep it committed and pushed. `/control`'s settings save does a read-modify-write against it, so hand edits and UI edits share the same file without clobbering each other's fields.

There's no sidebar concept anymore - it's been fully replaced by the template's fixed zones (left box, right box top/middle/bottom), each of which reads its own Drive subfolder (or, for the left box, a local JSON file) directly.

**News ticker - not one of the template's 5 zones.** A full-width overlay bar, ~100px tall, pinned to the bottom of the canvas and rendered on top of every zone (`z-index: 1000` - explicit, not just relying on DOM order). Blue background, white text, continuous right-to-left scroll. Content comes from a local `news*.txt` in the campus directory (e.g. `media/milpitas/newsticcker.txt` - matched broadly by prefix/extension rather than trying to pattern-match "ticker" spelling variants, since a typo can break a literal substring match anyway), whitespace-collapsed into one line. Scroll speed (`tickerSpeed`, pixels/second) is adjustable live from `/control`'s "Slide Timing" section, defaults to 30. Implemented as a `requestAnimationFrame` loop in `public/app.js` (not a CSS animation) specifically so a live speed change takes effect immediately without recalculating/restarting an animation-duration; looping is seamless regardless of text length vs. container width via the standard duplicate-text-plus-modulo-wrap marquee technique. Can be switched fully on/off from `/control`'s "News Ticker" section (`POST /control/api/ticker`, `tickerEnabled` in `wall-config.json`) - when off, the bar is hidden (`display: none`) and the animation loop itself stops (`cancelAnimationFrame`), not just visually hidden while still running.

## Layout template & zone names

`wall_template_default.jpg` (repo root) is the background design - a 2880x1080 mockup with five placeholder boxes in solid green (`#00ff2a`) marking where live content sits.

Standard names for these zones, used everywhere else in this repo/conversation from now on: **left box**, **middle box**, **right box top/middle/bottom**.

**Positions are rescanned automatically on every server start**, not hardcoded - `server/services/templateScan.js` decodes the current `wall_template_default.jpg` (pure-JS JPEG decode via `jpeg-js`, no native deps or Python needed), flood-fills the green channel to find the five blobs, and classifies them by shape/position (biggest = middle, the one on the left half = left box, the three on the right half sorted top-to-bottom = right top/middle/bottom). `server/services/zonePositions.js` writes the result to `public/zone-positions.css` (gitignored - it's a build artifact), which `index.html` loads after `style.css` so its values win.

This means: **replacing `wall_template_default.jpg` with a new design that keeps the green boxes in roughly the same places just works** - no `/control` step, no JSON, no code change. Restart the server (or let nodemon auto-restart, which it already does when that file changes) and the new positions take effect. `npm run scan-template` runs the same scan standalone, without booting the server, for a quick check.

If a template swap is a **real structural change** (different number of boxes, or a box that no longer falls cleanly on the left/right half), the scan fails on purpose rather than guessing wrong - it logs a clear error, keeps the previous `zone-positions.css` (last known good) in place, and the wall keeps running on the old layout. That's the signal that `templateScan.js`'s classification logic needs an actual code update, not just a new image.

Last measured positions (for reference - always trust `public/zone-positions.css` / the server log over this table, since this one doesn't auto-update):

| Zone | x, y | w × h |
|---|---|---|
| **Left box** | 97, 558 | 501 × 458 |
| **Middle box** | 706, 0 | 1468 × 1080 (full height) |
| **Right box top** | 2274, 159 | 524 × 256 |
| **Right box middle** | 2274, 458 | 524 × 256 |
| **Right box bottom** | 2274, 757 | 535 × 262 |

Content-model mapping (as of the current implementation):
- **Middle box** - main playlist, auto-synced from Drive's `main/` subfolder (wired up)
- **Right box top/middle/bottom** - three separate simultaneous slots ("Recent Moments"), cycling through named event photo groups from `events.json`'s `recent_events` (title above the top box), falling back to an untitled shuffle of Drive's `recent/` subfolder if that's absent - synchronized round-robin, not a single rotating strip (wired up)
- **Left box** - upcoming events text cards, sourced from `events.json`'s `events` array, one at a time, white background/black text (wired up)

## Known gaps / next steps

- `npm audit` reports moderate transitive vulnerabilities (`uuid`) via `googleapis` and `node-cron`; fixing requires a node-cron major bump (v3 -> v4). Not addressed yet - low risk on a private, Tailscale-only network, but worth revisiting.
- Everything under PRD 13.3 (SwitchResX resolution, panel tile-mode cropping, wall test pattern on real hardware) is untestable until the Mac Mini and panels are online.
# tvwall
