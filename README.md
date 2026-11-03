# AI Tray — Setup Instructions

A Windows system tray app showing your Claude Max session/weekly limits and Anthropic API credit balance.

## What it tracks
- **Claude Max**: Session (5-hour window) and weekly usage % with reset timers
- **Anthropic API**: Remaining credit balance in USD
- **ChatGPT / Codex** (optional): Session + weekly limits for your ChatGPT subscription
- **Grok** (optional): SuperGrok credit usage

## Requirements
- Windows 10 or 11
- Node.js 18+ installed (you already have this via nvm)
- Claude Code CLI installed and logged in (you already have this)

## Setup

### Step 1 — Install Node.js for Windows
You need a system Node.js on Windows (not just in Claude Code).
Download from: https://nodejs.org (LTS version)

### Step 2 — Install dependencies
Open PowerShell in the ai-tray folder and run:
```
npm install
```

### Step 3 — Run the app
```
npm start
```
The app will appear in your system tray (bottom right, near the clock).

### Step 4 — Configure your API key
- Right-click the tray icon → Settings (or left-click → ⚙ button)
- Paste your Anthropic API key (sk-ant-api03-...)
- Click Save & Refresh

### Step 5 — Auto-start on Windows boot (optional)
Build and install the app (see below). The installed app registers itself to start on login.

## How Claude Max auth works
The app reads the OAuth token that Claude Code already stores on your machine at:
`~/.claude/.credentials.json`

No passwords, no browser cookies. If you're logged into Claude Code, it just works.

## Optional: ChatGPT/Codex and Grok
These are fetched through [Win-CodexBar](https://github.com/nesszer/Win-CodexBar)'s `codexbar-cli.exe`, which reads the
OAuth tokens saved by the official CLIs. Nothing else is stored.

1. Download `CodexBarCLI-<version>-windows-x64.zip` from the Win-CodexBar releases page, unzip, and put
   `codexbar-cli.exe` in this folder's `bin\` directory (or set its path in Settings).
2. ChatGPT: `npm i -g @openai/codex` then `codex login` (sign in with your ChatGPT account).
3. Grok: install the Grok CLI, then `grok login --oauth` and sign in with X.
4. Each provider can be toggled in Settings. The popup shows a **Sign in** button when a login is missing.

## How to build a standalone .exe (optional)
```
npm run build
```
This creates `dist/AI Tray Setup <version>.exe`. Run it to install (per-user, no admin) to
`%LOCALAPPDATA%\Programs\ai-tray`. Re-running a newer installer updates in place, so the tray icon
keeps the same identity and stays pinned to the taskbar.

## Files
- `main.js` — Main process (all data fetching happens here, nothing hidden)
- `providers/codexbar.js` — Wrapper around `codexbar-cli.exe` for ChatGPT/Codex and Grok
- `preload.js` — Secure bridge between UI and main process
- `src/popup.html` — The popup window UI
- `src/settings.html` — Settings window

## Privacy
- Zero network calls except to api.anthropic.com (plus chatgpt.com / grok.com if you enable those providers)
- API key stored locally in your user data folder
- No telemetry, no analytics, no external servers
