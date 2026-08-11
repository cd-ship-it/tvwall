const crypto = require('crypto');
const basicAuth = require('basic-auth');

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Shared by /control and /upload - both can change what's showing on the
// public display, and both are reachable over Tailscale, not just
// localhost, so neither can be left open.
function requireAuth(req, res, next) {
  const creds = basicAuth(req);
  const user = process.env.CONTROL_USER || 'admin';
  const pass = process.env.CONTROL_PASSWORD || 'changeme';

  if (!creds || !timingSafeEqual(creds.name, user) || !timingSafeEqual(creds.pass, pass)) {
    res.set('WWW-Authenticate', 'Basic realm="TV Wall Control"');
    return res.status(401).send('Authentication required');
  }
  next();
}

module.exports = { requireAuth };
