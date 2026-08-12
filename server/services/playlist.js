const fs = require('fs');
const path = require('path');

const MEDIA_DIR = path.join(__dirname, '..', '..', 'media');
// Lives in the repo root, not the Drive-synced media cache - this is
// hand-edited directly on whichever machine (dev or the Mac Mini) and
// tracked in git, not treated as Drive content.
const CONFIG_PATH = path.join(__dirname, '..', '..', 'wall-config.json');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const IGNORED_FILES = new Set(['.gitkeep', '.ds_store', '.sync-manifest.json', 'wall-config.json']);
const DEFAULT_SLIDE_DURATION = Number(process.env.DEFAULT_SLIDE_DURATION) || 8;

// Flat root of the whole local media cache - holds the shared sync
// manifest, and one subdirectory per campus underneath it.
function getMediaDir() {
  return MEDIA_DIR;
}

// media/<campus>/ - mirrors the campus subfolder in Drive. Read at call
// time (not cached at module load) so it reflects CAMPUS from .env
// regardless of require() ordering.
function getCampusDir() {
  const campus = (process.env.CAMPUS || '').trim().toLowerCase();
  return campus ? path.join(MEDIA_DIR, campus) : MEDIA_DIR;
}

// media/<campus>/main/ - Drive folder is organized as subfolders per wall
// zone (main/, recent/, ...) under each campus - driveSync mirrors each
// into a matching local directory. The middle box plays whatever's here.
function getMainDir() {
  return path.join(getCampusDir(), 'main');
}

// media/<campus>/recent/ - source for the three "Recent Moments" right boxes.
function getRecentDir() {
  return path.join(getCampusDir(), 'recent');
}

// Scans a zone directory into { file, type, duration? } entries, same
// recognized-extension rules everywhere. `imageDuration` (seconds) is
// applied to every image found - videos ignore it and always play their
// natural length.
function scanMediaDir(dir, imageDuration) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => !name.startsWith('.') && !IGNORED_FILES.has(name.toLowerCase()))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const ext = path.extname(name).toLowerCase();
      if (VIDEO_EXTENSIONS.has(ext)) return { file: name, type: 'video' };
      if (IMAGE_EXTENSIONS.has(ext)) return { file: name, type: 'image', duration: imageDuration };
      return null; // unrecognized file type, e.g. stray non-media upload - skip
    })
    .filter(Boolean);
}

// Recent Moments source pool - photos only for now (the three right boxes
// are photo slots; skip any video that ends up in recent/).
function getRecentItems() {
  const config = loadConfig();
  return scanMediaDir(getRecentDir(), config.recentRoundDuration).filter((item) => item.type === 'image');
}

// Right boxes ("Recent Moments") - named photo groups, sourced from
// events.json dropped directly in the campus directory root by driveSync
// (a loose Drive file, not a zone subfolder - see driveSync.js). Its
// `recent_events` array is `[{ event_title, photos: [{ id, url }] }]`;
// each photo's Drive file `id` is resolved back to the local filename
// driveSync already downloaded into media/<campus>/recent/ via the shared
// sync manifest, rather than re-fetching from `url` (which would hit
// Drive on every request and duplicate what's already synced locally).
function getRecentEvents() {
  const dir = getCampusDir();
  const filePath = path.join(dir, 'events.json');
  if (!fs.existsSync(filePath)) return [];

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return [];
  }

  const recentEvents = Array.isArray(parsed.recent_events) ? parsed.recent_events : [];
  if (recentEvents.length === 0) return [];

  const manifest = loadSyncManifest();
  const recentDir = getRecentDir();

  return recentEvents
    .map((ev) => {
      const photoRefs = Array.isArray(ev.photos) ? ev.photos : [];
      const files = photoRefs
        .map((p) => manifest[p.id])
        .filter((entry) => entry && entry.folder === 'recent')
        .map((entry) => entry.name)
        .filter((name) => fs.existsSync(path.join(recentDir, name)));
      return { title: ev.event_title || '', photos: files };
    })
    .filter((ev) => ev.photos.length > 0);
}

function loadSyncManifest() {
  const manifestPath = path.join(getMediaDir(), '.sync-manifest.json');
  if (!fs.existsSync(manifestPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return {};
  }
}

// Left box - upcoming events, sourced from a *_upcoming_events.json file
// dropped directly in the campus directory (not a Drive-synced subfolder;
// whatever process generates this file writes there directly - out of
// scope here, this just reads it). Named per-campus (e.g.
// mp_upcoming_events.json for milpitas) rather than a fixed filename, so
// the same glob works across campuses without per-campus config.
function getUpcomingEvents() {
  const dir = getCampusDir();
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const match = entries.find((e) => e.isFile() && /_upcoming_events\.json$/i.test(e.name));
  if (!match) return [];

  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, match.name), 'utf8'));
    return Array.isArray(parsed.events) ? parsed.events : [];
  } catch {
    // Malformed/missing file - left box just shows nothing until it's fixed.
    return [];
  }
}

// News ticker - full-width overlay bar at the bottom, on top of every
// zone, sourced from a local news*.txt in the campus directory (same
// "external process writes it, we just read it" pattern as the events
// JSON).
function getNewsTickerText() {
  const dir = getCampusDir();
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return '';
  }

  // Deliberately broad (just "news*.txt") rather than trying to pattern-
  // match "ticker" spelling variants - a typo like "newsticcker" breaks a
  // literal "tick" substring match too (the doubled c splits it), and this
  // directory only ever has one news-ish .txt file in practice.
  const match = entries.find((e) => e.isFile() && /^news.*\.txt$/i.test(e.name));
  if (!match) return '';

  try {
    const raw = fs.readFileSync(path.join(dir, match.name), 'utf8');
    return raw.replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

const DEFAULT_SETTINGS = {
  mainSlideDuration: DEFAULT_SLIDE_DURATION, // middle box, per image
  recentRoundDuration: DEFAULT_SLIDE_DURATION, // right boxes, per round (all 3 swap together)
  eventsDuration: 5, // left box, per event card
  tickerSpeed: 30, // news ticker, pixels per second
  tickerEnabled: true, // news ticker on/off, from /control
};

// Webcam schedule windows and per-zone slide/round durations can't be
// inferred from a folder of files, so they're still hand-curated - via a
// small, git-tracked config file local to each machine, editable by hand
// or through /control (both just read/write this same file). Main content
// itself stays fully automatic from the Drive sync - only its timing is
// configurable here. Zone content (left box, right boxes) is
// template-based, not config-based - each zone reads its own Drive/local
// subfolder directly.
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { webcamSchedule: [], ...DEFAULT_SETTINGS };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      webcamSchedule: Array.isArray(parsed.webcamSchedule) ? parsed.webcamSchedule : [],
      mainSlideDuration: Number(parsed.mainSlideDuration) > 0 ? Number(parsed.mainSlideDuration) : DEFAULT_SETTINGS.mainSlideDuration,
      recentRoundDuration:
        Number(parsed.recentRoundDuration) > 0 ? Number(parsed.recentRoundDuration) : DEFAULT_SETTINGS.recentRoundDuration,
      eventsDuration: Number(parsed.eventsDuration) > 0 ? Number(parsed.eventsDuration) : DEFAULT_SETTINGS.eventsDuration,
      tickerSpeed: Number(parsed.tickerSpeed) > 0 ? Number(parsed.tickerSpeed) : DEFAULT_SETTINGS.tickerSpeed,
      tickerEnabled: typeof parsed.tickerEnabled === 'boolean' ? parsed.tickerEnabled : DEFAULT_SETTINGS.tickerEnabled,
    };
  } catch {
    // Malformed config shouldn't take down the main playlist - fall back
    // to defaults until it's fixed.
    return { webcamSchedule: [], ...DEFAULT_SETTINGS };
  }
}

// Read-modify-write against wall-config.json, preserving any fields this
// module doesn't know about (e.g. hand-added ones) rather than clobbering
// the whole file.
function updateSettings(patch) {
  let raw = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
      raw = {};
    }
  }
  const next = { ...raw, ...patch };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n');
  return loadConfig();
}

// Main playlist is auto-built from whatever's in the synced media/main/
// cache, rebuilt from disk on every call so a Drive sync just shows up with
// no manual step.
function getPlaylist() {
  const config = loadConfig();
  return {
    playlist: scanMediaDir(getMainDir(), config.mainSlideDuration),
    webcamSchedule: config.webcamSchedule,
  };
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// window: { start: "HH:MM", end: "HH:MM", days?: ["Sun", ...] }
// Same-day windows only (end assumed later than start on the same day).
function isWithinWindow(window, now = new Date()) {
  if (window.days && window.days.length > 0) {
    const today = DAY_NAMES[now.getDay()];
    if (!window.days.includes(today)) return false;
  }

  const [startH, startM] = window.start.split(':').map(Number);
  const [endH, endM] = window.end.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  return nowMinutes >= startMinutes && nowMinutes < endMinutes;
}

function isWebcamScheduled(webcamSchedule, now = new Date()) {
  return webcamSchedule.some((w) => isWithinWindow(w, now));
}

module.exports = {
  getMediaDir,
  getCampusDir,
  getMainDir,
  getRecentDir,
  getPlaylist,
  getRecentItems,
  getRecentEvents,
  getUpcomingEvents,
  getNewsTickerText,
  loadConfig,
  updateSettings,
  isWebcamScheduled,
  isWithinWindow,
};
