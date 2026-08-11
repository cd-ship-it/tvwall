const cron = require('node-cron');
const { syncDriveFolder } = require('./driveSync');
const { getPlaylist, isWebcamScheduled } = require('./playlist');
const { state } = require('../state');

function computeMode() {
  const { webcamSchedule } = getPlaylist();
  const { webcamForce } = state.overrides;

  if (webcamForce === 'on') return 'webcam';
  if (webcamForce === 'off') return 'playlist';
  return isWebcamScheduled(webcamSchedule) ? 'webcam' : 'playlist';
}

function startScheduler() {
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

  // Webcam schedule window evaluation, per PRD section 6: node-cron
  // evaluates the schedule. Checked frequently so cutovers feel prompt.
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
