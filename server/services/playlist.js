const fs = require('fs');
const path = require('path');

const MEDIA_DIR = path.join(__dirname, '..', '..', 'media');
// Lives in the repo root, not the Drive-synced media cache - this is
// hand-edited directly on whichever machine (dev or the Mac Mini) and
// tracked in git, not treated as Drive content.
const CONFIG_PATH = path.join(__dirname, '..', '..', 'wall-config.json');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
// Fullscreen override accepts JPG/PNG + video only (no gif/webp).
const FULLSCREEN_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);
const IGNORED_FILES = new Set(['.gitkeep', '.ds_store', '.sync-manifest.json', 'wall-config.json']);
const DEFAULT_SLIDE_DURATION = Number(process.env.DEFAULT_SLIDE_DURATION) || 8;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HH_MM_RE = /^\d{2}:\d{2}$/;

const DEFAULT_FULLSCREEN = {
  file: null, // filename inside fullscreen_img/, or null
  start: '09:00',
  end: '10:00',
  days: [], // empty = never auto-scheduled; operator must pick days
  force: null, // 'on' | 'off' | null — persisted so Force On survives restarts
};

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

// media/<campus>/featured/ - Featured zone (center). Drive folder is
// organized as subfolders per wall zone (featured/, recent/) under each
// campus - driveSync mirrors each into a matching local directory.
function getFeaturedDir() {
  return path.join(getCampusDir(), 'featured');
}

// media/<campus>/recent/ - Recent zone (right box) photo pool.
function getRecentDir() {
  return path.join(getCampusDir(), 'recent');
}

// media/<campus>/fullscreen_img/ - full-canvas override media (Drive
// folder of the same name under the campus). Covers the whole wall when
// scheduled or force-shown from /control.
function getFullscreenDir() {
  return path.join(getCampusDir(), 'fullscreen_img');
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

// events.json dropped directly in the campus directory root by driveSync
// (a loose Drive file, not a zone subfolder - see driveSync.js). Single
// source for both Upcoming (`events`) and Recent titled groups
// (`recent_events`) - re-read from disk on every call (no caching) so a
// fresh Drive sync shows up immediately, same as every other zone here.
function loadEventsJson() {
  const filePath = path.join(getCampusDir(), 'events.json');
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
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

// Recent titled groups from events.json's `recent_events` array:
// `[{ event_title, photos: [{ id, url }] }]`. Each photo's Drive file `id`
// is resolved back to the local filename driveSync already downloaded into
// media/<campus>/recent/ via the shared sync manifest. Events with zero
// resolvable local photos are dropped entirely (no title, no placeholder).
function getRecentEvents() {
  const parsed = loadEventsJson();
  if (!parsed) return [];

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

// Ordered Recent slideshow for the right box:
//   1. titled event photos in events.json source order (skip empty events)
//   2. then orphan images in recent/ not referenced by any event (untitled)
//   3. if nothing at all → comingSoon (frontend shows "coming soon")
function getRecentSlides() {
  const config = loadConfig();
  const events = getRecentEvents();
  const referenced = new Set();
  const slides = [];

  for (const ev of events) {
    for (const file of ev.photos) {
      referenced.add(file);
      slides.push({ title: ev.title, file });
    }
  }

  const orphans = scanMediaDir(getRecentDir(), config.recentRoundDuration)
    .filter((item) => item.type === 'image')
    .filter((item) => !referenced.has(item.file));

  for (const item of orphans) {
    slides.push({ title: '', file: item.file });
  }

  return {
    slides,
    comingSoon: slides.length === 0,
    duration: config.recentRoundDuration,
  };
}

// Upcoming zone - text cards from events.json's `events` array (same file
// as getRecentEvents() above). Malformed/missing file just leaves the box
// blank until it's fixed, rather than breaking anything else.
function getUpcomingEvents() {
  const parsed = loadEventsJson();
  if (!parsed) return [];
  return Array.isArray(parsed.events) ? parsed.events : [];
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
  mainSlideDuration: DEFAULT_SLIDE_DURATION, // Featured zone, per image
  recentRoundDuration: DEFAULT_SLIDE_DURATION, // Recent zone, per photo
  eventsDuration: 5, // Upcoming zone, per event card
  tickerSpeed: 30, // news ticker, pixels per second
  tickerEnabled: true, // news ticker on/off, from /control
  fullscreen: { ...DEFAULT_FULLSCREEN },
};

// JPG/PNG + video entries from fullscreen_img/. Used by /control's picker
// and by the kiosk when mode is fullscreen.
function getFullscreenFiles() {
  let entries = [];
  try {
    entries = fs.readdirSync(getFullscreenDir(), { withFileTypes: true });
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
      if (FULLSCREEN_IMAGE_EXTENSIONS.has(ext)) return { file: name, type: 'image' };
      return null;
    })
    .filter(Boolean);
}

function normalizeFullscreen(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_FULLSCREEN };
  const days = Array.isArray(raw.days)
    ? raw.days.filter((d) => DAY_NAMES.includes(d))
    : [];
  const start = normalizeClock(raw.start) || DEFAULT_FULLSCREEN.start;
  const end = normalizeClock(raw.end) || DEFAULT_FULLSCREEN.end;
  const file = typeof raw.file === 'string' && raw.file.trim() ? raw.file.trim() : null;
  const force = [null, 'on', 'off'].includes(raw.force) ? raw.force : null;
  return { file, start, end, days, force };
}

// Accept "HH:MM" or "HH:MM:SS" from <input type="time">; store HH:MM.
function normalizeClock(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function parseTimeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Webcam schedule windows and per-zone slide durations can't be inferred
// from a folder of files, so they're still hand-curated - via a small,
// git-tracked config file local to each machine, editable by hand or
// through /control (both just read/write this same file). Featured content
// itself stays fully automatic from the Drive sync - only its timing is
// configurable here. Zone content (Upcoming, Recent) is template-based,
// not config-based - each zone reads its own Drive/local data directly.
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { webcamSchedule: [], ...DEFAULT_SETTINGS, fullscreen: { ...DEFAULT_FULLSCREEN } };
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
      fullscreen: normalizeFullscreen(parsed.fullscreen),
    };
  } catch {
    // Malformed config shouldn't take down the Featured playlist - fall
    // back to defaults until it's fixed.
    return { webcamSchedule: [], ...DEFAULT_SETTINGS, fullscreen: { ...DEFAULT_FULLSCREEN } };
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

// Featured playlist is auto-built from whatever's in the synced
// media/<campus>/featured/ cache, rebuilt from disk on every call so a
// Drive sync just shows up with no manual step. Alphabetical order;
// images use mainSlideDuration; videos always play full length.
function getPlaylist() {
  const config = loadConfig();
  return {
    playlist: scanMediaDir(getFeaturedDir(), config.mainSlideDuration),
    webcamSchedule: config.webcamSchedule,
  };
}

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

// Fullscreen auto-schedule: needs a selected file, at least one day, and
// a same-day window (end strictly after start). Uses the wall machine's
// local clock, same as webcam windows.
function isFullscreenScheduled(fullscreen, now = new Date()) {
  if (!fullscreen || !fullscreen.file) return false;
  if (!Array.isArray(fullscreen.days) || fullscreen.days.length === 0) return false;
  if (!HH_MM_RE.test(fullscreen.start) || !HH_MM_RE.test(fullscreen.end)) return false;
  if (parseTimeToMinutes(fullscreen.end) <= parseTimeToMinutes(fullscreen.start)) return false;
  return isWithinWindow(
    { start: fullscreen.start, end: fullscreen.end, days: fullscreen.days },
    now
  );
}

// Resolve the currently configured fullscreen media item (or null if the
// chosen file is missing / unrecognized after a Drive prune).
function getFullscreenMedia(fullscreen) {
  if (!fullscreen || !fullscreen.file) return null;
  const match = getFullscreenFiles().find((f) => f.file === fullscreen.file);
  return match || null;
}

module.exports = {
  getMediaDir,
  getCampusDir,
  getFeaturedDir,
  getRecentDir,
  getFullscreenDir,
  getFullscreenFiles,
  getFullscreenMedia,
  getPlaylist,
  getRecentEvents,
  getRecentSlides,
  getUpcomingEvents,
  getNewsTickerText,
  loadConfig,
  updateSettings,
  isWebcamScheduled,
  isFullscreenScheduled,
  isWithinWindow,
  DAY_NAMES,
  HH_MM_RE,
  normalizeClock,
  parseTimeToMinutes,
};
