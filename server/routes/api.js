const express = require('express');
const { getPlaylist, getRecentItems, getUpcomingEvents, getNewsTickerText, loadConfig } = require('../services/playlist');
const { state } = require('../state');

const router = express.Router();

// Polled by the kiosk frontend (and each of the six simulator iframes) to
// find out what should currently be showing.
router.get('/state', (req, res) => {
  const playlist = getPlaylist();
  const config = loadConfig();
  res.json({
    mode: state.mode,
    playlist: playlist.playlist,
    recent: getRecentItems(),
    events: getUpcomingEvents(),
    eventsDuration: config.eventsDuration,
    tickerText: getNewsTickerText(),
    tickerSpeed: config.tickerSpeed,
    tickerEnabled: config.tickerEnabled,
    skip: state.skip,
    sync: state.sync,
  });
});

// The kiosk client reports webcam capture health here since only the
// browser (via getUserMedia) knows whether the device is actually working.
router.post('/webcam-status', express.json(), (req, res) => {
  state.webcam.connected = !!req.body.connected;
  state.webcam.lastReportAt = new Date().toISOString();
  res.json({ ok: true });
});

module.exports = router;
