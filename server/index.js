require('dotenv').config();
const express = require('express');
const path = require('path');

const { startScheduler } = require('./services/scheduler');
const { getCampusDir } = require('./services/playlist');
const apiRoutes = require('./routes/api');
const controlRoutes = require('./routes/control');
const uploadRoutes = require('./routes/upload');

// The green-box template scan (public/zone-positions.css) is intentionally
// NOT run automatically on boot - "wall box positions.jpg" only changes a
// few times a year, so re-scanning on every `npm start`/nodemon
// restart/pm2 restart just risked clobbering hand-tuned CSS for no reason.
// Trigger it manually instead: the "Scan Template" button on /control (see
// routes/control.js), or `npm run scan-template` from the CLI. Until the
// first scan, or if public/zone-positions.css doesn't exist yet, the
// hardcoded fallback values at the top of public/style.css apply.

const app = express();
const PORT = process.env.PORT || 3000;

app.use('/api', apiRoutes);
app.use('/control', controlRoutes);
app.use('/upload', uploadRoutes);

// Local media cache, served so the kiosk page can play files directly
// (playback always reads from local disk, never live from Drive). Scoped
// to this machine's campus - /media/featured/x.jpg resolves to
// media/<campus>/featured/x.jpg on disk.
app.use('/media', express.static(getCampusDir()));

// Visible background art lives at the repo root (single source of truth) -
// served directly from there so replacing it never requires a manual copy
// into public/ that can go stale. Deliberately a *separate* file from
// "wall box positions.jpg" (which stays green-box-only and is never
// displayed) - see zonePositions.js. If this file hasn't been dropped in
// yet, respond with no content rather than an Express error page; .wall's
// CSS background-color fallback covers the gap until it exists.
const WALL_BACKGROUND_PATH = path.join(__dirname, '..', 'wall_background.jpg');
app.get('/assets/wall-background.jpg', (req, res) => {
  res.sendFile(WALL_BACKGROUND_PATH, (err) => {
    if (err) res.status(204).end();
  });
});

// Kiosk display + dev tools (test pattern, six-panel simulator).
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log(`TV Wall server listening on http://localhost:${PORT}`);
  console.log(`Kiosk:      http://localhost:${PORT}/`);
  console.log(`Simulator:  http://localhost:${PORT}/simulator.html`);
  console.log(`Test grid:  http://localhost:${PORT}/test-pattern.html`);
  console.log(`Control:    http://localhost:${PORT}/control`);
  startScheduler();
});
