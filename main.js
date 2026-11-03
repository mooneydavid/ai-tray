const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, Notification } = require('electron');
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const os = require('os');
const codexbar = require('./providers/codexbar');

// Config stored in user data dir
const configPath = path.join(app.getPath('userData'), 'config.json');

const DEFAULT_CONFIG = {
  apiKey: '',
  codexbarPath: '',                       // optional explicit path to codexbar-cli.exe
  providers: { codex: true, grok: true }, // extra providers fetched via codexbar CLI
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

// Save updated credentials back to disk (suppresses watcher to avoid feedback loop)
function saveClaudeCredentials(filePath, rawCreds) {
  try {
    suppressWatcher = true;
    fs.writeFileSync(filePath, JSON.stringify(rawCreds, null, 2));
    // Keep suppressed briefly so the watcher event fires and gets ignored
    setTimeout(() => { suppressWatcher = false; }, 2000);
  } catch (e) {
    suppressWatcher = false;
    console.error('Failed to save refreshed credentials:', e.message);
  }
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

// Fallback: delegate refresh to the Claude CLI (triggers its internal refresh)
function refreshTokenViaCLI() {
  const { execSync } = require('child_process');
  return new Promise((resolve) => {
    try {
      // Running any claude command triggers the CLI's internal token refresh
      execSync('claude --version', { timeout: 15000, stdio: 'ignore' });
      // Give the CLI a moment to write the refreshed credentials
      setTimeout(() => resolve(true), 1000);
    } catch (e) {
      console.error('CLI refresh failed:', e.message);
      resolve(false);
    }
  });
}

// Get a valid OAuth token, refreshing if expired
async function getClaudeOAuthToken() {
  const cred = loadClaudeCredentials();
  if (!cred) return null;

  const { filePath, oauth, raw } = cred;
  const token = oauth.accessToken || oauth.access_token;
  const refreshTk = oauth.refreshToken || oauth.refresh_token;
  const expiresAt = oauth.expiresAt || oauth.expires_at;

  // Check if token is still valid (with 60s buffer)
  if (token && expiresAt && Date.now() < expiresAt - 60000) {
    return token;
  }

  console.log('OAuth token expired, attempting refresh...');

  // Strategy 1: Direct refresh using the refresh token
  if (refreshTk) {
    const refreshed = await refreshTokenDirect(refreshTk);
    if (refreshed) {
      console.log('Token refreshed via direct OAuth.');
      // Update credentials on disk
      raw.claudeAiOauth = {
        ...oauth,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
      };
      saveClaudeCredentials(filePath, raw);
      return refreshed.accessToken;
    }
  }

  // Strategy 2: Delegate to Claude CLI to trigger its own refresh
  console.log('Direct refresh failed, trying Claude CLI fallback...');
  const cliOk = await refreshTokenViaCLI();
  if (cliOk) {
    // Re-read credentials after CLI refresh
    const updated = loadClaudeCredentials();
    if (updated) {
      const newToken = updated.oauth.accessToken || updated.oauth.access_token;
      if (newToken && newToken !== token) {
        console.log('Token refreshed via Claude CLI.');
        return newToken;
      }
    }
  }

  // Last resort: return the expired token and let the caller handle 401
  console.warn('Token refresh failed, using potentially expired token.');
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

    // If 401, force a refresh and retry once
    if (res.status === 401) {
      console.log('Got 401, forcing token refresh...');
      const cred = loadClaudeCredentials();
      if (cred) {
        cred.raw.claudeAiOauth.expiresAt = 0;
        saveClaudeCredentials(cred.filePath, cred.raw);
      }
      token = await getClaudeOAuthToken();
      if (token) {
        res = await doFetch(token);
      }
    }

    // If 429, retry with backoff before giving up
    if (res.status === 429) {
      console.log('Got 429 (rate limited), retrying in 5s...');
      await new Promise(r => setTimeout(r, 5000));
      res = await doFetch(token);
      if (res.status === 429) {
        console.log('Still 429 after first retry, retrying in 10s...');
        await new Promise(r => setTimeout(r, 10000));
        res = await doFetch(token);
        if (res.status === 429) {
          console.log('Still 429 after retries, will use cached data.');
          return null;
        }
      }
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

// Watch credential files for external re-auth (e.g. user runs `claude`/`codex login`/`grok login` in a terminal)
const credWatchers = new Map();
function watchFile(filePath) {
  if (!filePath || credWatchers.has(filePath)) return;
  if (!fs.existsSync(filePath)) return;
  try {
    let debounce = null;
    const w = fs.watch(filePath, { persistent: false }, () => {
      // Ignore changes we caused ourselves (token refresh writes)
      if (suppressWatcher) return;
      // Debounce since the file may be written multiple times quickly
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        console.log(`Credentials changed externally (${path.basename(path.dirname(filePath))}), refreshing data...`);
        refreshData();
      }, 3000);
    });
    credWatchers.set(filePath, w);
  } catch (e) {
    console.error('Failed to watch credentials file:', e.message);
  }
}
function watchCredentials() {
  watchFile(CRED_PATHS.find(p => fs.existsSync(p)));
  for (const id of Object.keys(codexbar.PROVIDERS)) watchFile(codexbar.PROVIDERS[id].authFile);
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
// Track which meters have already triggered an 80% notification (reset when they drop below)
const notifiedAt80 = {};

function createTrayIcon() {
  return nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 340,
    height: 320,
    resizable: false,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile('src/popup.html');

  // Track whether the window has been moved from its default tray position.
  // If moved, don't auto-hide on blur so the user can interact with other things.
  let movedFromTray = false;
  const origPos = { x: null, y: null };

  mainWindow.on('move', () => {
    if (origPos.x === null) return;
    const [cx, cy] = mainWindow.getPosition();
    if (Math.abs(cx - origPos.x) > 10 || Math.abs(cy - origPos.y) > 10) {
      movedFromTray = true;
    }
  });

  mainWindow.on('blur', () => {
    if (mainWindow && !mainWindow.isDestroyed() && !movedFromTray) {
      mainWindow.hide();
    }
  });

  // Expose a way to record the initial position after positioning near tray
  mainWindow._setOrigPos = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const [x, y] = mainWindow.getPosition();
      origPos.x = x;
      origPos.y = y;
      movedFromTray = false;
    }
  };

  mainWindow.on('closed', () => { mainWindow = null; });
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 420,
    height: 470,
    resizable: false,
    title: 'AI Tray Settings',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  settingsWindow.loadFile('src/settings.html');
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

function positionWindowNearTray() {
  if (!mainWindow || !tray) return;
  const trayBounds = tray.getBounds();
  const windowBounds = mainWindow.getBounds();
  const x = Math.round(trayBounds.x + trayBounds.width / 2 - windowBounds.width / 2);
  const y = trayBounds.y - windowBounds.height - 4;
  mainWindow.setPosition(x, Math.max(0, y));
  // Record origin so we can detect if user drags the window away
  if (mainWindow._setOrigPos) mainWindow._setOrigPos();
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
    const name = codexbar.PROVIDERS[id]?.label || id;
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
  if (next.cliMissing) return next;  // configuration problem, not a transient failure
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

  // Respect 429 cooldown — skip if rate limited within the last 60s
  if (lastRateLimitedAt && Date.now() - lastRateLimitedAt < 60000) {
    console.log('Skipping refresh, still in 429 cooldown.');
    return Promise.resolve();
  }

  refreshInFlight = doRefresh().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function doRefresh() {
  const config = loadConfig();
  const [claudeUsage, extra] = await Promise.all([
    fetchClaudeUsage(),
    codexbar.fetchAll(config.codexbarPath, config.providers, {
      beforeCredentialWrite: () => { suppressWatcher = true; setTimeout(() => { suppressWatcher = false; }, 2000); },
    }),
  ]);
  const now = new Date().toISOString();
  const providers = {};
  for (const [id, result] of Object.entries(extra.results)) {
    const merged = mergeStale(lastData?.providers?.[id], result, now);
    if (merged && !merged.error && !merged.staleError) merged.fetchedAt = now;
    providers[id] = merged;
  }

  if (claudeUsage === null) {
    // Rate limited (429) even after retry — keep the previous Claude data, update the rest
    lastRateLimitedAt = Date.now();
    const prevClaude = lastData?.claudeUsage || { error: 'Rate limited on startup. Will auto-refresh in a few minutes.' };
    lastData = { claudeUsage: prevClaude, providers, refreshedAt: new Date().toISOString() };
    console.log('Claude rate limited — keeping cached Claude data.');
  } else {
    lastRateLimitedAt = 0;  // Clear cooldown on successful response
    const mergedClaude = mergeStale(lastData?.claudeUsage, claudeUsage, now);
    if (!mergedClaude.error && !mergedClaude.staleError) mergedClaude.fetchedAt = now;
    lastData = { claudeUsage: mergedClaude, providers, refreshedAt: now };
  }
  lastData.enabledProviders = config.providers;
  lastData.cliFound = !!extra.cli;
  checkUsageNotifications(lastData);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('data-update', lastData);
  }

  // Update tray tooltip: one entry per provider's primary meter
  if (tray) {
    const parts = [];
    const cu = lastData.claudeUsage;
    if (cu && cu.session) parts.push(`Claude: ${Math.round(cu.session.utilization)}%`);
    for (const [id, pu] of Object.entries(providers)) {
      const first = pu && pu.meters && pu.meters[0];
      if (first) parts.push(`${codexbar.PROVIDERS[id].label}: ${Math.round(first.utilization)}%`);
    }
    tray.setToolTip(parts.length ? `AI Tray | ${parts.join(' | ')}` : 'AI Tray');
  }
}

// Only one copy in the tray: a second launch (double-click + startup) focuses the first
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    createMainWindow();
    positionWindowNearTray();
    refreshData();
  });
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
  tray.setToolTip('AI Tray — Loading...');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open', click: () => { createMainWindow(); positionWindowNearTray(); } },
    { label: 'Refresh', click: () => refreshData() },
    { label: 'Settings', click: () => createSettingsWindow() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      const isNewWindow = !mainWindow || mainWindow.isDestroyed();
      createMainWindow();
      positionWindowNearTray();
      // Reset moved state when reopening via tray click
      if (mainWindow._setOrigPos) mainWindow._setOrigPos();
      if (isNewWindow) {
        // New window: send cached data after page loads
        if (lastData) {
          mainWindow.webContents.once('did-finish-load', () => {
            mainWindow.webContents.send('data-update', lastData);
          });
        }
      } else {
        // Re-shown window: send cached data immediately (page already loaded)
        if (lastData) {
          mainWindow.webContents.send('data-update', lastData);
        }
      }
      // Always fetch fresh data when popup opens
      lastRateLimitedAt = 0;
      refreshData();
    }
  });

  // IPC handlers
  ipcMain.handle('get-data', () => lastData);
  ipcMain.handle('get-config', () => loadConfig());
  ipcMain.handle('save-config', async (_, config) => {
    saveConfig(config);
    await refreshData();
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
    const result = await codexbar.launchLogin(id);
    if (result.success) {
      watchCredentials();  // auth file may have just been created
      setTimeout(() => refreshData(), 1500);
    }
    return result;
  });
  // Popup reports its content height so the window fits however many cards are shown
  ipcMain.on('set-height', (_, height) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const h = Math.max(200, Math.min(900, Math.round(height)));
    const [w, cur] = mainWindow.getSize();
    if (Math.abs(cur - h) < 2) return;
    mainWindow.setSize(w, h);
    positionWindowNearTray();
  });

  // Watch credentials file for external re-auth
  watchCredentials();

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
