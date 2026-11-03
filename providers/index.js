// The optional providers shown next to Claude. Each reads the login its own CLI saves.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const chatgpt = require('./chatgpt');
const grok = require('./grok');
const grokAuth = require('./grok-auth');

const PROVIDERS = {
  codex: {
    label: 'ChatGPT / Codex',
    authFile: chatgpt.authPath(),
    fetch: chatgpt.fetchUsage,
    loginCmd: 'codex',
    loginPaths: [path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')],
    loginArgs: ['login'],
  },
  grok: {
    label: 'Grok',
    authFile: grokAuth.authPath(),
    fetch: grok.fetchUsage,
    loginCmd: 'grok',
    loginPaths: [path.join(os.homedir(), '.grok', 'bin', 'grok.exe')],
    loginArgs: ['login', '--oauth'],
  },
};

// Fetch all enabled providers in parallel
async function fetchAll(enabled, opts = {}) {
  const ids = Object.keys(PROVIDERS).filter(id => enabled[id]);
  const settled = await Promise.all(ids.map(id => PROVIDERS[id].fetch(opts)
    .catch(e => ({ error: String(e.message).split(os.homedir()).join('~') }))
    .finally(() => opts.onDone && opts.onDone(id))));
  const results = {};
  ids.forEach((id, i) => { results[id] = settled[i]; });
  return results;
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

module.exports = { PROVIDERS, fetchAll, launchLogin };
