// Grok usage, read with the login `grok login` saves in ~/.grok/auth.json.
//
// Uses the Grok CLI's credits endpoint, as worked out by Win-CodexBar
// (https://github.com/nesszer/Win-CodexBar, MIT). grok-auth.js keeps the 6-hour token fresh.

const fs = require('fs');
const grokAuth = require('./grok-auth');

const CREDITS_ENDPOINT = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';

// The X-login entry is keyed "https://auth.x.ai::<client_id>"
function loadLogin() {
  let root;
  try {
    root = JSON.parse(fs.readFileSync(grokAuth.authPath(), 'utf8'));
  } catch (e) {
    return { error: 'Not signed in to Grok on this PC.', needsLogin: true };
  }
  const entry = Object.entries(root).map(([scope, v]) => v && typeof v === 'object' && (scope.startsWith('https://auth.x.ai::') || v.auth_mode === 'oidc') ? v : null).find(Boolean);
  if (!entry || !entry.key) return { error: 'Not signed in to Grok on this PC.', needsLogin: true };
  return { token: entry.key, authMode: entry.auth_mode };
}

function planName(raw) {
  const compact = String(raw || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!compact) return null;
  if (compact === 'supergrokheavy' || compact === 'heavy') return 'SuperGrok Heavy';
  if (compact === 'supergrok') return 'SuperGrok';
  return String(raw).trim();
}

function label(startIso, endIso) {
  const start = Date.parse(startIso), end = Date.parse(endIso);
  const ms = isFinite(start) && isFinite(end) && end > start ? end - start : (isFinite(end) ? end - Date.now() : NaN);
  const days = Math.round(ms / 86400000);
  if (days >= 4 && days <= 12) return 'Weekly';
  if (days >= 20 && days <= 45) return 'Monthly';
  return 'Credits';
}

function parseCredits(json, authMode) {
  const c = json && json.config;
  if (!c) return { error: 'Grok sent an answer AI Tray could not read.' };
  let pct = typeof c.creditUsagePercent === 'number' && isFinite(c.creditUsagePercent) ? c.creditUsagePercent : null;
  if (pct === null && c.onDemandCap && c.onDemandCap.val > 0 && c.onDemandUsed) {
    pct = (c.onDemandUsed.val || 0) / c.onDemandCap.val * 100;
  }
  const period = c.currentPeriod && c.currentPeriod.end ? c.currentPeriod : { start: c.billingPeriodStart, end: c.billingPeriodEnd };
  if (pct === null) return { error: 'No usage data yet.' };
  return {
    meters: [{
      key: 'session',
      label: label(period.start, period.end),
      utilization: Math.max(0, Math.min(100, pct)),
      resets_at: period.end || null,
    }],
    plan: planName(c.subscriptionTier || json.subscriptionTier) || (authMode === 'oidc' ? 'SuperGrok' : null),
  };
}

async function requestCredits(token) {
  return fetch(CREDITS_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${token}`,
      'x-xai-token-auth': 'xai-grok-cli',
      Accept: 'application/json',
      'User-Agent': 'AI-Tray',
    },
    signal: AbortSignal.timeout(20000),
  });
}

async function fetchUsage({ beforeCredentialWrite } = {}) {
  // Refresh the 6h token ourselves before it lapses (the Grok CLI only does it when it runs)
  const r = await grokAuth.ensureFreshToken({ beforeWrite: beforeCredentialWrite });
  if (r.refreshed) console.log('Grok token refreshed, valid until', new Date(r.expiresAt).toLocaleTimeString());
  else if (r.error && !/missing|no X/.test(r.error)) console.warn('Grok token refresh:', r.error);

  let login = loadLogin();
  if (login.error) return login;

  try {
    let res = await requestCredits(login.token);
    // Rejected despite a token that looked valid: force one refresh and retry
    if (res.status === 401 || res.status === 403) {
      const forced = await grokAuth.ensureFreshToken({ force: true, beforeWrite: beforeCredentialWrite });
      if (forced.refreshed) {
        login = loadLogin();
        if (!login.error) res = await requestCredits(login.token);
      }
    }
    if (res.status === 401 || res.status === 403) return { error: 'Grok sign-in expired.', needsLogin: true };
    if (res.status === 429) return { error: 'Grok rate limited (429).' };
    if (!res.ok) return { error: `Grok returned ${res.status}` };
    return parseCredits(await res.json(), login.authMode);
  } catch (e) {
    return { error: (e.cause && e.cause.code) || e.message };
  }
}

module.exports = { fetchUsage, parseCredits };
