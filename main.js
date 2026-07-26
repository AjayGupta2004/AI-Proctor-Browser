/**
 * main.js — AI Proctor Browser (Root Electron Main Process)
 *
 * Responsibilities:
 *  - Spawn the SQLite/Socket.IO backend server (backend/index.js)
 *  - Display the exam UI (pages/login.html → pages/exam-room.html)
 *  - Enforce kiosk lockdown once the exam room loads
 *  - Lift lockdown only on a verified VERIFIED_SUBMIT signal
 *  - Relay AI violations to the backend via Socket.IO
 *  - Handle system-level events (suspend, screen-lock) → auto-submit
 */

const {
  app,
  BrowserWindow,
  powerSaveBlocker,
  ipcMain,
  powerMonitor,
  systemPreferences,
  globalShortcut,
  session,
  shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { io } = require('socket.io-client');

// Bypass autoplay policy so AudioContext (mic meter) can start without user interaction.
// NOTE: 'use-fake-ui-for-media-stream' is intentionally NOT used here — it replaces the
// real camera feed with a blank fake stream, breaking face-api detection entirely.
// Camera/mic access is correctly granted via setPermissionCheckHandler below.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ─── Global Error Handlers ─────────────────────────────────────────
// Prevent Electron crash dialogs for closed stdout/stderr (e.g., write EIO)
process.on('uncaughtException', (error) => {
  if (error.code === 'EIO' || (error.message && error.message.includes('write EIO'))) {
    return; // Ignore stdout/stderr closed errors
  }
  try { console.error('[Uncaught Exception]', error); } catch (_) { }
});

process.on('unhandledRejection', (reason) => {
  try { console.error('[Unhandled Rejection]', reason); } catch (_) { }
});
// ─── Config ────────────────────────────────────────────────────────
let EXAM_ID = process.env.EXAM_ID || 'exam_demo_001';
const PROCTOR_SERVER_URL = process.env.PROCTOR_SERVER_URL || 'http://localhost:4000';

// ─── State ─────────────────────────────────────────────────────────
let mainWindow = null;
let isExamStarted = false;
let isExamSubmitted = false;
let idBlocker = null;
let backendProcess = null;
let lockdownStartTime = 0;

let STUDENT_ID = process.env.STUDENT_ID || 'student_demo';
// ─── Socket.IO ─────────────────────────────────────────────────────
let socket = null;
const pendingViolationQueue = [];
const pendingSubmissionQueue = [];

// ══════════════════════════════════════════════════════
// 1.  BACKEND — spawn backend/index.js via system node
// ══════════════════════════════════════════════════════
function startBackendServer() {
  const backendScript = path.join(__dirname, 'backend', 'index.js');

  if (!fs.existsSync(backendScript)) {
    console.warn('[Backend] backend/index.js not found – skipping.');
    return;
  }

  // Check if backend is already running on port 4000
  const net = require('net');
  const tester = net.createConnection({ port: 4000, host: '127.0.0.1' });
  tester.once('connect', () => {
    tester.destroy();
    console.log('[Backend] Already running on port 4000 — skipping spawn.');
  });
  tester.once('error', () => {
    tester.destroy();
    // Port is free — spawn our own backend
    const nodeCmd = process.platform === 'win32' ? 'node.exe' : 'node';
    backendProcess = spawn(nodeCmd, [backendScript], {
      cwd: path.join(__dirname, 'backend'),
      env: { ...process.env, PROCTOR_PORT: '4000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    backendProcess.stdout.on('data', (d) => {
      process.stdout.write('[Backend] ' + d.toString());
    });
    backendProcess.stderr.on('data', (d) => {
      process.stderr.write('[Backend ERR] ' + d.toString());
    });
    backendProcess.on('error', (err) => {
      console.warn('[Backend] Failed to start:', err.message);
      backendProcess = null;
    });
    backendProcess.on('exit', (code) => {
      console.log('[Backend] exited with code', code);
      backendProcess = null;
    });
    console.log('[Backend] process spawned');
  });
}

// ══════════════════════════════════════════════════════
// 2.  SOCKET.IO — connect to backend
// ══════════════════════════════════════════════════════
function connectBackend() {
  socket = io(PROCTOR_SERVER_URL, {
    transports: ['websocket'],
    autoConnect: false,
    reconnection: true,
    reconnectionDelay: 3000,
  });

  socket.on('connect', () => {
    console.log('[Socket] Connected to backend:', PROCTOR_SERVER_URL);
    // Register as student
    socket.emit('student:join', { examId: EXAM_ID, studentId: STUDENT_ID });
    // Flush queued violations
    while (pendingViolationQueue.length > 0) {
      socket.emit('proctor:violation', pendingViolationQueue.shift());
    }
    // Flush queued submissions
    while (pendingSubmissionQueue.length > 0) {
      socket.emit('student:submit', pendingSubmissionQueue.shift());
    }
  });

  socket.on('connect_error', (err) => {
    console.warn('[Socket] Connection error:', err?.message || err);
  });

  socket.on('disconnect', () => {
    console.log('[Socket] Disconnected from backend');
  });

  socket.connect();
}

// ══════════════════════════════════════════════════════
// 3.  VIOLATION LOGGING
// ══════════════════════════════════════════════════════
function logViolation(type, details = {}) {
  const evidenceDataUrl = details.evidenceDataUrl || null;
  const severity = details.severity || 'medium';

  // Do not embed evidenceDataUrl inside JSON details blob
  const detailsCopy = { ...details };
  delete detailsCopy.evidenceDataUrl;

  const payload = {
    examId: EXAM_ID,
    studentId: STUDENT_ID,
    type,
    timestamp: Date.now(),
    severity,
    details: detailsCopy,
    evidenceDataUrl,
  };

  console.log('[VIOLATION]', JSON.stringify({ type, severity, timestamp: payload.timestamp }));

  if (socket && socket.connected) {
    socket.emit('proctor:violation', payload);
  } else {
    pendingViolationQueue.push(payload);
  }
}

// ══════════════════════════════════════════════════════
// 4.  AUTO SUBMIT — used by power events
// ══════════════════════════════════════════════════════
function triggerAutoSubmit(reason) {
  if (!isExamStarted || isExamSubmitted) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send('auto-submit', { reason });
  } catch (err) {
    console.error('[AutoSubmit] IPC send failed:', err.message);
  }
}

// ══════════════════════════════════════════════════════
// 5.  LOCKDOWN HELPERS
// ══════════════════════════════════════════════════════
// List of keyboard shortcuts to block during exam only
const EXAM_BLOCKED_SHORTCUTS = [
  'Alt+F4', 'Alt+Tab', 'Alt+Escape',
  'CommandOrControl+W', 'CommandOrControl+Q',
  'CommandOrControl+R', 'CommandOrControl+Shift+R',
  'CommandOrControl+T', 'CommandOrControl+N',
  'CommandOrControl+Tab', 'CommandOrControl+Shift+Tab',
  'CommandOrControl+Shift+I', 'CommandOrControl+Shift+J',
  'CommandOrControl+U', 'CommandOrControl+S',
  'CommandOrControl+P', 'CommandOrControl+C',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'CommandOrControl+Alt+Delete', 'CommandOrControl+Shift+Escape',
  'Meta+D', 'Meta+H', 'Meta+M', 'Super+D',
];

/**
 * registerExamShortcuts — called ONLY when exam starts.
 * Intercepts system-level keys so students cannot escape fullscreen,
 * switch apps, open DevTools, or trigger OS-level actions.
 */
function registerExamShortcuts() {
  EXAM_BLOCKED_SHORTCUTS.forEach((shortcut) => {
    try {
      globalShortcut.register(shortcut, () => {
        // Extra guard: skip if lockdown was lifted between key-press and callback
        if (!isExamStarted || isExamSubmitted) return;
        logViolation('keyboard_shortcut_blocked', { shortcut, severity: 'medium' });
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('show-warning', {
            message: `Keyboard shortcut blocked: ${shortcut}`,
          });
        }
      });
    } catch {
      // Some shortcuts cannot be registered on all platforms — skip silently
    }
  });
  console.log('[Lockdown] Keyboard shortcuts registered (' + EXAM_BLOCKED_SHORTCUTS.length + ' shortcuts blocked)');
}

function enableLockdown() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  isExamStarted = true;
  isExamSubmitted = false;
  lockdownStartTime = Date.now();

  // ── Window-level lockdown ──────────────────────────
  mainWindow.setKiosk(true);                           // Full kiosk — hides taskbar
  mainWindow.setFullScreen(true);                      // Force fullscreen
  mainWindow.setAlwaysOnTop(true, 'screen-saver');     // Stay on top of all overlays
  mainWindow.setVisibleOnAllWorkspaces(true);          // Persist across virtual desktops
  mainWindow.setClosable(false);                       // Disable red X
  mainWindow.setMinimizable(false);                    // Disable yellow minimize
  mainWindow.setMovable(false);                        // Disable window drag

  // ── System-level lockdown ─────────────────────────
  idBlocker = powerSaveBlocker.start('prevent-display-sleep'); // Keep screen alive
  registerExamShortcuts();                             // Block keyboard escape vectors

  console.log('[Lockdown] Exam lockdown ENABLED — kiosk, shortcuts, and power blocker active.');
}

function disableLockdown() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  isExamSubmitted = true;

  // ── Restore window controls ───────────────────────
  mainWindow.setKiosk(false);
  mainWindow.setFullScreen(false);
  mainWindow.setAlwaysOnTop(false);
  mainWindow.setClosable(true);                        // Re-enable red X
  mainWindow.setMinimizable(true);                     // Re-enable minimize
  mainWindow.setMovable(true);

  // ── Release power blocker ─────────────────────────
  if (idBlocker !== null && powerSaveBlocker.isStarted(idBlocker)) {
    powerSaveBlocker.stop(idBlocker);
    idBlocker = null;
  }

  // ── Unblock all keyboard shortcuts ───────────────
  globalShortcut.unregisterAll();

  console.log('[Lockdown] Exam lockdown LIFTED — all controls restored.');
}

// ══════════════════════════════════════════════════════
// 6.  WINDOW CREATION
// ══════════════════════════════════════════════════════
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: '#0A0C11',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,   // must be false for preload to use require
      // webSecurity defaults to true — kept enabled for security
      // webviewTag not needed — removed
      devTools: false,
    },
  });

  // ── Load login page ────────────────────────────────
  mainWindow.loadFile(path.join(__dirname, 'pages', 'login.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });

  // ── Activate lockdown when exam room finishes loading ──
  mainWindow.webContents.on('did-finish-load', () => {
    const url = mainWindow.webContents.getURL();
    if (url.includes('exam-room.html')) {
      enableLockdown();
    }
  });

  // ── Block external navigation ───────────────────────
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      logViolation('unauthorized_navigation', { attempted_url: url, severity: 'high' });
    }
  });

  // ── Block new windows ────────────────────────────────
  mainWindow.webContents.setWindowOpenHandler(() => {
    if (isExamStarted && !isExamSubmitted) {
      logViolation('new_window_attempt', { severity: 'high' });
    }
    return { action: 'deny' };
  });

  // ── Block DevTools ───────────────────────────────────
  mainWindow.webContents.on('devtools-opened', () => {
    mainWindow.webContents.closeDevTools();
  });

  // ── Focus loss ───────────────────────────────────────
  mainWindow.on('blur', () => {
    if (!isExamStarted || isExamSubmitted) return;
    if (Date.now() - lockdownStartTime < 3000) return; // Grace period for fullscreen transition
    logViolation('window_focus_lost', { severity: 'medium' });
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('show-warning', {
        message: 'You left the exam window. This event has been recorded.',
      });
      setTimeout(() => {
        try { if (!mainWindow.isDestroyed()) mainWindow.focus(); } catch (_) { }
      }, 100);
    }
  });

  // ── Prevent fullscreen exit ──────────────────────────
  mainWindow.on('leave-full-screen', () => {
    if (!isExamStarted || isExamSubmitted) return;
    setTimeout(() => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.setFullScreen(true);
        mainWindow.setKiosk(true);
      }
    }, 100);
  });

  // ── Prevent minimize ─────────────────────────────────
  mainWindow.on('minimize', () => {
    if (!isExamStarted || isExamSubmitted) return;
    setTimeout(() => {
      try { if (!mainWindow.isDestroyed()) mainWindow.restore(); } catch (_) { }
    }, 50);
  });

  // ── Block close during exam (single handler, only active during exam) ──
  mainWindow.on('close', (e) => {
    if (isExamStarted && !isExamSubmitted) {
      e.preventDefault();
      console.log('[ALARM] Close attempt during active exam — blocked.');
      logViolation('close_attempt_during_exam', { severity: 'high' });
      if (!mainWindow.isDestroyed()) {
        // Wrapped in try-catch: executeJavaScript can throw if webContents is busy
        try {
          mainWindow.webContents.executeJavaScript(
            `typeof triggerViolation === 'function' && triggerViolation("Window Close Attempt", "You attempted to close the proctoring browser. This is not permitted.")`
          );
        } catch (_) { }
      }
    }
    // If isExamSubmitted is true, close goes through normally — no preventDefault
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // ── Power events (suspend / screen lock) → auto-submit ─
  powerMonitor.on('suspend', () => {
    if (!isExamStarted || isExamSubmitted) return;
    console.log('[ALARM] System suspended during exam.');
    logViolation('system_suspend', { severity: 'high' });
    triggerAutoSubmit('system_suspend');
  });

  powerMonitor.on('lock-screen', () => {
    if (!isExamStarted || isExamSubmitted) return;
    console.log('[ALARM] Screen locked during exam.');
    logViolation('screen_locked', { severity: 'high' });
    triggerAutoSubmit('screen_locked');
  });

  // NOTE: media permission handler is set globally in app.whenReady() below.
  // No need to set it again per-window.
}

// ══════════════════════════════════════════════════════
// 7.  IPC HANDLERS
// ══════════════════════════════════════════════════════

// ── Dynamic Student Login ──────────────────────────────
ipcMain.on('set-student-id', (_event, id) => {
  if (id && id.trim()) {
    STUDENT_ID = id.trim();
    console.log('[IPC] Student ID dynamically updated to:', STUDENT_ID);
  }
});

// ── Dynamic Exam ID (fixes hardcoded EXAM_ID) ──────────────────────
ipcMain.on('set-exam-id', (_event, id) => {
  if (id && id.trim()) {
    EXAM_ID = id.trim();
    console.log('[IPC] Exam ID dynamically updated to:', EXAM_ID);
    // Re-register student in the socket room with the correct exam ID
    if (socket && socket.connected) {
      socket.emit('student:join', { examId: EXAM_ID, studentId: STUDENT_ID });
    }
  }
});

// ── Exam submission ──────────────────────────────────
ipcMain.on('exam-submitted', (_event, payload) => {
  if (payload && payload.reason === 'VERIFIED_SUBMIT') {
    // Idempotency guard — disableLockdown is safe to call twice but log only once
    if (isExamSubmitted) {
      console.log('[IPC] exam-submitted received but already processed — ignoring duplicate.');
      return;
    }
    console.log('[IPC] Verified exam submission received. Lifting lockdown.');
    disableLockdown();

    // Emit lightweight status-only event for live monitoring dashboard.
    // The real score + answers were already saved by the REST API
    // (POST /api/student/exam/:code/submit) before this IPC fires.
    // Do NOT include quizScore here — it would overwrite the correct value with null.
    const statusPayload = {
      examId: EXAM_ID,
      studentId: STUDENT_ID,
      timestamp: Date.now(),
      reason: 'VERIFIED_SUBMIT',
      status: 'submitted_verified',
    };
    if (socket && socket.connected) {
      socket.emit('student:submit', statusPayload);
    } else {
      pendingSubmissionQueue.push(statusPayload);
    }
  } else {
    // Log the actual payload for debugging (fixed: was crashing with undefined `source`)
    const info = payload ? JSON.stringify(payload) : '(empty payload)';
    console.warn('[SECURITY] Ignored unverified submission attempt — payload:', info);
  }
});

// ── Student submits full exam data (from exam-room.html) ─
ipcMain.on('student-submit', (_event, payload) => {
  const fullPayload = {
    examId: EXAM_ID,
    studentId: STUDENT_ID,
    ...payload,
  };
  if (socket && socket.connected) {
    socket.emit('student:submit', fullPayload);
  } else {
    pendingSubmissionQueue.push(fullPayload);
  }
});

// ── AI violation relay ────────────────────────────────
ipcMain.on('report-violation', (_event, data) => {
  logViolation(data.type || 'ai_violation', {
    evidenceDataUrl: data.evidenceDataUrl,
    severity: data.severity,
    desc: data.desc,
    ...data,
  });
});

// Alias used by procter-style preload
ipcMain.on('ai-violation', (_event, data) => {
  logViolation(data.type || 'ai_violation', {
    evidenceDataUrl: data.evidenceDataUrl,
    severity: data.severity,
    ...data,
  });
});

// ── Screenshot evidence relay ─────────────────────────
ipcMain.on('screenshot-captured', (_event, dataUrl) => {
  const payload = {
    examId: EXAM_ID,
    studentId: STUDENT_ID,
    type: 'screenshot_evidence',
    severity: 'info',
    timestamp: Date.now(),
    evidenceDataUrl: dataUrl,
  };
  if (socket && socket.connected) {
    socket.emit('proctor:violation', payload);
  } else {
    pendingViolationQueue.push(payload);
  }
});

// ── Exit app (from Exit buttons in UI) ───────────────
ipcMain.on('exit-app', () => {
  isExamSubmitted = true;
  disableLockdown();
  globalShortcut.unregisterAll();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  if (backendProcess) { try { backendProcess.kill(); } catch (_) { } }
  app.quit();
});

// ── Get AI model base URL ─────────────────────────────
const MODELS_DIR = path.join(__dirname, 'pages', 'models');
const MODELS_BASE_URL = pathToFileURL(MODELS_DIR).toString().replace(/\/?$/, '/');
ipcMain.handle('get-models-base-url', () => MODELS_BASE_URL);

// ── Get student / exam IDs ────────────────────────────
ipcMain.handle('get-student-id', () => STUDENT_ID);
ipcMain.handle('get-exam-id', () => EXAM_ID);
ipcMain.handle('get-server-url', () => PROCTOR_SERVER_URL);

// ── Kiosk attestation ─────────────────────────────────────────────
// Returns a signed proof that the app is running in kiosk mode.
// The backend verifies this HMAC signature to confirm the student
// is genuinely using the lockdown browser, not a regular browser.
const KIOSK_SECRET = process.env.KIOSK_SECRET || 'proctor-kiosk-attestation-key';

ipcMain.handle('get-kiosk-attestation', () => {
  const isKiosk = mainWindow && !mainWindow.isDestroyed() && mainWindow.isKiosk();
  const timestamp = Date.now();
  const signature = crypto
    .createHmac('sha256', KIOSK_SECRET)
    .update(`kiosk:${isKiosk}:${timestamp}`)
    .digest('hex');
  return { isKiosk, timestamp, signature };
});

// ── macOS on-demand camera/mic permission ─────────────────
// Purpose: registers the app with macOS so the system dialog can appear.
// We DON'T gate on the result here because:
//   1. macOS may have previously denied and cached the result without a dialog.
//   2. Electron’s setPermissionRequestHandler already grants all media access.
//   3. The actual getUserMedia() call in the renderer is what triggers the
//      Chromium-level permission (always approved by our handler above).
ipcMain.handle('request-media-permissions', async () => {
  if (process.platform === 'darwin') {
    try {
      // Fire both requests to register the app with macOS System Settings.
      // We await both but ignore the boolean result — even if macOS says
      // 'denied', Electron’s setPermissionRequestHandler will still allow
      // getUserMedia() because it operates at the Chromium layer.
      await systemPreferences.askForMediaAccess('camera').catch(() => { });
      await systemPreferences.askForMediaAccess('microphone').catch(() => { });
    } catch (err) {
      console.warn('[Permissions] askForMediaAccess threw:', err.message);
    }
  }
  // Always return granted — getUserMedia() in exam-room.html will be the
  // real enforcement point. If the user has permanently denied at system
  // level, getUserMedia() will throw NotAllowedError and the exam room
  // shows a clear error message.
  return { camera: true, microphone: true };
});

// ── Open macOS System Settings at Camera privacy section ──
// Called from exam-room when getUserMedia() fails with NotAllowedError
ipcMain.handle('open-camera-settings', async () => {
  try {
    if (process.platform === 'darwin') {
      await shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera'
      );
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ══════════════════════════════════════════════════════
// 8.  APP LIFECYCLE
// ══════════════════════════════════════════════════════
app.whenReady().then(() => {
  // ── Global media permission overrides (camera + mic for proctoring) ──
  // Cover ALL permission string variants that Electron uses across versions.
  const MEDIA_PERMISSIONS = new Set([
    'media', 'camera', 'microphone', 'audioCapture', 'videoCapture',
  ]);

  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return MEDIA_PERMISSIONS.has(permission) ? true : false;
  });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (MEDIA_PERMISSIONS.has(permission)) return callback(true);
    callback(false);
  });

  // ── Start backend, then open window ──────────────────
  // NOTE: Keyboard shortcuts are NOT registered here.
  // They are registered in enableLockdown() (when exam-room.html loads)
  // and unregistered in disableLockdown() (when student submits).
  // This ensures shortcuts are ONLY blocked during the active exam,
  // not on the login page, proctor dashboard, or report page.
  startBackendServer();
  setTimeout(connectBackend, 2000);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (backendProcess) { try { backendProcess.kill(); } catch (_) { } }
    app.quit();
  }
});

app.on('before-quit', (e) => {
  // Prevent quit if exam is still active
  if (isExamStarted && !isExamSubmitted) {
    e.preventDefault();
    logViolation('app_quit_attempt', { severity: 'critical' });
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (backendProcess) { try { backendProcess.kill(); } catch (_) { } }
});
