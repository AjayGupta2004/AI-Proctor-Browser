/* eslint-disable no-console */
/**
 * helpers/index.js — Shared utility functions
 */
const path = require('path')
const fs   = require('fs')
const { v4: uuidv4 } = require('uuid')
const sanitizeHtml = require('sanitize-html')
const pool = require('../db/pool')

// ── Time / JSON ───────────────────────────────────────────────────
function nowIso() { return new Date().toISOString() }
function safeJsonStringify(v) { try { return JSON.stringify(v ?? null) } catch { return '{"error":"unserializable"}' } }
function safeJsonParse(v)     { try { if (v == null) return null; return JSON.parse(v) } catch { return null } }

function normalizeTimestampMs(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts
  if (typeof ts === 'string') { const n = Number(ts); if (Number.isFinite(n)) return n; const p = Date.parse(ts); if (!isNaN(p)) return p }
  return Date.now()
}

// ── Input Sanitization ────────────────────────────────────────────
const sanitize = (s) => sanitizeHtml(String(s || ''), { allowedTags: [], allowedAttributes: {} }).trim()

// ── Evidence ──────────────────────────────────────────────────────
function decodeEvidenceDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null
  const ci = dataUrl.indexOf(','); if (ci < 0) return null
  const header = dataUrl.slice(0, ci); const base64 = dataUrl.slice(ci + 1)
  const match = header.match(/^data:(.+);base64$/); const mime = match ? match[1] : 'image/jpeg'
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg'
  return { buffer: Buffer.from(base64, 'base64'), ext }
}

// ── Legacy exam helpers ───────────────────────────────────────────
async function ensureExam(examId, title = 'Demo Exam') {
  await pool.query(`INSERT INTO exams (id,title,created_at) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`, [examId, title, nowIso()])
}

async function ensureStudent(examId, studentId) {
  await pool.query(
    `INSERT INTO students (id,exam_id,last_seen_at,created_at) VALUES ($1,$2,$3,$4)
     ON CONFLICT (id,exam_id) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at`,
    [studentId, examId, nowIso(), nowIso()])
}

async function computeStudentRisk(examId, studentId, limitMs = null) {
  const weightCase = `CASE WHEN lower(coalesce(severity,''))='critical' THEN 60 WHEN lower(coalesce(severity,''))='high' THEN 30 WHEN lower(coalesce(severity,''))='medium' THEN 20 ELSE 10 END`
  let r
  if (limitMs != null) {
    r = await pool.query(
      `SELECT COALESCE(SUM(${weightCase}),0) AS risk_sum FROM events WHERE exam_id=$1 AND student_id=$2 AND timestamp_ms>=$3`,
      [examId, studentId, Date.now() - limitMs])
  } else {
    r = await pool.query(
      `SELECT COALESCE(SUM(${weightCase}),0) AS risk_sum FROM events WHERE exam_id=$1 AND student_id=$2`,
      [examId, studentId])
  }
  return Math.min(100, Math.floor(Number(r.rows[0].risk_sum) || 0))
}

module.exports = {
  nowIso,
  safeJsonStringify,
  safeJsonParse,
  normalizeTimestampMs,
  sanitize,
  decodeEvidenceDataUrl,
  ensureExam,
  ensureStudent,
  computeStudentRisk,
}
