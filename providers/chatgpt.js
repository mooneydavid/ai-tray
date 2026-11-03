// ChatGPT / Codex usage, read with the login the Codex CLI saves in ~/.codex/auth.json.
//
// Ported from Win-CodexBar (https://github.com/nesszer/Win-CodexBar, MIT), which in turn
// follows CodexBar by Peter Steinberger. Like them, this only reads the login: the Codex CLI
// owns it and renews it whenever `codex` runs.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api';

function codexDir() {
  const home = (process.env.CODEX_HOME || '').trim();
  return home || path.join(os.homedir(), '.codex');
}

function authPath() {
  return path.join(codexDir(), 'auth.json');
}

// config.toml may point the CLI at another ChatGPT host; only HTTPS is accepted
function baseUrl() {
  try {
    const toml = fs.readFileSync(path.join(codexDir(), 'config.toml'), 'utf8');
    for (const raw of toml.split('\n')) {
      const line = raw.split('#')[0].trim();
      const m = line.match(/^chatgpt_base_url\s*=\s*["']?([^"']+)["']?$/);
      if (!m) continue;
      let url = m[1].trim().replace(/\/+$/, '');
      if (/^https:\/\/(chatgpt\.com|chat\.openai\.com)/.test(url) && !url.includes('/backend-api')) url += '/backend-api';
      if (url.startsWith('https://')) return url;
    }
  } catch (e) {}
  return DEFAULT_BASE_URL;
}

// `exp` claim of a JWT access token, in ms (null for opaque tokens)
function jwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch (e) {
    return null;
  }
}

function loadCredentials() {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(authPath(), 'utf8'));
  } catch (e) {
    return { error: 'Not signed in to Codex on this PC.', needsLogin: true };
  }
  const tokens = json.tokens || {};
  if (!tokens.access_token) return { error: 'Not signed in to Codex on this PC.', needsLogin: true };
  const expiresAt = jwtExpiry(tokens.access_token);
  if (expiresAt && expiresAt <= Date.now()) return { error: 'Codex login expired.', needsLogin: true };
  return { accessToken: tokens.access_token, accountId: tokens.account_id || null };
}

const PLAN_NAMES = {
  free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', pro_lite: 'Pro Lite', prolite: 'Pro Lite',
  team: 'Team', business: 'Business', enterprise: 'Enterprise', education: 'Edu', edu: 'Edu',
};
function planName(raw) {
  if (!raw) return null;
  return PLAN_NAMES[raw] || raw.charAt(0).toUpperCase() + raw.slice(1).replace(/_/g, ' ');
}

function num(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && isFinite(n) ? n : null;
}

// One usage window from the API -> our meter shape (null for empty placeholders)
function toWindow(w) {
  if (!w) return null;
  const pct = num(w.used_percent ?? w.usage_percent);
  const seconds = num(w.limit_window_seconds);
  const reset = num(w.reset_at);
  if (pct === null && seconds === null && reset === null) return null;
  return {
    utilization: Math.max(0, Math.min(100, pct || 0)),
    minutes: seconds ? Math.round(seconds / 60) : null,
    resets_at: reset ? new Date(reset * 1000).toISOString() : null,
  };
}

function label(minutes) {
  if (!minutes) return 'Usage';
  const days = Math.round(minutes / 1440);
  if (minutes <= 24 * 60) return `Session (${Math.round(minutes / 60)}h)`;
  if (days >= 4 && days <= 12) return 'Weekly';
  if (days >= 20 && days <= 45) return 'Monthly';
  return `${days}-day`;
}

// Session window first, then longer ones, whatever order the API used
function parseUsage(json) {
  let windows = [];
  if (json.rate_limit) {
    windows = [toWindow(json.rate_limit.primary_window), toWindow(json.rate_limit.secondary_window)];
  } else if (Array.isArray(json.rate_limits)) {
    windows = json.rate_limits.map(toWindow);
  }
  windows = windows.filter(Boolean).sort((a, b) => (a.minutes || 0) - (b.minutes || 0));
  const meters = windows.map((w, i) => ({
    key: i === 0 ? 'session' : `window${i}`,
    label: label(w.minutes),
    utilization: w.utilization,
    resets_at: w.resets_at,
    minutes: w.minutes,  // window length, for the pace marker
  }));
  if (!meters.length) return { error: 'No usage data yet.' };
  return { meters, plan: planName(json.plan_type) };
}

async function fetchUsage() {
  const creds = loadCredentials();
  if (creds.error) return creds;

  const headers = {
    Authorization: `Bearer ${creds.accessToken}`,
    Accept: 'application/json',
    'User-Agent': 'AI-Tray',
  };
  if (creds.accountId) headers['ChatGPT-Account-Id'] = creds.accountId;

  let res;
  try {
    res = await fetch(`${baseUrl()}/wham/usage`, { headers, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    return { error: (e.cause && e.cause.code) || e.message };
  }
  if (res.status === 401 || res.status === 403) return { error: 'Codex login expired.', needsLogin: true };
  if (res.status === 429) return { error: 'ChatGPT rate limited (429).' };
  if (!res.ok) return { error: `ChatGPT returned ${res.status}` };
  try {
    return parseUsage(await res.json());
  } catch (e) {
    return { error: 'ChatGPT sent an answer AI Tray could not read.' };
  }
}

module.exports = { fetchUsage, authPath, parseUsage };
