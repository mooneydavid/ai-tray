const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, powerMonitor, screen } = require('electron');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const os = require('os');
const extras = require('./providers');  // ChatGPT / Codex and Grok

// `npm start` runs get their own data folder, so a dev copy never collides with (or quits
// in favour of) the installed app, and never touches its settings.
if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'ai-tray-dev'));

// Config stored in user data dir
const configPath = path.join(app.getPath('userData'), 'config.json');
// Last numbers we fetched, so a restart (or a rate limit) shows them instead of a blank card
const cachePath = path.join(app.getPath('userData'), 'last-usage.json');

// Everything written to the console also goes to ai-tray.log in the same folder (kept under
// ~256 KB, one previous file kept as .old), so a stalled or failing refresh can be diagnosed.
// Nothing logged here contains tokens, and the Windows user folder is shown as ~.
const logPath = path.join(app.getPath('userData'), 'ai-tray.log');
for (const level of ['log', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    try {
      if (fs.existsSync(logPath) && fs.statSync(logPath).size > 256 * 1024) fs.renameSync(logPath, logPath + '.old');
      const text = args.map(a => (a instanceof Error ? a.stack : typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ').split(os.homedir()).join('~');
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${level.padEnd(5)} ${text}\n`);
    } catch (e) {}
  };
}
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
process.on('uncaughtException', (e) => console.error('Uncaught exception:', e));

const DEFAULT_CONFIG = {
  providers: { codex: true, grok: true }, // optional providers shown next to Claude
  openAtLogin: true,                      // installed build only
};

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      // Known settings only, so keys left by older versions drop out on the next save
      return {
        providers: { ...DEFAULT_CONFIG.providers, ...(saved.providers || {}) },
        openAtLogin: typeof saved.openAtLogin === 'boolean' ? saved.openAtLogin : DEFAULT_CONFIG.openAtLogin,
      };
    }
  } catch (e) {}
  return { ...DEFAULT_CONFIG, providers: { ...DEFAULT_CONFIG.providers } };
}

function saveConfig(config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// Generic HTTPS request helper (GET and POST)
function httpsRequest(url, headers, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const opts = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: { 'User-Agent': 'AI-Tray/1.0', ...headers },
    };
    if (body) {
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function httpsGet(url, headers) {
  return httpsRequest(url, headers);
}

// Claude OAuth credential paths
const CRED_PATHS = [
  path.join(os.homedir(), '.claude', '.credentials.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'claude-code', '.credentials.json'),
  path.join(os.homedir(), '.config', 'claude', '.credentials.json'),
];

// Find and read the raw credentials file
function loadClaudeCredentials() {
  for (const p of CRED_PATHS) {
    try {
      if (fs.existsSync(p)) {
        const creds = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (creds.claudeAiOauth) {
          return { filePath: p, oauth: creds.claudeAiOauth, raw: creds };
        }
      }
    } catch (e) {}
  }
  return null;
}

// Ignore file-watcher events caused by our own credential writes (Grok's login file)
function suppressWatcherBriefly() {
  suppressWatcher = true;
  clearTimeout(suppressWatcherBriefly.timer);
  suppressWatcherBriefly.timer = setTimeout(() => { suppressWatcher = false; }, 2000);
}

// AI Tray never renews or writes Claude Code's login itself. When it runs out, it starts
// Claude Code for a moment and lets Claude Code renew its own login, as CodexBar does.
// `claude -p` with nothing to ask renews the login on startup, then stops with "Input must be
// provided" before it sends anything, so no usage is spent.
const RENEW_RETRY_MS = 15 * 60 * 1000;
let lastRenewFail = null;  // { refreshToken, at } of the last attempt that didn't renew
let renewing = null;
function renewViaClaudeCode() {
  if (renewing) return renewing;
  renewing = new Promise((resolve) => {
    try {
      const child = exec('claude -p', { windowsHide: true, timeout: 30000 }, () => resolve());
      if (child.stdin) child.stdin.end();  // nothing to ask
    } catch (e) {
      console.error('Could not start Claude Code:', e.message);
      resolve();
    }
  }).finally(() => { renewing = null; });
  return renewing;
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter(k => k in obj).map(k => [k, obj[k]]));
}

// Plan name for the card header, from what Claude Code saved at login ("max" + "default_claude_max_5x" -> "Max 5x")
function claudePlan() {
  const cred = loadClaudeCredentials();
  const type = cred && cred.oauth.subscriptionType;
  if (!type) return null;
  const tier = String(cred.oauth.rateLimitTier || '').match(/(\d+x)$/);
  const name = type.charAt(0).toUpperCase() + type.slice(1);
  return tier && type === 'max' ? `${name} ${tier[1]}` : name;
}

const EXPIRED = Symbol('expired');  // the login has run out and Claude Code couldn't renew it

// Get a valid OAuth token, asking Claude Code to renew it if it has run out (or if `force` is
// set after a 401). The credentials file is re-read on every call, so a login Claude Code
// renewed on its own is always picked up first.
async function getClaudeOAuthToken({ force = false } = {}) {
  const cred = loadClaudeCredentials();
  if (!cred) return null;

  const { oauth } = cred;
  const token = oauth.accessToken || oauth.access_token;
  const refreshTk = oauth.refreshToken || oauth.refresh_token;
  const expiresAt = oauth.expiresAt || oauth.expires_at;
  const outOfDate = () => (expiresAt && Date.now() >= expiresAt ? EXPIRED : token || null);

  // Still valid (with 60s buffer)
  if (!force && token && expiresAt && Date.now() < expiresAt - 60000) {
    return token;
  }
  if (!refreshTk) return token || null;
  // Claude Code couldn't renew this same login a moment ago: wait for a new sign-in or the retry time
  if (lastRenewFail && lastRenewFail.refreshToken === refreshTk && Date.now() - lastRenewFail.at < RENEW_RETRY_MS) {
    return outOfDate();
  }

  console.log('Claude login has run out; asking Claude Code to renew it...');
  await renewViaClaudeCode();
  const again = loadClaudeCredentials();
  const latest = again && (again.oauth.accessToken || again.oauth.access_token);
  if (latest && latest !== token) {
    lastRenewFail = null;
    console.log('Claude Code renewed its login.');
    return latest;
  }
  lastRenewFail = { refreshToken: refreshTk, at: Date.now() };
  console.warn('Claude Code did not renew its login.');
  return outOfDate();
}

// Fetch Claude session + weekly usage via OAuth (with auto-retry on 401)
async function fetchClaudeUsage() {
  let token = await getClaudeOAuthToken();
  if (token === EXPIRED) return { error: 'OAuth token expired. Please re-authenticate.' };
  if (!token) return { error: 'No Claude OAuth token found. Make sure Claude Code is installed and logged in.' };

  const doFetch = async (t) => {
    return httpsGet('https://api.anthropic.com/api/oauth/usage', {
      Authorization: `Bearer ${t}`,
      'anthropic-beta': 'oauth-2025-04-20',
    });
  };

  try {
    let res = await doFetch(token);

    // If 401, refresh once and retry (without touching Claude Code's file unless the refresh works)
    if (res.status === 401) {
      console.log('Got 401, refreshing token...');
      // If Claude Code already wrote a newer token, use that rather than refreshing again
      const again = loadClaudeCredentials();
      const onDisk = again && (again.oauth.accessToken || again.oauth.access_token);
      const fresh = onDisk && onDisk !== token ? onDisk : await getClaudeOAuthToken({ force: true });
      if (fresh && fresh !== EXPIRED && fresh !== token) {
        token = fresh;
        res = await doFetch(token);
      }
    }

    // Rate limited: back off (the caller keeps the last numbers and waits out a cooldown).
    // Retrying here would only ask again sooner and hold up the other providers.
    if (res.status === 429) {
      console.log('Claude usage rate limited (429), keeping cached data.');
      return null;
    }

    if (res.status === 401) return { error: 'OAuth token expired. Please re-authenticate.' };
    if (res.status !== 200) return { error: `Claude API returned ${res.status}` };
    const d = res.body;
    return {
      session: d.five_hour ? { utilization: d.five_hour.utilization, resets_at: d.five_hour.resets_at } : null,
      weekly: d.seven_day ? { utilization: d.seven_day.utilization, resets_at: d.seven_day.resets_at } : null,
      extraUsage: d.extra_usage ? pick(d.extra_usage, ['is_enabled', 'used_credits', 'monthly_limit', 'utilization', 'currency']) : null,
      plan: claudePlan(),
    };
  } catch (e) {
    return { error: e.message };
  }
}

// Watch credential files for external re-auth (e.g. user runs `claude`/`codex login`/`grok login` in a terminal).
// We watch the folder, not the file: the CLIs save by replacing the file, and a watch on the
// old file silently stops firing after the first replace.
const credWatchers = new Map();
function watchFile(filePath) {
  if (!filePath) return;
  const dir = path.dirname(filePath);
  const name = path.basename(filePath);
  if (credWatchers.has(filePath) || !fs.existsSync(dir)) return;
  try {
    let debounce = null;
    const w = fs.watch(dir, { persistent: false }, (_, changed) => {
      if (changed && changed !== name) return;
      // Ignore changes we caused ourselves (token refresh writes)
      if (suppressWatcher) return;
      // Debounce since the file may be written multiple times quickly
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        console.log(`Credentials changed externally (${path.basename(dir)}), refreshing data...`);
        refreshData();
      }, 3000);
    });
    w.on('error', () => { credWatchers.delete(filePath); });
    credWatchers.set(filePath, w);
  } catch (e) {
    console.error('Failed to watch credentials folder:', e.message);
  }
}
function watchCredentials() {
  watchFile(CRED_PATHS.find(p => fs.existsSync(p)) || CRED_PATHS[0]);
  for (const id of Object.keys(extras.PROVIDERS)) watchFile(extras.PROVIDERS[id].authFile);
}

// Open `claude auth login` in a visible console window to re-authenticate via browser.
// It can't run hidden: after signing in, the browser shows a code that has to be pasted back
// into the CLI's "Paste code here" prompt, so a hidden process just waits until it's killed.
// Resolves once the CLI has written a new access token (or after 10 minutes).
let reAuthPending = null;
function launchReAuth() {
  if (reAuthPending) return reAuthPending;
  const before = loadClaudeCredentials();
  const oldToken = before && (before.oauth.accessToken || before.oauth.access_token);

  try {
    // `start` gives the CLI its own console; `pause` keeps the window open so any error is readable
    const child = spawn('cmd.exe',
      ['/c', 'start "Claude sign-in" cmd.exe /c "claude auth login & echo. & pause"'],
      { detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
    child.unref();
  } catch (e) {
    console.error('Failed to open sign-in window:', e.message);
    return Promise.resolve({ success: false, error: e.message });
  }

  reAuthPending = new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(async () => {
      const cred = loadClaudeCredentials();
      const token = cred && (cred.oauth.accessToken || cred.oauth.access_token);
      if (token && token !== oldToken) {
        clearInterval(poll);
        console.log('Re-auth completed successfully');
        await refreshData();
        resolve({ success: true });
      } else if (Date.now() - started > 10 * 60 * 1000) {
        clearInterval(poll);
        resolve({ success: false, error: 'Sign-in timed out.' });
      }
    }, 2000);
  }).finally(() => { reAuthPending = null; });
  return reAuthPending;
}

let tray = null;
let mainWindow = null;
let lastData = null;
let refreshInterval = null;
let refreshInFlight = null;         // Promise of the in-progress refreshData(), if any
let refreshGeneration = 0;         // bumped per refresh, so an abandoned one can't overwrite a newer one
const refreshPending = new Set();  // services the current refresh is still waiting on, for the log
let suppressWatcher = false;  // Suppress watcher during our own (Grok) credential writes
let lastRateLimitedAt = 0;    // Cooldown after 429
const CLAUDE_COOLDOWN_MS = 2 * 60 * 1000;
const CLAUDE_REUSE_MS = 2 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 90 * 1000;
// Track which meters have already triggered an 80% notification (reset when they drop below)
const notifiedAt80 = {};

function createTrayIcon() {
  return nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.ico'));
}

const BG = '#11100e';
const TRAY_NAME = app.isPackaged ? 'AI Tray' : 'AI Tray (dev)';
let popupMoved = false;     // user dragged the popup away from the tray: keep it open on blur
let popupOrigin = null;     // where we last placed it, to detect a drag
let popupHiddenAt = 0;      // when blur last hid it, so a click on the tray icon closes instead of reopening

// The popup is created hidden at startup so the first click opens it instantly at the right size
function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

  mainWindow = new BrowserWindow({
    width: 340,
    height: 320,
    show: false,
    resizable: false,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: BG,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,  // keep measuring height and ticking countdowns while hidden
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // The popup only ever shows its own page: no navigating away (a file dropped on it, say), no new windows
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.loadFile('src/popup.html');
  mainWindow.webContents.on('did-finish-load', () => {
    if (lastData) mainWindow.webContents.send('data-update', lastData);
  });

  mainWindow.on('move', () => {
    if (!popupOrigin || !mainWindow.isVisible()) return;
    const [cx, cy] = mainWindow.getPosition();
    if (Math.abs(cx - popupOrigin.x) > 10 || Math.abs(cy - popupOrigin.y) > 10) popupMoved = true;
  });

  mainWindow.on('blur', () => {
    if (mainWindow && !mainWindow.isDestroyed() && !popupMoved) {
      mainWindow.hide();
      popupHiddenAt = Date.now();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

// Opens on the usage view unless asked for settings (tray menu)
function showPopup(view = 'main') {
  createMainWindow();
  popupMoved = false;
  positionWindowNearTray();
  mainWindow.webContents.send('show-view', { view, instant: true });
  if (lastData) mainWindow.webContents.send('data-update', lastData);
  mainWindow.show();
  mainWindow.focus();
  // Always fetch fresh data when the popup opens
  refreshData();
}

function togglePopup() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    mainWindow.hide();
    return;
  }
  // Clicking the tray icon blurs the popup first, which hides it; don't reopen on that same click
  if (Date.now() - popupHiddenAt < 300) return;
  showPopup();
}

// Centre the popup above (or below) the tray icon, kept inside the screen's usable area
// Size and position are set together (setBounds) so the popup never shows a half-applied resize.
// setSize can't shrink a fixed-size window on Windows; setBounds can.
function positionWindowNearTray(height = mainWindow && mainWindow.getBounds().height) {
  if (!mainWindow || !tray) return;
  const trayBounds = tray.getBounds();
  const { width } = mainWindow.getBounds();
  const area = screen.getDisplayMatching(trayBounds).workArea;
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
  let y = trayBounds.y > area.y + area.height / 2
    ? trayBounds.y - height - 4               // taskbar at the bottom
    : trayBounds.y + trayBounds.height + 4;   // taskbar at the top
  x = Math.min(Math.max(x, area.x + 8), area.x + area.width - width - 8);
  y = Math.min(Math.max(y, area.y + 8), area.y + area.height - height - 8);
  popupOrigin = { x, y };  // before moving, so our own move isn't mistaken for a drag
  mainWindow.setBounds({ x, y, width, height });
}

function checkUsageNotifications(lastData) {
  const checks = [];
  const cu = lastData.claudeUsage;
  if (cu && !cu.error) {
    if (cu.session) checks.push({ key: 'claude:session', pct: cu.session.utilization, label: 'Claude session (5h)' });
    if (cu.weekly) checks.push({ key: 'claude:weekly', pct: cu.weekly.utilization, label: 'Claude weekly' });
  }
  for (const [id, pu] of Object.entries(lastData.providers || {})) {
    if (!pu || pu.error) continue;
    const name = extras.PROVIDERS[id]?.label || id;
    for (const m of pu.meters || []) {
      checks.push({ key: `${id}:${m.key}`, pct: m.utilization, label: `${name} ${m.label}` });
    }
  }

  for (const { key, pct: raw, label } of checks) {
    const pct = Math.round(raw);
    if (pct >= 80 && !notifiedAt80[key]) {
      notifiedAt80[key] = true;
      new Notification({
        title: 'AI Tray — Usage Alert',
        body: `${label} is at ${pct}% usage.`,
      }).show();
    } else if (pct < 80) {
      // Reset so it can fire again next time it crosses 80%
      notifiedAt80[key] = false;
    }
  }
}

// Keep the previous good numbers for a provider whose fetch failed this round, so the
// card doesn't blank out because one CLI call timed out. The error is attached as
// `staleError` and the UI shows it under the (dimmed) meters.
function mergeStale(prev, next, now) {
  if (!next || !next.error || !prev || !(prev.meters || prev.session || prev.weekly)) return next;
  return {
    ...prev,
    staleError: next.error,
    staleSince: prev.staleSince || prev.fetchedAt || now,
    needsLogin: !!next.needsLogin,
  };
}

// `force` (the refresh button) always asks Claude; other refreshes reuse Claude numbers under
// CLAUDE_REUSE_MS old, because its usage endpoint rate-limits requests a couple of minutes apart.
function refreshData({ force = false } = {}) {
  // Coalesce concurrent calls (watcher + polling timer + manual refresh) onto one fetch
  if (refreshInFlight) return refreshInFlight;

  // A refresh that hangs (a request stuck while the network comes up after boot, say) must not
  // block every later refresh, so give up on it after REFRESH_TIMEOUT_MS
  let watchdog;
  const timedOut = new Promise((resolve) => {
    watchdog = setTimeout(() => {
      console.error(`Refresh took over ${REFRESH_TIMEOUT_MS / 1000}s; abandoning it. Still waiting on: ${[...refreshPending].join(', ') || 'saving'}`);
      resolve();
    }, REFRESH_TIMEOUT_MS);
  });
  const run = doRefresh(force, ++refreshGeneration).catch((e) => console.error('Refresh failed:', e));
  refreshInFlight = Promise.race([run, timedOut]).finally(() => { clearTimeout(watchdog); refreshInFlight = null; });
  return refreshInFlight;
}

async function doRefresh(force, generation) {
  const started = Date.now();
  const config = loadConfig();
  // During a Claude rate-limit cooldown only Claude waits; the other providers still refresh,
  // so a ChatGPT or Grok sign-in shows up straight away
  const claudeCooling = lastRateLimitedAt && Date.now() - lastRateLimitedAt < CLAUDE_COOLDOWN_MS;
  const prevFetched = Date.parse(lastData?.claudeUsage?.fetchedAt || '');
  const claudeRecent = !force && !lastData?.claudeUsage?.staleError && Date.now() - prevFetched < CLAUDE_REUSE_MS;
  refreshPending.clear();
  refreshPending.add('claude');
  for (const id of Object.keys(config.providers || {})) if (config.providers[id]) refreshPending.add(id);
  const [claudeUsage, results] = await Promise.all([
    (claudeRecent ? Promise.resolve('recent') : claudeCooling ? Promise.resolve('cooling') : fetchClaudeUsage())
      .finally(() => generation === refreshGeneration && refreshPending.delete('claude')),
    extras.fetchAll(config.providers, {
      beforeCredentialWrite: suppressWatcherBriefly,
      onDone: (id) => generation === refreshGeneration && refreshPending.delete(id),
    }),
  ]);
  // Abandoned by the watchdog and a newer refresh has started since: drop these results
  if (generation !== refreshGeneration) {
    console.warn(`Late refresh finished after ${Date.now() - started}ms; ignoring it.`);
    return;
  }
  const now = new Date().toISOString();
  const providers = {};
  for (const [id, result] of Object.entries(results)) {
    const merged = mergeStale(lastData?.providers?.[id], result, now);
    if (merged && !merged.error && !merged.staleError) merged.fetchedAt = now;
    providers[id] = merged;
  }

  if (claudeUsage === 'recent') {
    lastData = { claudeUsage: lastData.claudeUsage, providers, refreshedAt: now };
  } else if (claudeUsage === null || claudeUsage === 'cooling') {
    // Rate limited (now or recently): keep the previous Claude data, update the rest
    if (claudeUsage === null) lastRateLimitedAt = Date.now();
    const prev = lastData?.claudeUsage;
    const prevClaude = prev && !prev.error
      ? { ...prev, staleError: 'Claude rate limited (429)', staleSince: prev.staleSince || prev.fetchedAt || now, needsLogin: false }
      : { error: 'Claude rate limited (429)' };
    lastData = { claudeUsage: prevClaude, providers, refreshedAt: new Date().toISOString() };
  } else {
    lastRateLimitedAt = 0;  // Clear cooldown on successful response
    const mergedClaude = mergeStale(lastData?.claudeUsage, claudeUsage, now);
    if (!mergedClaude.error && !mergedClaude.staleError) mergedClaude.fetchedAt = now;
    lastData = { claudeUsage: mergedClaude, providers, refreshedAt: now };
  }
  // Re-read: settings may have changed while this refresh was running
  lastData.enabledProviders = loadConfig().providers;
  try { checkUsageNotifications(lastData); } catch (e) { console.error('Notification failed:', e); }
  try { fs.writeFileSync(cachePath, JSON.stringify(lastData)); } catch (e) { console.error('Could not save last numbers:', e.message); }
  const state = (x) => !x ? 'none' : x.error ? `error (${x.error})` : x.staleError ? `old (${x.staleError})` : 'ok';
  console.log(`Refreshed in ${Date.now() - started}ms. Claude: ${claudeUsage === 'recent' ? 'reused' : state(lastData.claudeUsage)}; ` +
    Object.entries(providers).map(([id, p]) => `${id}: ${state(p)}`).join('; '));

  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('data-update', lastData);

  // Update tray tooltip: one entry per provider's primary meter
  if (tray) {
    const parts = [];
    const cu = lastData.claudeUsage;
    if (cu && cu.session) parts.push(`Claude: ${Math.round(cu.session.utilization)}%`);
    for (const [id, pu] of Object.entries(providers)) {
      const first = pu && pu.meters && pu.meters[0];
      if (first) parts.push(`${extras.PROVIDERS[id].label}: ${Math.round(first.utilization)}%`);
    }
    tray.setToolTip(parts.length ? `${TRAY_NAME} | ${parts.join(' | ')}` : TRAY_NAME);
  }
}

// Only one copy in the tray: a second launch (double-click + startup) focuses the first
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showPopup());
}

// Auto-start on login: only the installed build, and only the copy that owns the tray.
// Windows keys tray-icon visibility (the taskbar pin) on the exe path, so whichever copy
// registers here decides which tray identity appears after boot. A stray copy (an old portable
// build, dist\win-unpacked) must never take over the login item, and neither should a second
// instance that's about to quit.
const installedDir = path.join(process.env.LOCALAPPDATA || '', 'Programs');
const isInstalledBuild = app.isPackaged
  && !process.env.PORTABLE_EXECUTABLE_FILE
  && app.getPath('exe').toLowerCase().startsWith(installedDir.toLowerCase() + path.sep);
function applyStartup(on) {
  app.setLoginItemSettings({ openAtLogin: on, path: app.getPath('exe') });
}
if (gotLock && isInstalledBuild) applyStartup(loadConfig().openAtLogin !== false);

app.whenReady().then(async () => {
  // A second instance is quitting; don't flash a duplicate tray icon on the way out
  if (!gotLock) return;

  // Prevent showing in dock/taskbar
  if (app.dock) app.dock.hide();

  // Create tray with static icon
  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip(`${TRAY_NAME}: loading…`);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open', click: () => showPopup() },
    { label: 'Refresh', click: () => refreshData() },
    { label: 'Settings', click: () => showPopup('settings') },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('click', () => togglePopup());

  // IPC handlers
  ipcMain.handle('get-data', () => lastData);
  ipcMain.handle('get-config', () => loadConfig());
  ipcMain.handle('save-config', (_, incoming) => {
    // Only the switches the popup owns; everything else stays as saved
    const config = loadConfig();
    const sent = (incoming && incoming.providers) || {};
    for (const id of Object.keys(extras.PROVIDERS)) if (typeof sent[id] === 'boolean') config.providers[id] = sent[id];
    if (incoming && typeof incoming.openAtLogin === 'boolean') config.openAtLogin = incoming.openAtLogin;
    saveConfig(config);
    // Show or hide cards straight away, even if a refresh is skipped during a rate-limit cooldown
    if (lastData) {
      lastData.enabledProviders = config.providers;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('data-update', lastData);
    }
    // A refresh already running was started with the old settings, so run one more after it
    Promise.resolve(refreshInFlight).finally(() => refreshData());
    return true;
  });
  ipcMain.handle('refresh', () => {
    lastRateLimitedAt = 0;  // Manual refresh should always bypass cooldown
    return refreshData({ force: true });
  });
  ipcMain.handle('get-app-info', () => ({
    version: app.getVersion(),
    startupAvailable: isInstalledBuild,
    openAtLogin: loadConfig().openAtLogin !== false,
  }));
  ipcMain.handle('set-startup', (_, on) => {
    saveConfig({ ...loadConfig(), openAtLogin: !!on });
    if (isInstalledBuild) applyStartup(!!on);
  });
  ipcMain.handle('quit', () => app.quit());
  ipcMain.handle('close-window', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }
  });
  ipcMain.handle('re-authenticate', () => launchReAuth());
  ipcMain.handle('provider-login', async (_, id) => {
    const result = await extras.launchLogin(id);
    if (result.success) {
      watchCredentials();  // auth file may have just been created
      setTimeout(() => refreshData(), 1500);
    }
    return result;
  });
  // Popup reports its content height so the window fits however many cards are shown
  ipcMain.on('set-height', (_, height) => {
    if (!mainWindow || mainWindow.isDestroyed() || !Number.isFinite(height)) return;
    const h = Math.max(120, Math.min(900, Math.round(height)));
    const b = mainWindow.getBounds();
    if (Math.abs(b.height - h) < 2) return;
    if (popupMoved || !tray) mainWindow.setBounds({ ...b, height: h });  // the user placed it; don't snap it back
    else positionWindowNearTray(h);
  });

  // Start from the last numbers we saw; the first refresh replaces or marks them as old
  try {
    lastData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    lastData.enabledProviders = loadConfig().providers;
  } catch (e) {}

  // Build the popup now (hidden) so the first click shows it straight away
  createMainWindow();

  // Watch credentials for external re-auth
  watchCredentials();

  // After sleep or a locked screen the numbers are stale: refresh once the network is back
  const refreshSoon = () => setTimeout(() => refreshData(), 5000);
  powerMonitor.on('resume', refreshSoon);
  powerMonitor.on('unlock-screen', refreshSoon);

  // Initial fetch + polling. At login the network is often not up yet, so if the first
  // fetches all fail, retry on a short backoff (30s, 60s, 120s) before settling into 5 min.
  refreshInterval = setInterval(refreshData, 5 * 60 * 1000);
  const bootRetry = async (attempt = 0) => {
    await refreshData();
    const cu = lastData?.claudeUsage;
    const provs = Object.values(lastData?.providers || {});
    const failed = (x) => !x || x.error || x.staleError;
    const allFailed = failed(cu) && provs.every(failed);
    if (allFailed && attempt < 3) {
      const delay = 30000 * Math.pow(2, attempt);
      console.log(`All providers failed at boot, retrying in ${delay / 1000}s...`);
      setTimeout(() => bootRetry(attempt + 1), delay);
    }
  };
  bootRetry();
});

app.on('window-all-closed', (e) => {
  // Keep app running in tray
  e.preventDefault();
});

app.on('before-quit', () => {
  if (refreshInterval) clearInterval(refreshInterval);
});
