/**
 * preload.js — Secure IPC bridge for the AI Proctor Browser renderer
 *
 * Exposes a safe, minimal API surface to renderer pages via contextBridge.
 * Node.js APIs are NOT exposed directly — only these specific methods.
 *
 * Security guarantees:
 *  - contextIsolation: true  → renderer JS cannot access Node.js globals
 *  - nodeIntegration: false  → renderer cannot require() anything
 *  - Only the explicitly listed methods below are reachable from the renderer
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

  // ── Exam submission ──────────────────────────────────────────────────
  // IMPORTANT: Must send { reason: 'VERIFIED_SUBMIT' } — a plain string
  // will NOT lift the lockdown (main.js checks payload.reason).
  submitExam: (payload) => ipcRenderer.send('exam-submitted', payload),

  // Send full exam result data (score, answers, etc.) to the backend
  submitFullExam: (payload) => ipcRenderer.send('student-submit', payload),

  // Dynamically set student ID from login screen
  setStudentId: (id) => ipcRenderer.send('set-student-id', id),

  // Dynamically set exam ID from the verified exam code (fixes hardcoded EXAM_ID)
  setExamId: (id) => ipcRenderer.send('set-exam-id', id),

  // ── AI model weights path ────────────────────────────────────────────
  // Returns a file:// URL pointing to pages/models/ directory
  getModelsBaseUrl: () => ipcRenderer.invoke('get-models-base-url'),

  // ── Identity helpers ─────────────────────────────────────────────────
  getStudentId: () => ipcRenderer.invoke('get-student-id'),
  getExamId: () => ipcRenderer.invoke('get-exam-id'),
  getServerUrl: () => ipcRenderer.invoke('get-server-url'),

  // ── Kiosk attestation ───────────────────────────────────────────────
  // Returns a signed proof that the Electron app is running in kiosk mode.
  // Sent to the backend during session creation for verification.
  getKioskAttestation: () => ipcRenderer.invoke('get-kiosk-attestation'),

  // ── macOS on-demand camera / microphone permissions ──────────────────
  // Must be called AFTER login so macOS shows the native permission dialog
  // at a meaningful moment (not at cold app start).
  requestMediaPermissions: () => ipcRenderer.invoke('request-media-permissions'),

  // ── Open macOS System Settings at Camera privacy section ────────────
  // Called when getUserMedia() fails so the student can grant access.
  openCameraSettings: () => ipcRenderer.invoke('open-camera-settings'),

  // ── Violation reporting ──────────────────────────────────────────────
  // AI detections, focus loss, audio events — all go through here.
  reportViolation: (payload) => ipcRenderer.send('report-violation', payload),

  // ── Screenshot / evidence forwarding ────────────────────────────────
  // Sends a base64 JPEG data URL to main.js for storage in the backend.
  sendScreenshot: (dataUrl) => ipcRenderer.send('screenshot-captured', dataUrl),

  // ── Main → Renderer: security warning push ──────────────────────────
  // Called once during exam-room.html init. Clears old listeners first to
  // prevent stacking if the page somehow re-registers.
  onWarning: (callback) => {
    ipcRenderer.removeAllListeners('show-warning');
    ipcRenderer.on('show-warning', (_event, data) => {
      // data can be { message: string } or a plain string
      const message = typeof data === 'string'
        ? data
        : (data && data.message) || 'Security event detected.';
      callback(message);
    });
  },

  // ── Main → Renderer: auto-submit trigger ─────────────────────────────
  // Fired by main.js when the system is suspended or screen is locked
  // during an active exam. Renderer should call submitExam and navigate.
  // Clears old listeners first to prevent duplicate handlers.
  onAutoSubmit: (callback) => {
    ipcRenderer.removeAllListeners('auto-submit');
    ipcRenderer.on('auto-submit', (_event, data) => {
      callback(data);
    });
  },

  // ── Exit the application ─────────────────────────────────────────────
  // Only valid AFTER exam submission. Kills the Electron process cleanly.
  exitApp: () => ipcRenderer.send('exit-app'),
});
