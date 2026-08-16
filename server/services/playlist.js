const fs = require('fs');
const path = require('path');

const MEDIA_DIR = path.join(__dirname, '..', '..', 'media');
// Lives in the repo root, not the Drive-synced media cache - this is
// hand-edited directly on whichever machine (dev or the Mac Mini) and
// tracked in git, not treated as Drive content.
const CONFIG_PATH = path.join(__dirname, '..', '..', 'wall-config.json');

const {
  DEFAULT_REGULAR_HOURS,
  DEFAULT_MANUAL,
  DEFAULT_FULLSCREEN,
  DEFAULT_SYNC_SCHEDULE,
  normalizeRegularHours,
  normalizeManual,
  normalizeFullscreen,
  normalizeSyncSchedule,
} = require('./hours');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
// Fullscreen override accepts JPG/PNG + video only (no gif/webp).
const FULLSCREEN_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);
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
// folder of the same name under the campus). Covers the whole wall during
// a one-shot start/end datetime from /control.
function getFullscreenDir() {
  return path.join(getCampusDir(), 'fullscreen_img');
}

// media/<campus>/prayers-cache.json - local cache of the last successful
// scrape of crosspointchurchsv.org/weekly-prayer (see prayerSync.js). Not
// Drive content, but cached per-campus anyway for architectural
// consistency (each Mac Mini is a self-contained process) even though the
// source page is the same for every campus.
function getPrayersCachePath() {
  return path.join(getCampusDir(), 'prayers-cache.json');
}

// Scans a zone directory (and any nested folders the Drive mirror created)
// into { file, type, duration? } entries. `file` is relative to `dir` so
// nested items stay addressable as e.g. "camp/01.jpg". `imageDuration`
// (seconds) is applied to every image found - videos ignore it and always
// play their natural length. `imageExts` lets fullscreen restrict to
// JPG/PNG while featured/recent keep the wider image set.
function scanMediaDir(dir, imageDuration, relBase = '', imageExts = IMAGE_EXTENSIONS) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const items = [];
  for (const entry of entries) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      items.push(...scanMediaDir(path.join(dir, entry.name), imageDuration, rel, imageExts));
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.startsWith('.') || IGNORED_FILES.has(entry.name.toLowerCase())) continue;
    if (entry.name.toLowerCase().endsWith('.part')) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (VIDEO_EXTENSIONS.has(ext)) {
      items.push({ file: rel, type: 'video' });
    } else if (imageExts.has(ext)) {
      const item = { file: rel, type: 'image' };
      if (imageDuration != null) item.duration = imageDuration;
      items.push(item);
    }
  }
  items.sort((a, b) => a.file.localeCompare(b.file));
  return items;
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

// Prayers zone (right, below Recent) - reads the cache prayerSync.js
// writes, same "external process writes it, we just read it on every
// call" pattern as events.json/newsticker. Slide order: every Chinese
// item (source order), then every English item (source order); the
// combined list is what loops. Missing/never-fetched cache -> comingSoon,
// same empty-state treatment as Recent.
function loadPrayersCache() {
  const filePath = getPrayersCachePath();
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function getPrayerSlides() {
  const config = loadConfig();
  const cache = loadPrayersCache();
  const zhItems = cache && cache.zh && Array.isArray(cache.zh.items) ? cache.zh.items : [];
  const enItems = cache && cache.en && Array.isArray(cache.en.items) ? cache.en.items : [];
  const slides = [
    ...zhItems.map((text) => ({ lang: 'zh', text })),
    ...enItems.map((text) => ({ lang: 'en', text })),
  ];

  return {
    slides,
    comingSoon: slides.length === 0,
    date: cache ? cache.date : null,
    duration: config.prayersDuration,
  };
}

const DEFAULT_SETTINGS = {
  mainSlideDuration: DEFAULT_SLIDE_DURATION, // Featured zone, per image
  recentRoundDuration: DEFAULT_SLIDE_DURATION, // Recent zone, per photo
  eventsDuration: 5, // Upcoming zone, per event card
  prayersDuration: 10, // Prayers zone, per bullet item
  tickerSpeed: 30, // news ticker, pixels per second
  tickerEnabled: true, // news ticker on/off, from /control
  regularHours: DEFAULT_REGULAR_HOURS.map((w) => ({ days: [...w.days], start: w.start, end: w.end })),
  manual: { ...DEFAULT_MANUAL },
  fullscreen: { ...DEFAULT_FULLSCREEN },
  syncSchedule: {
    defaultIntervalMinutes: DEFAULT_SYNC_SCHEDULE.defaultIntervalMinutes,
    windows: DEFAULT_SYNC_SCHEDULE.windows.map((w) => ({
      days: [...w.days],
      start: w.start,
      end: w.end,
      intervalMinutes: w.intervalMinutes,
    })),
  },
};

// JPG/PNG + video entries from fullscreen_img/ (including nested folders
// the Drive mirror created). Used by /control's picker and by the kiosk
// when mode is fullscreen.
function getFullscreenFiles() {
  return scanMediaDir(getFullscreenDir(), null, '', FULLSCREEN_IMAGE_EXTENSIONS);
}

// Per-zone slide durations and wall hours live in a small, git-tracked
// config file local to each machine, editable by hand or through /control.
// Featured content itself stays fully automatic from the Drive sync - only
// its timing is configurable here. Zone content (Upcoming, Recent) is
// template-based, not config-based - each zone reads its own Drive/local
// data directly.
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {
      ...DEFAULT_SETTINGS,
      regularHours: DEFAULT_REGULAR_HOURS.map((w) => ({ days: [...w.days], start: w.start, end: w.end })),
      manual: { ...DEFAULT_MANUAL },
      fullscreen: { ...DEFAULT_FULLSCREEN },
      syncSchedule: normalizeSyncSchedule(undefined),
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      mainSlideDuration: Number(parsed.mainSlideDuration) > 0 ? Number(parsed.mainSlideDuration) : DEFAULT_SETTINGS.mainSlideDuration,
      recentRoundDuration:
        Number(parsed.recentRoundDuration) > 0 ? Number(parsed.recentRoundDuration) : DEFAULT_SETTINGS.recentRoundDuration,
      eventsDuration: Number(parsed.eventsDuration) > 0 ? Number(parsed.eventsDuration) : DEFAULT_SETTINGS.eventsDuration,
      prayersDuration: Number(parsed.prayersDuration) > 0 ? Number(parsed.prayersDuration) : DEFAULT_SETTINGS.prayersDuration,
      tickerSpeed: Number(parsed.tickerSpeed) > 0 ? Number(parsed.tickerSpeed) : DEFAULT_SETTINGS.tickerSpeed,
      tickerEnabled: typeof parsed.tickerEnabled === 'boolean' ? parsed.tickerEnabled : DEFAULT_SETTINGS.tickerEnabled,
      regularHours: normalizeRegularHours(parsed.regularHours),
      manual: normalizeManual(parsed.manual),
      fullscreen: normalizeFullscreen(parsed.fullscreen),
      syncSchedule: normalizeSyncSchedule(parsed.syncSchedule),
    };
  } catch {
    // Malformed config shouldn't take down the Featured playlist - fall
    // back to defaults until it's fixed.
    return {
      ...DEFAULT_SETTINGS,
      regularHours: DEFAULT_REGULAR_HOURS.map((w) => ({ days: [...w.days], start: w.start, end: w.end })),
      manual: { ...DEFAULT_MANUAL },
      fullscreen: { ...DEFAULT_FULLSCREEN },
      syncSchedule: normalizeSyncSchedule(undefined),
    };
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
  };
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
  getPrayersCachePath,
  getPrayerSlides,
  loadConfig,
  updateSettings,
};
