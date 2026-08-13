#!/usr/bin/env node
// Manual entry point - `npm run scan-template`. Scanning is manual-only
// (see server/index.js) - this is the CLI equivalent of the "Scan
// Template" button on /control, for checking the result without booting
// the whole server.
const { regenerateZoneCss } = require('../server/services/zonePositions');

const result = regenerateZoneCss();
process.exit(result.ok ? 0 : 1);
