// =============================================
//  ProctorAI — Electron main.js
//  Drop this in your project root and run:
//  npm start
// =============================================

const { app, BrowserWindow, session } = require('electron');
const path = require('path');

// ── Window registry ──────────────────────────
let examWindow = null;
let proctorWindow = null;

// ── Shared window options ─────────────────────
const baseWindowOptions = {
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
  },
  backgroundColor: '#0A0C11',
  titleBarStyle: 'hiddenInset',   // native traffic lights on macOS
  show: false,                    // wait for 'ready-to-show' before displaying
};

// ── Create the Exam Room window ───────────────
function createExamWindow() {
  examWindow = new BrowserWindow({
    ...baseWindowOptions,
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'ProctorAI — Exam Room',
    // Uncomment the line below to go fullscreen by default (recommended for real proctoring)
    // fullscreen: true,
  });

  examWindow.loadFile(path.join(__dirname, 'pages', 'exam-room.html'));

  examWindow.once('ready-to-show', () => examWindow.show());
  examWindow.on('closed', () => { examWindow = null; });
}

// ── Create the Proctor Dashboard window ────────
function createProctorWindow() {
  proctorWindow = new BrowserWindow({
    ...baseWindowOptions,
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'ProctorAI — Proctor Dashboard',
  });

  proctorWindow.loadFile(path.join(__dirname, 'pages', 'proctor-dashboard.html'));

  proctorWindow.once('ready-to-show', () => proctorWindow.show());
  proctorWindow.on('closed', () => { proctorWindow = null; });
}

// ── App lifecycle ─────────────────────────────
app.whenReady().then(() => {
  createExamWindow();

  // Uncomment to open the proctor dashboard in a second window simultaneously:
  // createProctorWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createExamWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
