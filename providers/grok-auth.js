// Keeps the Grok CLI's OAuth token fresh.
//
// `grok login` (sign in with X) writes ~/.grok/auth.json with a 6-hour access token and a
// refresh token issued by auth.x.ai, which is a standard OIDC provider. The Grok CLI only
// refreshes when it runs, and codexbar-cli never refreshes, so without this the Grok card
// would go stale a few hours after each login. We do the refresh_token grant ourselves and
// write the result back so both the CLI and codexbar pick it up.

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const TOKEN_ENDPOINT = 'https://auth.x.ai/oauth2/token';
const REFRESH_AHEAD_MS = 15 * 60 * 1000;  // refresh when <15 min of validity remains

function authPath() {
  const home = (process.env.GROK_HOME || '').trim();
  return path.join(home || path.join(os.homedir(), '.grok'), 'auth.json');
}

// The X-login entry is keyed "https://auth.x.ai::<client_id>"
function findOidcEntry(root) {
  for (const [scope, value] of Object.entries(root)) {
    if (value && typeof value === 'object' && (scope.startsWith('https://auth.x.ai::') || value.auth_mode === 'oidc')) {
      return { scope, entry: value };
    }
  }
  return null;
}

function postForm(url, params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'AI-Tray/1.0',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

// Returns { refreshed: bool, expiresAt, error? }. `force` ignores the expiry check.
// `beforeWrite` lets the caller suppress its own file watcher around our write.
async function ensureFreshToken({ force = false, beforeWrite = null } = {}) {
  const file = authPath();
  let root;
  try { root = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { refreshed: false, error: 'auth.json missing' }; }

  const found = findOidcEntry(root);
  if (!found) return { refreshed: false, error: 'no X/OIDC login in auth.json' };
  const { entry } = found;

  const expiresAt = entry.expires_at ? Date.parse(entry.expires_at) : 0;
  if (!force && expiresAt && Date.now() < expiresAt - REFRESH_AHEAD_MS) {
    return { refreshed: false, expiresAt };
  }
  if (!entry.refresh_token) return { refreshed: false, expiresAt, error: 'no refresh_token' };

  const clientId = entry.oidc_client_id || found.scope.split('::')[1];
  const issuer = (entry.oidc_issuer || 'https://auth.x.ai').replace(/\/$/, '');
  const endpoint = issuer === 'https://auth.x.ai' ? TOKEN_ENDPOINT : `${issuer}/oauth2/token`;

  let res;
  try {
    res = await postForm(endpoint, {
      grant_type: 'refresh_token',
      refresh_token: entry.refresh_token,
      client_id: clientId,
    });
  } catch (e) {
    return { refreshed: false, expiresAt, error: `refresh request failed: ${e.message}` };
  }
  if (res.status !== 200 || !res.body || !res.body.access_token) {
    const detail = typeof res.body === 'object' ? (res.body.error_description || res.body.error || '') : String(res.body).slice(0, 120);
    return { refreshed: false, expiresAt, error: `refresh rejected (${res.status}) ${detail}`.trim() };
  }

  const now = Date.now();
  const newExpiry = new Date(now + (res.body.expires_in || 6 * 3600) * 1000).toISOString();
  entry.key = res.body.access_token;
  if (res.body.refresh_token) entry.refresh_token = res.body.refresh_token;
  entry.expires_at = newExpiry;

  // Atomic write so a concurrent `grok` process never sees a half-written file
  if (beforeWrite) beforeWrite();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(root, null, 2));
  fs.renameSync(tmp, file);
  return { refreshed: true, expiresAt: now + (res.body.expires_in || 6 * 3600) * 1000 };
}

module.exports = { ensureFreshToken, authPath };
