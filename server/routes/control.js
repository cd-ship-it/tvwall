const express = require('express');
const path = require('path');
const { getPlaylist, loadConfig, updateSettings } = require('../services/playlist');
const { state, setOverride, skipToItem } = require('../state');
const { syncDriveFolder } = require('../services/driveSync');
const { regenerateZoneCss } = require('../services/zonePositions');
const { requireAuth } = require('../middleware/auth');

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
  res.json({
    mode: state.mode,
    overrides: state.overrides,
    skip: state.skip,
    sync: state.sync,
    zoneScan: state.zoneScan,
    webcam: state.webcam,
    playlist: playlist.playlist,
    webcamSchedule: playlist.webcamSchedule,
    settings: {
      mainSlideDuration: config.mainSlideDuration,
      recentRoundDuration: config.recentRoundDuration,
      eventsDuration: config.eventsDuration,
      tickerSpeed: config.tickerSpeed,
      tickerEnabled: config.tickerEnabled,
    },
  });
});

router.post('/api/settings', express.json(), (req, res) => {
  const { mainSlideDuration, recentRoundDuration, eventsDuration, tickerSpeed } = req.body;
  const patch = {};

  for (const [key, value] of Object.entries({ mainSlideDuration, recentRoundDuration, eventsDuration, tickerSpeed })) {
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

router.post('/api/webcam', express.json(), (req, res) => {
  const { force } = req.body; // 'on' | 'off' | null
  if (![null, 'on', 'off'].includes(force)) {
    return res.status(400).json({ error: "force must be 'on', 'off', or null" });
  }
  setOverride({ webcamForce: force });
  res.json({ ok: true, overrides: state.overrides });
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

// Manual-only trigger for the green-box template scan (see server/index.js
// for why this isn't automatic on boot). Synchronous and fast (a single
// local JPEG decode), so no need for the async/"in progress" treatment
// sync-now gets.
router.post('/api/scan-template', (req, res) => {
  const result = regenerateZoneCss();
  res.json({ ok: result.ok, error: result.error, zoneScan: state.zoneScan });
});

module.exports = router;
