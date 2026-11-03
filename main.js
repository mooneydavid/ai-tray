const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, Notification, powerMonitor, screen } = require('electron');
const { spawn } = require('child_process');
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

const DEFAULT_CONFIG = {
  providers: { codex: true, grok: true }, // optional providers shown next to Claude
};

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return { ...DEFAULT_CONFIG, ...saved, providers: { ...DEFAULT_CONFIG.providers, ...(saved.providers || {}) } };
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

// Save a refreshed login back to Claude Code's credentials file. Claude Code shares this
// file, so re-read it first: if its refresh token is no longer the one we used, Claude Code
// rotated it in the meantime and its copy wins. Written atomically (tmp + rename) so Claude
// Code never reads a half-written file.
function saveClaudeTokens(filePath, usedRefreshToken, tokens) {
  try {
    const current = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const oauth = current.claudeAiOauth || {};
    const onDisk = oauth.refreshToken || oauth.refresh_token;
    if (onDisk && onDisk !== usedRefreshToken) {
      console.log('Claude Code updated its login meanwhile; leaving its file alone.');
      return;
    }
    current.claudeAiOauth = { ...oauth, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt };
    suppressWatcherBriefly();
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(current, null, 2));
    fs.renameSync(tmp, filePath);
  } catch (e) {
    console.error('Failed to save refreshed credentials:', e.message);
  }
}

// Ignore file-watcher events caused by our own credential writes
function suppressWatcherBriefly() {
  suppressWatcher = true;
  clearTimeout(suppressWatcherBriefly.timer);
  suppressWatcherBriefly.timer = setTimeout(() => { suppressWatcher = false; }, 2000);
}

// Claude Code's public OAuth client ID
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

// Refresh the access token directly via OAuth endpoint
// Based on CodexBar's approach: POST https://platform.claude.com/v1/oauth/token
async function refreshTokenDirect(refreshToken) {
  try {
    // Must use x-www-form-urlencoded (not JSON) per the OAuth spec
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
    });
    const body = params.toString();
    const res = await httpsRequest(
      'https://platform.claude.com/v1/oauth/token',
      { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      { method: 'POST', body }
    );
    if (res.status === 200 && res.body.access_token) {
      return {
        accessToken: res.body.access_token,
        refreshToken: res.body.refresh_token || refreshToken,
        expiresAt: Date.now() + (res.body.expires_in || 28800) * 1000,
      };
    }
    console.error('Direct token refresh failed:', res.status, res.body);
    return null;
  } catch (e) {
    console.error('Direct token refresh error:', e.message);
    return null;
  }
}

// Get a valid OAuth token, refreshing if expired (or if `force` is set after a 401).
// The credentials file is re-read on every call, so a login Claude Code refreshed itself
// is always picked up before we try to refresh anything.
async function getClaudeOAuthToken({ force = false } = {}) {
  const cred = loadClaudeCredentials();
  if (!cred) return null;

  const { filePath, oauth } = cred;
  const token = oauth.accessToken || oauth.access_token;
  const refreshTk = oauth.refreshToken || oauth.refresh_token;
  const expiresAt = oauth.expiresAt || oauth.expires_at;

  // Still valid (with 60s buffer)
  if (!force && token && expiresAt && Date.now() < expiresAt - 60000) {
    return token;
  }
  if (!refreshTk) return token || null;

  console.log('OAuth token expired, refreshing...');
  const refreshed = await refreshTokenDirect(refreshTk);
  if (refreshed) {
    console.log('Token refreshed.');
    saveClaudeTokens(filePath, refreshTk, refreshed);
    return refreshed.accessToken;
  }

  // Claude Code may have refreshed it while our request was in flight
  const again = loadClaudeCredentials();
  const latest = again && (again.oauth.accessToken || again.oauth.access_token);
  if (latest && latest !== token) return latest;

  console.warn('Token refresh failed.');
  return token || null;
}

// Fetch Claude Max session + weekly usage via OAuth (with auto-retry on 401)
async function fetchClaudeUsage() {
  let token = await getClaudeOAuthToken();
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
      const onDisk = await getClaudeOAuthToken();
      const fresh = onDisk && onDisk !== token ? onDisk : await getClaudeOAuthToken({ force: true });
      if (fresh) {
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
      extraUsage: d.extra_usage || null,
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
let settingsWindow = null;
let lastData = null;
let refreshInterval = null;
let refreshInFlight = null;   // Promise of the in-progress refreshData(), if any
let suppressWatcher = false;  // Suppress watcher during our own credential writes
let lastRateLimitedAt = 0;    // Cooldown after 429
const CLAUDE_COOLDOWN_MS = 2 * 60 * 1000;
// Track which meters have already triggered an 80% notification (reset when they drop below)
const notifiedAt80 = {};

function createTrayIcon() {
  return nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
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
      backgroundThrottling: false,  // keep measuring height and ticking countdowns while hidden
      preload: path.join(__dirname, 'preload.js'),
    },
  });

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

function showPopup() {
  createMainWindow();
  popupMoved = false;
  positionWindowNearTray();
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

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 420,
    height: 262,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    title: 'AI Tray Settings',
    backgroundColor: BG,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: BG, symbolColor: '#b3ada3', height: 40 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  settingsWindow.loadFile('src/settings.html');
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// Centre the popup above (or below) the tray icon, kept inside the screen's usable area
function positionWindowNearTray() {
  if (!mainWindow || !tray) return;
  const trayBounds = tray.getBounds();
  const { width, height } = mainWindow.getBounds();
  const area = screen.getDisplayMatching(trayBounds).workArea;
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
  let y = trayBounds.y > area.y + area.height / 2
    ? trayBounds.y - height - 4               // taskbar at the bottom
    : trayBounds.y + trayBounds.height + 4;   // taskbar at the top
  x = Math.min(Math.max(x, area.x + 8), area.x + area.width - width - 8);
  y = Math.min(Math.max(y, area.y + 8), area.y + area.height - height - 8);
  mainWindow.setPosition(x, y);
  popupOrigin = { x, y };
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

function refreshData() {
  // Coalesce concurrent calls (watcher + polling timer + manual refresh) onto one fetch
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = doRefresh().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function doRefresh() {
  const config = loadConfig();
  // During a Claude rate-limit cooldown only Claude waits; the other providers still refresh,
  // so a ChatGPT or Grok sign-in shows up straight away
  const claudeCooling = lastRateLimitedAt && Date.now() - lastRateLimitedAt < CLAUDE_COOLDOWN_MS;
  const [claudeUsage, results] = await Promise.all([
    claudeCooling ? 'cooling' : fetchClaudeUsage(),
    extras.fetchAll(config.providers, {
      beforeCredentialWrite: suppressWatcherBriefly,
    }),
  ]);
  const now = new Date().toISOString();
  const providers = {};
  for (const [id, result] of Object.entries(results)) {
    const merged = mergeStale(lastData?.providers?.[id], result, now);
    if (merged && !merged.error && !merged.staleError) merged.fetchedAt = now;
    providers[id] = merged;
  }

  if (claudeUsage === null || claudeUsage === 'cooling') {
    // Rate limited (now or recently): keep the previous Claude data, update the rest
    if (claudeUsage === null) lastRateLimitedAt = Date.now();
    const prevClaude = lastData?.claudeUsage || { error: 'Rate limited on startup. Will auto-refresh in a few minutes.' };
    lastData = { claudeUsage: prevClaude, providers, refreshedAt: new Date().toISOString() };
  } else {
    lastRateLimitedAt = 0;  // Clear cooldown on successful response
    const mergedClaude = mergeStale(lastData?.claudeUsage, claudeUsage, now);
    if (!mergedClaude.error && !mergedClaude.staleError) mergedClaude.fetchedAt = now;
    lastData = { claudeUsage: mergedClaude, providers, refreshedAt: now };
  }
  // Re-read: settings may have changed while this refresh was running
  lastData.enabledProviders = loadConfig().providers;
  checkUsageNotifications(lastData);

  for (const win of [mainWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send('data-update', lastData);
  }

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
if (gotLock && isInstalledBuild) {
  app.setLoginItemSettings({
    openAtLogin: true,
    path: app.getPath('exe'),
  });
  console.log('Registered login item:', app.getPath('exe'));
}

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
    { label: 'Settings', click: () => createSettingsWindow() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('click', () => togglePopup());

  // IPC handlers
  ipcMain.handle('get-data', () => lastData);
  ipcMain.handle('get-config', () => loadConfig());
  ipcMain.handle('save-config', (_, config) => {
    saveConfig(config);
    // Show or hide cards straight away, even if a refresh is skipped during a rate-limit cooldown
    if (lastData) {
      lastData.enabledProviders = config.providers;
      for (const win of [mainWindow, settingsWindow]) {
        if (win && !win.isDestroyed()) win.webContents.send('data-update', lastData);
      }
    }
    // A refresh already running was started with the old settings, so run one more after it
    Promise.resolve(refreshInFlight).finally(() => refreshData());
    return true;
  });
  ipcMain.handle('refresh', () => {
    lastRateLimitedAt = 0;  // Manual refresh should always bypass cooldown
    return refreshData();
  });
  ipcMain.handle('open-settings', () => createSettingsWindow());
  ipcMain.handle('open-external', (_, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
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
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const h = Math.max(120, Math.min(900, Math.round(height)));
    const [w, cur] = mainWindow.getSize();
    if (Math.abs(cur - h) < 2) return;
    mainWindow.setSize(w, h);
    if (!popupMoved) positionWindowNearTray();  // if the user placed it somewhere, don't snap it back
  });

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
    const allFailed = (!cu || cu.error) && provs.every(p => !p || p.error);
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
