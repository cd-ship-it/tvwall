// Shared in-memory runtime state. Single process, single kiosk instance,
// so a plain module-level object is enough - no need for a DB.

const state = {
  // Google Drive sync status, surfaced on /control for troubleshooting.
  sync: {
    lastSyncAt: null,
    lastSyncOk: null,
    lastSyncError: null,
    inProgress: false,
    filesSynced: 0,
    filesPruned: 0,
  },

  // Green-box template scan status, surfaced on /control. Scanning is
  // manual-only (triggered from the control panel or `npm run
  // scan-template`) - see server/index.js - since it only needs to run
  // when wall_template_default.jpg itself changes, a few times a year.
  zoneScan: {
    lastScanAt: null,
    lastScanOk: null,
    lastScanError: null,
    zones: null, // { middle: {w,h}, left: {w,h}, right: {w,h} }
  },

  // Operator overrides from /control. Null means "no override, follow
  // playlist.json schedule normally."
  overrides: {
    webcamForce: null, // 'on' | 'off' | null
  },

  // Current mode as last computed by the scheduler: 'webcam' | 'playlist'.
  mode: 'playlist',

  // Bumped on every "skip to item" command from /control. The kiosk client
  // compares this against the last value it saw to detect a fresh skip
  // (as opposed to re-reading the same lingering index on a normal poll).
  skip: {
    index: null,
    nonce: 0,
  },

  webcam: {
    // Last known status reported by the kiosk client itself (server can't
    // see the USB device; the browser does the capture).
    connected: null,
    lastReportAt: null,
  },
};

function setSyncStatus(patch) {
  Object.assign(state.sync, patch);
}

function setZoneScanStatus(patch) {
  Object.assign(state.zoneScan, patch);
}

function setOverride(patch) {
  Object.assign(state.overrides, patch);
}

function skipToItem(index) {
  state.skip.index = index;
  state.skip.nonce += 1;
}

module.exports = { state, setSyncStatus, setZoneScanStatus, setOverride, skipToItem };
