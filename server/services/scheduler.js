const cron = require('node-cron');
const { syncDriveFolder } = require('./driveSync');
const { fetchPrayers } = require('./prayerSync');
const { loadConfig } = require('./playlist');
const { computeMode, shouldSyncAt } = require('./hours');
const { state } = require('../state');

function currentMode() {
  if (state.overrides.devShowDashboard) return 'playlist';
  return computeMode(loadConfig());
}

function startScheduler() {
  // Drive + prayer refresh: one minute tick, fire only when the current
  // sync-schedule interval says so (default: every 15 min Sun 8:10–2pm,
  // every 3 hours the rest of the week). Check Now on /control still
  // bypasses this.
  cron.schedule('* * * * *', () => {
    if (shouldSyncAt(loadConfig().syncSchedule)) {
      syncDriveFolder();
      fetchPrayers();
    }
  });

  // Hours evaluation (fullscreen / manual / dashboard / black). Checked
  // frequently so schedule cutovers feel prompt.
  cron.schedule('*/10 * * * * *', () => {
    state.mode = currentMode();
  });

  // Prime state immediately instead of waiting for the first tick.
  state.mode = currentMode();

  // Kick an initial sync at boot so the media cache isn't empty after a
  // crash/reboot recovery.
  syncDriveFolder();
  fetchPrayers();
}

module.exports = { startScheduler, computeMode: currentMode };
