const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const CREDENTIALS_DIR = path.join(__dirname, '..', '..', 'credentials');
const CLIENT_SECRET_PATH = path.join(CREDENTIALS_DIR, 'client_secret.json');
const TOKEN_PATH = path.join(CREDENTIALS_DIR, 'drive_token.json');

// Re-uses the OAuth client + refresh token already generated for the
// crosspointchurchsv "heart" project (see ../heart/scripts/google_oauth.py).
// The stored token already carries drive scope, so no fresh consent screen
// is needed here.
function getDriveClient() {
  if (!fs.existsSync(CLIENT_SECRET_PATH) || !fs.existsSync(TOKEN_PATH)) {
    throw new Error(
      `Missing Google credentials. Expected ${CLIENT_SECRET_PATH} and ${TOKEN_PATH}.`
    );
  }

  const clientSecretFile = JSON.parse(fs.readFileSync(CLIENT_SECRET_PATH, 'utf8'));
  const clientConfig = clientSecretFile.installed || clientSecretFile.web;
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));

  const oAuth2Client = new google.auth.OAuth2(
    clientConfig.client_id,
    clientConfig.client_secret,
    (clientConfig.redirect_uris && clientConfig.redirect_uris[0]) || 'urn:ietf:wg:oauth:2.0:oob'
  );

  oAuth2Client.setCredentials({
    refresh_token: token.refresh_token,
    access_token: token.token || token.access_token,
    scope: Array.isArray(token.scopes) ? token.scopes.join(' ') : token.scope,
    expiry_date: token.expiry ? new Date(token.expiry).getTime() : undefined,
  });

  // Persist refreshed access tokens back to disk so restarts don't need a
  // full re-auth (refresh_token stays valid regardless).
  oAuth2Client.on('tokens', (tokens) => {
    if (tokens.refresh_token || tokens.access_token) {
      const merged = { ...token, ...tokens };
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
    }
  });

  return google.drive({ version: 'v3', auth: oAuth2Client });
}

module.exports = { getDriveClient };
