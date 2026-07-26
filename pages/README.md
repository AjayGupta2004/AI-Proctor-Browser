# ProctorAI — Electron Integration Guide

## Folder structure

Paste these files into your Electron project exactly like this:

```
your-electron-app/
│
├── main.js                   ← Replace or merge with your existing main.js
├── package.json              ← Your existing file (see note below)
│
└── pages/                    ← CREATE this folder
    ├── shared.css            ← Common styles (used by all pages)
    ├── exam-room.html        ← Candidate exam screen
    ├── proctor-dashboard.html← Proctor live monitoring
    └── post-exam-report.html ← AI-generated post-exam report
```

---

## Step 1 — Copy the files

1. Create a `pages/` folder inside your Electron project root
2. Copy these 4 files into it:
   - shared.css
   - exam-room.html
   - proctor-dashboard.html
   - post-exam-report.html
3. Put `main.js` in your project root (or merge with your existing one)

---

## Step 2 — Update package.json

Make sure your `package.json` has:

```json
{
  "name": "proctor-ai",
  "version": "1.0.0",
  "main": "main.js",
  "scripts": {
    "start": "electron ."
  },
  "devDependencies": {
    "electron": "^29.0.0"
  }
}
```

If you don't have Electron installed yet:

```bash
npm install --save-dev electron
```

---

## Step 3 — Run the app

```bash
npm start
```

This will open the Exam Room window. To also open the Proctor Dashboard simultaneously, uncomment the `createProctorWindow()` line in `main.js`.

---

## Page navigation (already wired up)

| From             | Action                      | Goes to               |
|------------------|-----------------------------|-----------------------|
| exam-room        | Click "Submit exam"         | post-exam-report.html |
| proctor-dashboard| Click "View reports →"      | post-exam-report.html |
| proctor-dashboard| Click "Candidate view"      | exam-room.html        |
| post-exam-report | Click "← Back to dashboard" | proctor-dashboard.html|

All navigation uses `window.location.href` — it works as-is in Electron with `loadFile()`.

---

## Enabling real fullscreen lockdown (Electron)

In `main.js`, swap the window creation to:

```js
examWindow = new BrowserWindow({
  fullscreen: true,
  kiosk: true,              // prevents Alt+F4, Task Manager etc. on Windows
  alwaysOnTop: true,
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
  },
});
```

---

## Adding a preload script (recommended for AI signals)

To enable IPC between your AI proctoring logic and the UI pages, add a preload:

```js
// in main.js BrowserWindow options:
webPreferences: {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
}
```

```js
// preload.js
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('proctor', {
  onFlag: (cb) => ipcRenderer.on('flag-event', (_e, data) => cb(data)),
  sendViolation: (data) => ipcRenderer.send('violation', data),
});
```

Then in your HTML pages you can call `window.proctor.onFlag(...)` to receive real-time AI signals from your Node.js proctoring engine.

---

## What's next to build

- `system-check.html` — Camera/mic test + ID verification before exam starts
- `admin-panel.html`  — Exam creation, user management, session controls
- Backend WebSocket server (Node.js + Socket.IO) for real-time proctor ↔ candidate sync
- face-api.js integration inside exam-room.html for live face detection
