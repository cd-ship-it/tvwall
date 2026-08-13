const cron = require('node-cron');
const { syncDriveFolder } = require('./driveSync');
const { getPlaylist, loadConfig, isWebcamScheduled, isFullscreenScheduled } = require('./playlist');
const { state, setOverride } = require('../state');

// Priority: fullscreen (force on / schedule) always beats webcam and the
// normal dashboard. Force-off suppresses the fullscreen schedule only.
function computeMode() {
  const config = loadConfig();
  const { webcamSchedule } = getPlaylist();
  const { webcamForce, fullscreenForce } = state.overrides;

  if (fullscreenForce === 'on') return 'fullscreen';
  if (fullscreenForce !== 'off' && isFullscreenScheduled(config.fullscreen)) {
    return 'fullscreen';
  }

  if (webcamForce === 'on') return 'webcam';
  if (webcamForce === 'off') return 'playlist';
  return isWebcamScheduled(webcamSchedule) ? 'webcam' : 'playlist';
}

function startScheduler() {
  // Restore persisted fullscreen force before the first mode compute so a
  // Force On still applies after nodemon/pm2 restart.
  const boot = loadConfig();
  if (boot.fullscreen && ['on', 'off'].includes(boot.fullscreen.force)) {
    setOverride({ fullscreenForce: boot.fullscreen.force });
  } else if (boot.fullscreen && boot.fullscreen.force === null) {
    setOverride({ fullscreenForce: null });
  }

  // Drive sync: every minute, but only act on it every 15 min normally,
  // every 1 min on Sundays. A single cron tick keeps the two cadences from
  // fighting over the same job.
  cron.schedule('* * * * *', () => {
    const now = new Date();
    const isSunday = now.getDay() === 0;
    if (isSunday || now.getMinutes() % 15 === 0) {
      syncDriveFolder();
    }
  });

  // Mode evaluation (fullscreen / webcam / playlist). Checked frequently
  // so schedule cutovers feel prompt.
  cron.schedule('*/10 * * * * *', () => {
    state.mode = computeMode();
  });

  // Prime state immediately instead of waiting for the first tick.
  state.mode = computeMode();

  // Kick an initial sync at boot so the media cache isn't empty after a
  // crash/reboot recovery.
  syncDriveFolder();
}

module.exports = { startScheduler, computeMode };
