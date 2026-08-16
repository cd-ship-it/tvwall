const express = require('express');
const path = require('path');
const {
  getPlaylist,
  getFullscreenFiles,
  loadConfig,
  updateSettings,
} = require('../services/playlist');
const {
  validateRegularHours,
  validateManual,
  validateFullscreen,
  validateSyncSchedule,
  describeNow,
  describeSyncCadence,
  wallClock,
  weekPreview,
} = require('../services/hours');
const { state, setOverride, skipToItem, requestReload } = require('../state');
const { syncDriveFolder } = require('../services/driveSync');
const { fetchPrayers } = require('../services/prayerSync');
const { regenerateZoneCss } = require('../services/zonePositions');
const { requireAuth } = require('../middleware/auth');
const { computeMode } = require('../services/scheduler');

const router = express.Router();

// Protects everything mounted under /control - reachable over Tailscale,
// not just localhost, so it can't be left open (PRD section 9).
router.use(requireAuth);

router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'control.html'));
});

router.get('/api/status', (req, res) => {
  const playlist = getPlaylist();
  const config = loadConfig();
  const now = new Date();
  let display = describeNow(config, now);
  if (state.overrides.devShowDashboard) {
    display = {
      ...display,
      mode: 'playlist',
      label: 'Dashboard (dev)',
      untilLabel: 'until you refresh /control',
      showingLine: 'Wall is showing Dashboard (dev) until you refresh /control',
    };
  }
  res.json({
    mode: state.mode,
    skip: state.skip,
    sync: state.sync,
    zoneScan: state.zoneScan,
    prayers: state.prayers,
    playlist: playlist.playlist,
    fullscreenFiles: getFullscreenFiles(),
    fullscreen: config.fullscreen,
    regularHours: config.regularHours,
    manual: config.manual,
    syncSchedule: config.syncSchedule,
    syncCadence: describeSyncCadence(config.syncSchedule, now),
    devShowDashboard: !!state.overrides.devShowDashboard,
    wallClock: wallClock(now),
    display,
    weekPreview: weekPreview(config, now),
    settings: {
      mainSlideDuration: config.mainSlideDuration,
      recentRoundDuration: config.recentRoundDuration,
      eventsDuration: config.eventsDuration,
      prayersDuration: config.prayersDuration,
      tickerSpeed: config.tickerSpeed,
      tickerEnabled: config.tickerEnabled,
    },
  });
});

router.post('/api/settings', express.json(), (req, res) => {
  const { mainSlideDuration, recentRoundDuration, eventsDuration, prayersDuration, tickerSpeed } = req.body;
  const patch = {};

  for (const [key, value] of Object.entries({
    mainSlideDuration,
    recentRoundDuration,
    eventsDuration,
    prayersDuration,
    tickerSpeed,
  })) {
    if (value === undefined) continue;
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) {
      return res.status(400).json({ error: `${key} must be a positive number` });
    }
    patch[key] = num;
  }

  const config = updateSettings(patch);
  res.json({
    ok: true,
    settings: {
      mainSlideDuration: config.mainSlideDuration,
      recentRoundDuration: config.recentRoundDuration,
      eventsDuration: config.eventsDuration,
      prayersDuration: config.prayersDuration,
      tickerSpeed: config.tickerSpeed,
      tickerEnabled: config.tickerEnabled,
    },
  });
});

router.post('/api/ticker', express.json(), (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be true or false' });
  }
  const config = updateSettings({ tickerEnabled: enabled });
  res.json({ ok: true, tickerEnabled: config.tickerEnabled });
});

// In-memory debug override. Not written to wall-config.json. Cleared when
// the /control page loads (and on process restart).
router.post('/api/dev-dashboard', express.json(), (req, res) => {
  if (typeof req.body.enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be true or false' });
  }
  setOverride({ devShowDashboard: req.body.enabled });
  state.mode = computeMode();
  const config = loadConfig();
  res.json({
    ok: true,
    devShowDashboard: !!state.overrides.devShowDashboard,
    mode: state.mode,
    display: state.overrides.devShowDashboard
      ? {
          ...describeNow(config),
          mode: 'playlist',
          label: 'Dashboard (dev)',
          untilLabel: 'until you refresh /control',
          showingLine: 'Wall is showing Dashboard (dev) until you refresh /control',
        }
      : describeNow(config),
  });
});

router.post('/api/sync-schedule', express.json(), (req, res) => {
  const result = validateSyncSchedule(req.body);
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }
  const config = updateSettings({ syncSchedule: result.syncSchedule });
  res.json({
    ok: true,
    syncSchedule: config.syncSchedule,
    syncCadence: describeSyncCadence(config.syncSchedule),
  });
});

router.post('/api/regular-hours', express.json(), (req, res) => {
  const result = validateRegularHours(req.body.windows);
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }
  const config = updateSettings({ regularHours: result.windows });
  state.mode = computeMode();
  res.json({
    ok: true,
    regularHours: config.regularHours,
    mode: state.mode,
    display: describeNow(config),
    weekPreview: weekPreview(config),
  });
});

router.post('/api/manual', express.json(), (req, res) => {
  const result = validateManual(req.body);
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }
  const config = updateSettings({ manual: result.manual });
  state.mode = computeMode();
  res.json({
    ok: true,
    manual: config.manual,
    mode: state.mode,
    display: describeNow(config),
    weekPreview: weekPreview(config),
  });
});

// One-shot fullscreen window. File must exist on disk; both datetimes required.
router.post('/api/fullscreen', express.json(), (req, res) => {
  const availableNames = new Set(getFullscreenFiles().map((f) => f.file));
  const result = validateFullscreen(req.body, availableNames);
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }
  const config = updateSettings({
    fullscreen: {
      ...loadConfig().fullscreen,
      ...result.fullscreen,
    },
  });
  state.mode = computeMode();
  res.json({
    ok: true,
    fullscreen: config.fullscreen,
    mode: state.mode,
    display: describeNow(config),
    weekPreview: weekPreview(config),
  });
});

// Wipe the one-shot window; Regular Hours / Manual / black take over immediately.
router.post('/api/fullscreen-cancel', express.json(), (req, res) => {
  const current = loadConfig().fullscreen;
  const config = updateSettings({
    fullscreen: {
      ...current,
      startAt: null,
      endAt: null,
    },
  });
  state.mode = computeMode();
  res.json({
    ok: true,
    fullscreen: config.fullscreen,
    mode: state.mode,
    display: describeNow(config),
    weekPreview: weekPreview(config),
  });
});

router.post('/api/skip', express.json(), (req, res) => {
  const { index } = req.body;
  const playlist = getPlaylist().playlist;
  if (!Number.isInteger(index) || index < 0 || index >= playlist.length) {
    return res.status(400).json({ error: 'index out of range' });
  }
  skipToItem(index);
  res.json({ ok: true, skip: state.skip });
});

router.post('/api/sync-now', async (req, res) => {
  await syncDriveFolder();
  res.json({ ok: true, sync: state.sync });
});

// Manual re-fetch of crosspointchurchsv.org/weekly-prayer for the Prayers
// zone - same "Check Now" pattern as Drive sync above, for pulling a
// freshly-posted update immediately instead of waiting for the next
// scheduled tick.
router.post('/api/prayers-sync-now', async (req, res) => {
  const result = await fetchPrayers();
  res.json({ ok: result.ok, error: result.error, prayers: state.prayers });
});

// Manual-only trigger for the green-box template scan (see server/index.js
// for why this isn't automatic on boot). Synchronous and fast (a single
// local JPEG decode), so no need for the async/"in progress" treatment
// sync-now gets.
router.post('/api/scan-template', (req, res) => {
  const result = regenerateZoneCss();
  res.json({ ok: result.ok, error: result.error, zoneScan: state.zoneScan });
});

// Tells the kiosk page to reload itself on its next poll - picks up changed
// HTML/CSS/JS (e.g. after a git pull) without restarting Chrome over SSH.
router.post('/api/reload-display', (req, res) => {
  requestReload();
  res.json({ ok: true, reload: state.reload });
});

// Exits the process so the supervisor starts a fresh one, which is how new
// server-side code gets picked up after a git pull. Under pm2 that's autorestart
// (with deploy/kiosk's LaunchAgent watchdog as a backstop); under nodemon a
// clean exit just stops, so the response says which case applies.
router.post('/api/restart-server', (req, res) => {
  const supervised = !!process.env.pm_id;
  res.json({ ok: true, supervised });
  // Let the response flush before tearing the process down.
  setTimeout(() => {
    console.log('restart requested from /control - exiting for supervisor restart');
    process.exit(0);
  }, 250);
});

module.exports = router;
