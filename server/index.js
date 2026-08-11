require('dotenv').config();
const express = require('express');
const path = require('path');

const { startScheduler } = require('./services/scheduler');
const { getCampusDir } = require('./services/playlist');
const { regenerateZoneCss } = require('./services/zonePositions');
const apiRoutes = require('./routes/api');
const controlRoutes = require('./routes/control');
const uploadRoutes = require('./routes/upload');

// Rescan wall_template_default.jpg for the current green-box positions on
// every boot - covers `npm start`, every nodemon dev-restart (including
// ones triggered by replacing the template file itself), and pm2 restarts
// on the production Mac Mini. Non-fatal on failure (see zonePositions.js).
regenerateZoneCss();

const app = express();
const PORT = process.env.PORT || 3000;

app.use('/api', apiRoutes);
app.use('/control', controlRoutes);
app.use('/upload', uploadRoutes);

// Local media cache, served so the kiosk page can play files directly
// (playback always reads from local disk, never live from Drive). Scoped
// to this machine's campus - /media/main/x.jpg resolves to
// media/<campus>/main/x.jpg on disk.
app.use('/media', express.static(getCampusDir()));

// Background template lives at the repo root (single source of truth) -
// served directly from there so replacing it never requires a manual copy
// into public/ that can go stale.
app.get('/assets/wall-background.jpg', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'wall_template_default.jpg'));
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
