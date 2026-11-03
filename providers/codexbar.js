// Wrapper around the Win-CodexBar CLI (codexbar-cli.exe).
// We shell out to it for providers we don't implement natively (Codex/ChatGPT, Grok).
// It reads the same on-disk OAuth files the official CLIs write (~/.codex/auth.json,
// ~/.grok/auth.json) and returns normalized usage JSON.
//
// Source: https://github.com/nesszer/Win-CodexBar (MIT)

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const grokAuth = require('./grok-auth');

// Provider definitions: codexbar CLI name -> how we present it
const PROVIDERS = {
  codex: {
    label: 'ChatGPT / Codex',
    authFile: path.join(os.homedir(), '.codex', 'auth.json'),
    loginCmd: 'codex',
    loginPaths: [path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')],
    loginArgs: ['login'],
    installHint: 'Install Codex CLI (npm i -g @openai/codex) and run `codex login`.',
    sessionLabel: 'Session (5h)',
    weeklyLabel: 'Weekly',
  },
  grok: {
    label: 'Grok',
    authFile: path.join(os.homedir(), '.grok', 'auth.json'),
    loginCmd: 'grok',
    loginPaths: [path.join(os.homedir(), '.grok', 'bin', 'grok.exe')],
    loginArgs: ['login', '--oauth'],
    installHint: 'Install Grok CLI and run `grok login --oauth` (sign in with X).',
    sessionLabel: 'Credits',
    weeklyLabel: 'On-demand',
  },
};

// Locate codexbar-cli.exe: explicit config path, bundled bin/, CodexBar install dir, then PATH
function findCli(configPath) {
  const candidates = [
    configPath,
    path.join(__dirname, '..', 'bin', 'codexbar-cli.exe'),
    path.join(process.resourcesPath || '', 'bin', 'codexbar-cli.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'CodexBar', 'codexbar-cli.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'CodexBar', 'codexbar-cli.exe'),
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return null;
}

function run(cli, args, timeoutMs = 45000) {
  return new Promise((resolve) => {
    execFile(cli, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// Pull the first JSON value out of stdout (the CLI may print log lines around it)
function extractJson(text) {
  const start = Math.min(...['[', '{'].map(c => { const i = text.indexOf(c); return i < 0 ? Infinity : i; }));
  if (!isFinite(start)) return null;
  try { return JSON.parse(text.slice(start)); } catch (e) {}
  // Fallback: trim trailing junk after the last closing bracket
  const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
  if (end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch (e) {}
  }
  return null;
}

// Convert a codexbar RateWindow into our meter shape
function toMeter(key, label, w) {
  if (!w || typeof w.used_percent !== 'number') return null;
  return {
    key,
    label,
    utilization: w.used_percent,
    resets_at: w.resets_at || null,
    window_minutes: w.window_minutes || null,
  };
}

// Normalize a codexbar ProviderPayload into { meters, plan, email, error }
function normalize(id, payload) {
  const def = PROVIDERS[id];
  if (!payload) return { error: 'No output from codexbar CLI' };
  if (payload.error) return { error: String(payload.error) };
  const u = payload.usage || {};
  const meters = [];
  const primary = toMeter('session', u.primary_label || def.sessionLabel, u.primary);
  const secondary = toMeter('weekly', u.secondary_label || def.weeklyLabel, u.secondary);
  if (primary) meters.push(primary);
  if (secondary) meters.push(secondary);
  for (const extra of u.extra_rate_windows || []) {
    const m = toMeter(extra.id || 'extra', extra.title || 'Extra', extra.window);
    if (m) meters.push(m);
  }
  if (!meters.length) return { error: 'No usage data returned' };
  return {
    meters,
    plan: u.login_method || null,
    email: u.account_email || null,
    source: payload.source || null,
    cost: payload.cost || null,
  };
}

function authFileExists(id) {
  try { return fs.existsSync(PROVIDERS[id].authFile); } catch (e) { return false; }
}

async function runUsage(cli, id) {
  const { err, stdout, stderr } = await run(cli, ['usage', '--provider', id, '--json', '--no-color']);
  const parsed = extractJson(stdout) || extractJson(stderr);
  if (parsed) {
    const payload = Array.isArray(parsed) ? parsed.find(p => p && p.provider === id) || parsed[0] : parsed;
    const result = normalize(id, payload);
    if (result.error && /auth|login|sign.?in|401|expired|token/i.test(result.error)) result.needsLogin = true;
    return result;
  }
  if (err) {
    const msg = (stderr || err.message || '').trim().split('\n')[0] || 'codexbar CLI failed';
    return { error: msg };
  }
  return { error: 'Could not parse codexbar output' };
}

// Fetch usage for one provider via the CLI
async function fetchProvider(cli, id, opts = {}) {
  const def = PROVIDERS[id];
  if (!def) return { error: `Unknown provider ${id}` };
  if (!authFileExists(id)) {
    return { error: `Not logged in. ${def.installHint}`, needsLogin: true };
  }

  // Grok: refresh the 6h token ourselves before it lapses (codexbar never refreshes it)
  if (id === 'grok') {
    const r = await grokAuth.ensureFreshToken({ beforeWrite: opts.beforeCredentialWrite });
    if (r.refreshed) console.log('Grok token refreshed, valid until', new Date(r.expiresAt).toLocaleTimeString());
    else if (r.error && !/missing|no X/.test(r.error)) console.warn('Grok token refresh:', r.error);
  }

  let result = await runUsage(cli, id);

  // Grok auth failure despite a not-yet-expired token: force one refresh and retry
  if (id === 'grok' && result.needsLogin) {
    const r = await grokAuth.ensureFreshToken({ force: true, beforeWrite: opts.beforeCredentialWrite });
    if (r.refreshed) result = await runUsage(cli, id);
  }
  return result;
}

// Fetch all enabled providers in parallel
async function fetchAll(configPath, enabled, opts = {}) {
  const cli = findCli(configPath);
  const results = {};
  const ids = Object.keys(PROVIDERS).filter(id => enabled[id]);
  if (!ids.length) return { cli, results };
  if (!cli) {
    for (const id of ids) results[id] = { error: 'codexbar-cli.exe not found. Set its path in Settings.', cliMissing: true };
    return { cli, results };
  }
  const settled = await Promise.all(ids.map(id => fetchProvider(cli, id, opts).catch(e => ({ error: e.message }))));
  ids.forEach((id, i) => { results[id] = settled[i]; });
  return { cli, results };
}

// Spawn the provider's own CLI login (opens a browser), resolve when it exits
function launchLogin(id) {
  const def = PROVIDERS[id];
  if (!def) return Promise.resolve({ success: false, error: 'Unknown provider' });
  // Prefer the installer's known location; fall back to PATH lookup via shell
  const exe = (def.loginPaths || []).find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
  const cmd = exe ? `"${exe}"` : def.loginCmd;
  return new Promise((resolve) => {
    const child = execFile(cmd, def.loginArgs, { shell: true, timeout: 300000 }, (err) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
    child.unref();
  });
}

module.exports = { PROVIDERS, findCli, fetchAll, fetchProvider, launchLogin, authFileExists, normalize, extractJson };
