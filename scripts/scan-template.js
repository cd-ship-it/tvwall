#!/usr/bin/env node
// Manual/debug entry point - `npm run scan-template`. The same scan also
// runs automatically on every server start (see server/index.js), so this
// is only needed to check the result without booting the whole server.
const { regenerateZoneCss } = require('../server/services/zonePositions');

const result = regenerateZoneCss();
process.exit(result.ok ? 0 : 1);
