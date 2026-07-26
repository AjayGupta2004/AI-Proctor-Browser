/* eslint-disable no-console */
const crypto = require('crypto')
const path = require('path')
const fs = require('fs')
const http = require('http')

const express = require('express')
const cors = require('cors')
const { Server } = require('socket.io')
const Database = require('better-sqlite3')
const { v4: uuidv4 } = require('uuid')

require('dotenv').config()

const PORT = process.env.PROCTOR_PORT ? Number(process.env.PROCTOR_PORT) : 4000
const EVIDENCE_DIR = path.join(__dirname, 'evidence')
const DATA_DIR = path.join(__dirname, 'data')
const DB_PATH = path.join(DATA_DIR, 'proctoring.sqlite')

const app = express()
app.use(cors({ origin: true, credentials: true }))
app.use(express.json({ limit: '5mb' }))

// Evidence static serving
fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
fs.mkdirSync(DATA_DIR, { recursive: true })
app.use('/evidence', express.static(EVIDENCE_DIR))

// ─── Database ──────────────────────────────────────────────────────
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS exams (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      ended_at TEXT
    );

    CREATE TABLE IF NOT EXISTS students (
      id TEXT NOT NULL,
      exam_id TEXT NOT NULL,
      last_seen_at TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (id, exam_id),
      FOREIGN KEY (exam_id) REFERENCES exams(id)
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      exam_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      type TEXT NOT NULL,
      severity TEXT,
      timestamp_ms INTEGER NOT NULL,
      details_json TEXT,
      evidence_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (exam_id) REFERENCES exams(id)
    );

    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY,
      exam_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS student_submissions (
      id TEXT PRIMARY KEY,
      exam_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      submitted_reason TEXT,
      quiz_score INTEGER,
      quiz_total INTEGER,
      suspicious_count INTEGER,
      integrity_risk_total INTEGER,
      answers_json TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (exam_id, student_id),
      FOREIGN KEY (exam_id) REFERENCES exams(id)
    );

    CREATE INDEX IF NOT EXISTS idx_events_exam_time ON events(exam_id, timestamp_ms);
    CREATE INDEX IF NOT EXISTS idx_events_student ON events(exam_id, student_id);

    CREATE TABLE IF NOT EXISTS user_accounts (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      email TEXT,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'teacher',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user_accounts(id)
    );

    CREATE TABLE IF NOT EXISTS teacher_exams (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      subject TEXT,
      duration INTEGER NOT NULL DEFAULT 60,
      total_marks INTEGER NOT NULL DEFAULT 100,
      passing_marks INTEGER NOT NULL DEFAULT 40,
      status TEXT NOT NULL DEFAULT 'draft',
      exam_code TEXT UNIQUE,
      allow_backtrack INTEGER NOT NULL DEFAULT 1,
      shuffle_questions INTEGER NOT NULL DEFAULT 0,
      show_results INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      start_time TEXT,
      end_time TEXT
    );

    CREATE TABLE IF NOT EXISTS exam_questions (
      id TEXT PRIMARY KEY,
      exam_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'multiple-choice',
      text TEXT NOT NULL,
      options TEXT,
      correct_answer TEXT,
      marks INTEGER NOT NULL DEFAULT 1,
      negative_marks REAL NOT NULL DEFAULT 0,
      explanation TEXT,
      order_idx INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (exam_id) REFERENCES teacher_exams(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS teacher_exam_sessions (
      id TEXT PRIMARY KEY,
      exam_id TEXT NOT NULL,
      student_name TEXT NOT NULL,
      student_roll TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_progress',
      score INTEGER,
      total_marks INTEGER,
      answers_json TEXT,
      violations INTEGER NOT NULL DEFAULT 0,
      risk_score INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      submitted_at TEXT,
      FOREIGN KEY (exam_id) REFERENCES teacher_exams(id)
    );

    CREATE INDEX IF NOT EXISTS idx_teacher_exam_sessions ON teacher_exam_sessions(exam_id);
  `)

  // Migration: add exam_code to existing teacher_exams table if missing
  try { db.exec(`ALTER TABLE teacher_exams ADD COLUMN exam_code TEXT`) } catch (_) {}
  // Migration: add negative_marks to existing exam_questions if missing
  try { db.exec(`ALTER TABLE exam_questions ADD COLUMN negative_marks REAL NOT NULL DEFAULT 0`) } catch (_) {}
}

function nowIso() {
  return new Date().toISOString()
}

function ensureExam(examId, title = 'Demo Exam') {
  db.prepare(`
    INSERT OR IGNORE INTO exams (id, title, created_at)
    VALUES (?, ?, ?)
  `).run(examId, title, nowIso())
}

function ensureStudent(examId, studentId) {
  db.prepare(`
    INSERT INTO students (id, exam_id, last_seen_at, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id, exam_id) DO UPDATE SET
      last_seen_at = excluded.last_seen_at
  `).run(studentId, examId, nowIso(), nowIso())
}

const severityWeights = {
  critical: 60,
  high: 30,
  medium: 20,
  low: 10,
}

function severityToWeight(sev) {
  if (!sev) return 10
  const key = String(sev).toLowerCase()
  return severityWeights[key] ?? 10
}

function computeStudentRisk(examId, studentId, limitMs = null) {
  let stmt
  if (limitMs != null) {
    stmt = db.prepare(
      `
      SELECT COALESCE(SUM(severity_weight), 0) AS risk_sum
      FROM (
        SELECT (CASE
          WHEN lower(coalesce(severity, '')) = 'critical' THEN 60
          WHEN lower(coalesce(severity, '')) = 'high' THEN 30
          WHEN lower(coalesce(severity, '')) = 'medium' THEN 20
          ELSE 10
        END) AS severity_weight
        FROM events
        WHERE exam_id = ?
          AND student_id = ?
          AND timestamp_ms >= ?
      ) t
      `
    )
    const since = Date.now() - limitMs
    const row = stmt.get(examId, studentId, since)
    return Math.min(100, Math.floor(row.risk_sum || 0))
  }

  stmt = db.prepare(
    `
    SELECT COALESCE(SUM(severity_weight), 0) AS risk_sum
    FROM (
      SELECT (CASE
        WHEN lower(coalesce(severity, '')) = 'critical' THEN 60
        WHEN lower(coalesce(severity, '')) = 'high' THEN 30
        WHEN lower(coalesce(severity, '')) = 'medium' THEN 20
        ELSE 10
      END) AS severity_weight
      FROM events
      WHERE exam_id = ?
        AND student_id = ?
    ) t
    `
  )
  const row = stmt.get(examId, studentId)
  return Math.min(100, Math.floor(row.risk_sum || 0))
}

function normalizeTimestampMs(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts
  if (typeof ts === 'string') {
    const maybeNum = Number(ts)
    if (Number.isFinite(maybeNum)) return maybeNum
    const parsed = Date.parse(ts)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Date.now()
}

function decodeEvidenceDataUrl(evidenceDataUrl) {
  if (!evidenceDataUrl || typeof evidenceDataUrl !== 'string') return null
  if (!evidenceDataUrl.startsWith('data:')) return null
  const commaIdx = evidenceDataUrl.indexOf(',')
  if (commaIdx < 0) return null

  const header = evidenceDataUrl.slice(0, commaIdx)
  const base64 = evidenceDataUrl.slice(commaIdx + 1)

  const match = header.match(/^data:(.+);base64$/)
  const mime = match ? match[1] : 'image/jpeg'

  const ext =
    mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg'

  const buffer = Buffer.from(base64, 'base64')
  return { buffer, ext }
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return JSON.stringify({ error: 'unserializable_details' })
  }
}

function safeJsonParse(value) {
  try {
    if (value == null) return null
    return JSON.parse(value)
  } catch {
    return null
  }
}

// ─── REST: health ──────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: nowIso() })
})

// ─── REST: report ──────────────────────────────────────────────────
app.get('/api/exams/:examId/report', (req, res) => {
  const examId = String(req.params.examId)
  const exam = db.prepare(`SELECT * FROM exams WHERE id = ?`).get(examId)
  if (!exam) return res.status(404).json({ error: 'exam_not_found' })

  const students = db.prepare(
    `SELECT id FROM students WHERE exam_id = ? ORDER BY created_at ASC`
  ).all(examId)

  const timeline = db.prepare(
    `SELECT * FROM events WHERE exam_id = ? ORDER BY timestamp_ms ASC LIMIT 5000`
  ).all(examId)

  const evidenceById = new Map()
  const evidenceRows = db.prepare(
    `SELECT * FROM evidence WHERE exam_id = ?`
  ).all(examId)
  for (const ev of evidenceRows) {
    evidenceById.set(ev.id, ev)
  }

  const studentReports = students.map((s) => {
    const riskTotal = computeStudentRisk(examId, s.id)
    const riskRecent = computeStudentRisk(examId, s.id, 60_000)

    const submission = db
      .prepare(`SELECT * FROM student_submissions WHERE exam_id = ? AND student_id = ?`)
      .get(examId, s.id)

    const suspiciousCount =
      submission?.suspicious_count ??
      db.prepare(`SELECT COUNT(*) AS c FROM events WHERE exam_id = ? AND student_id = ?`).get(examId, s.id).c

    return {
      studentId: s.id,
      riskTotal,
      riskRecent,
      suspiciousCount: suspiciousCount ?? 0,
      quizScore: submission?.quiz_score ?? null,
      quizTotal: submission?.quiz_total ?? null,
      submissionReason: submission?.submitted_reason ?? null,
      submissionEndedAt: submission?.ended_at ?? null,
    }
  })

  const integritySummary = {
    studentsCount: students.length,
    highestRisk: studentReports.reduce((acc, r) => Math.max(acc, r.riskTotal), 0),
  }

  const timelineEvents = timeline.map((e) => {
    const evRow = evidenceById.get(e.evidence_id) || null
    return {
      id: e.id,
      studentId: e.student_id,
      type: e.type,
      severity: e.severity ?? null,
      timestampMs: e.timestamp_ms,
      details: e.details_json ? safeJsonParse(e.details_json) : null,
      evidenceUrl: evRow ? `/evidence/${encodeURIComponent(evRow.file_name)}` : null,
    }
  })

  res.json({
    exam: {
      id: exam.id,
      title: exam.title,
      status: exam.status,
      createdAt: exam.created_at,
      endedAt: exam.ended_at,
    },
    integritySummary,
    students: studentReports,
    timeline: timelineEvents,
  })
})

app.post('/api/exams', (req, res) => {
  const { id, title } = req.body || {}
  const examId = String(id || uuidv4())
  const examTitle = String(title || 'Demo Exam')
  ensureExam(examId, examTitle)
  res.json({ examId, title: examTitle })
})

app.post('/api/exams/:examId/end', (req, res) => {
  const examId = String(req.params.examId)
  ensureExam(examId)
  db.prepare(`UPDATE exams SET status = 'ended', ended_at = ? WHERE id = ?`).run(nowIso(), examId)

  const stmtExam = db.prepare(`SELECT * FROM exams WHERE id = ?`).get(examId)
  const students = db.prepare(`SELECT id FROM students WHERE exam_id = ? ORDER BY created_at ASC`).all(examId)
  const timeline = db.prepare(
    `SELECT * FROM events WHERE exam_id = ? ORDER BY timestamp_ms ASC LIMIT 5000`
  ).all(examId)

  const evidenceById = new Map()
  const evidenceRows = db.prepare(`SELECT * FROM evidence WHERE exam_id = ?`).all(examId)
  for (const ev of evidenceRows) evidenceById.set(ev.id, ev)

  const studentReports = students.map((s) => {
    const riskTotal = computeStudentRisk(examId, s.id)
    const riskRecent = computeStudentRisk(examId, s.id, 60_000)

    const submission = db
      .prepare(`SELECT * FROM student_submissions WHERE exam_id = ? AND student_id = ?`)
      .get(examId, s.id)

    const suspiciousCount =
      submission?.suspicious_count ??
      db.prepare(`SELECT COUNT(*) AS c FROM events WHERE exam_id = ? AND student_id = ?`).get(examId, s.id).c

    return {
      studentId: s.id,
      riskTotal,
      riskRecent,
      suspiciousCount: suspiciousCount ?? 0,
      quizScore: submission?.quiz_score ?? null,
      quizTotal: submission?.quiz_total ?? null,
      submissionReason: submission?.submitted_reason ?? null,
      submissionEndedAt: submission?.ended_at ?? null,
    }
  })

  const integritySummary = {
    studentsCount: students.length,
    highestRisk: studentReports.reduce((acc, r) => Math.max(acc, r.riskTotal), 0),
  }

  const timelineEvents = timeline.map((e) => {
    const evRow = evidenceById.get(e.evidence_id) || null
    return {
      id: e.id,
      studentId: e.student_id,
      type: e.type,
      severity: e.severity ?? null,
      timestampMs: e.timestamp_ms,
      details: e.details_json ? safeJsonParse(e.details_json) : null,
      evidenceUrl: evRow ? `/evidence/${encodeURIComponent(evRow.file_name)}` : null,
    }
  })

  res.json({
    exam: {
      id: stmtExam.id,
      title: stmtExam.title,
      status: stmtExam.status,
      createdAt: stmtExam.created_at,
      endedAt: stmtExam.ended_at,
    },
    integritySummary,
    students: studentReports,
    timeline: timelineEvents,
  })
})

// ─── Auth Helpers ──────────────────────────────────────────────────
function hashPassword(password, salt) {
  return crypto.createHmac('sha256', salt).update(password).digest('hex')
}
function generateSalt() {
  return crypto.randomBytes(16).toString('hex')
}
function generateToken() {
  return crypto.randomBytes(32).toString('hex')
}
function getTokenExpiry() {
  const d = new Date(); d.setDate(d.getDate() + 7); return d.toISOString()
}
function requireAuth(req, res, next) {
  const auth = req.headers['authorization'] || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return res.status(401).json({ error: 'No token provided' })
  const now = new Date().toISOString()
  const session = db.prepare('SELECT * FROM auth_sessions WHERE token = ? AND expires_at > ?').get(token, now)
  if (!session) return res.status(401).json({ error: 'Invalid or expired token' })
  const user = db.prepare('SELECT * FROM user_accounts WHERE id = ? AND is_active = 1').get(session.user_id)
  if (!user) return res.status(401).json({ error: 'User not found' })
  req.user = user
  next()
}

// ─── Auth Routes ───────────────────────────────────────────────────
app.post('/api/auth/register', (req, res) => {
  try {
    const { username, password, fullName, email } = req.body || {}
    if (!username || !password || !fullName) return res.status(400).json({ error: 'username, password and fullName are required' })
    const existing = db.prepare('SELECT id FROM user_accounts WHERE username = ?').get(username)
    if (existing) return res.status(409).json({ error: 'Username already taken' })
    const salt = generateSalt()
    const hash = hashPassword(password, salt)
    const id = uuidv4()
    db.prepare('INSERT INTO user_accounts (id,username,full_name,email,password_hash,salt,role,is_active,created_at) VALUES (?,?,?,?,?,?,?,1,?)').run(id, username, fullName, email || null, hash, salt, 'teacher', nowIso())
    res.status(201).json({ ok: true, id, username, fullName, role: 'teacher' })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body || {}
    if (!username || !password) return res.status(400).json({ error: 'username and password required' })
    const user = db.prepare('SELECT * FROM user_accounts WHERE username = ? AND is_active = 1').get(username)
    if (!user) return res.status(401).json({ error: 'Invalid credentials' })
    const hash = hashPassword(password, user.salt)
    if (hash !== user.password_hash) return res.status(401).json({ error: 'Invalid credentials' })
    const token = generateToken()
    db.prepare('INSERT INTO auth_sessions (token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(token, user.id, nowIso(), getTokenExpiry())
    res.json({ ok: true, token, user: { id: user.id, username: user.username, fullName: user.full_name, email: user.email, role: user.role } })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/auth/me', requireAuth, (req, res) => {
  const u = req.user
  res.json({ id: u.id, username: u.username, fullName: u.full_name, email: u.email, role: u.role })
})

app.post('/api/auth/logout', requireAuth, (req, res) => {
  const token = req.headers['authorization'].slice(7)
  db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token)
  res.json({ ok: true })
})

// ─── Public Student API (no auth required) ────────────────────────
// Fetch exam metadata + questions by exam code
app.get('/api/student/exam/:code', (req, res) => {
  try {
    const code = (req.params.code || '').trim().toUpperCase()
    const exam = db.prepare('SELECT * FROM teacher_exams WHERE exam_code=? AND status IN (\'published\',\'active\')').get(code)
    if (!exam) return res.status(404).json({ error: 'Exam not found or not available. Check the code and try again.' })
    const questions = db.prepare('SELECT id,type,text,options,marks,negative_marks,order_idx FROM exam_questions WHERE exam_id=? ORDER BY order_idx ASC').all(exam.id)
    questions.forEach(q => { try { q.options = JSON.parse(q.options || '[]') } catch { q.options = [] } })
    // Shuffle if enabled
    if (exam.shuffle_questions) {
      for (let i = questions.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [questions[i], questions[j]] = [questions[j], questions[i]]
      }
    }
    res.json({
      id: exam.id, title: exam.title, description: exam.description, subject: exam.subject,
      duration: exam.duration, totalMarks: exam.total_marks, passingMarks: exam.passing_marks,
      allowBacktrack: exam.allow_backtrack, showResults: exam.show_results, examCode: exam.exam_code,
      questions
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Start a student session
app.post('/api/student/exam/:code/session', (req, res) => {
  try {
    const code = (req.params.code || '').trim().toUpperCase()
    const exam = db.prepare('SELECT * FROM teacher_exams WHERE exam_code=? AND status IN (\'published\',\'active\')').get(code)
    if (!exam) return res.status(404).json({ error: 'Exam not found or not active.' })
    const { studentName, studentRoll } = req.body || {}
    if (!studentName || !studentRoll) return res.status(400).json({ error: 'studentName and studentRoll required' })
    const sessionId = uuidv4()
    db.prepare('INSERT INTO teacher_exam_sessions (id,exam_id,student_name,student_roll,status,violations,risk_score,started_at) VALUES (?,?,?,?,\'in_progress\',0,0,?)').run(sessionId, exam.id, studentName, studentRoll, nowIso())
    res.status(201).json({ sessionId, examId: exam.id })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Submit student answers
app.post('/api/student/exam/:code/submit', (req, res) => {
  try {
    const code = (req.params.code || '').trim().toUpperCase()
    const exam = db.prepare('SELECT * FROM teacher_exams WHERE exam_code=?').get(code)
    if (!exam) return res.status(404).json({ error: 'Exam not found.' })
    const { sessionId, studentName, studentRoll, answers, violations, riskScore } = req.body || {}
    // Calculate score with negative marking + tally correct/wrong
    const questions = db.prepare('SELECT * FROM exam_questions WHERE exam_id=?').all(exam.id)
    let score = 0
    let correctCount = 0
    let wrongCount = 0
    let answeredCount = 0
    questions.forEach(q => {
      const studentAns = (answers || {})[q.id]
      if (studentAns === undefined || studentAns === null || studentAns === '') return // unattempted
      answeredCount++
      if (String(studentAns).trim() === String(q.correct_answer).trim()) {
        score += Number(q.marks) || 1
        correctCount++
      } else {
        score -= Number(q.negative_marks) || 0
        wrongCount++
      }
    })
    score = Math.max(0, score)
    const now = nowIso()
    if (sessionId) {
      db.prepare('UPDATE teacher_exam_sessions SET status=\'submitted\',score=?,total_marks=?,answers_json=?,violations=?,risk_score=?,submitted_at=? WHERE id=?').run(score, exam.total_marks, JSON.stringify(answers||{}), violations||0, riskScore||0, now, sessionId)
    } else {
      const existing = db.prepare('SELECT id FROM teacher_exam_sessions WHERE exam_id=? AND student_roll=?').get(exam.id, studentRoll||'')
      if (existing) {
        db.prepare('UPDATE teacher_exam_sessions SET status=\'submitted\',score=?,total_marks=?,answers_json=?,violations=?,risk_score=?,submitted_at=? WHERE id=?').run(score, exam.total_marks, JSON.stringify(answers||{}), violations||0, riskScore||0, now, existing.id)
      } else {
        db.prepare('INSERT INTO teacher_exam_sessions (id,exam_id,student_name,student_roll,status,score,total_marks,answers_json,violations,risk_score,started_at,submitted_at) VALUES (?,?,?,?,\'submitted\',?,?,?,?,?,?,?)').run(uuidv4(), exam.id, studentName||'Unknown', studentRoll||'UNKNOWN', score, exam.total_marks, JSON.stringify(answers||{}), violations||0, riskScore||0, now, now)
      }
    }
    const passed = score >= exam.passing_marks
    res.json({ ok: true, score, totalMarks: exam.total_marks, passed, passingMarks: exam.passing_marks, showResults: exam.show_results, correctCount, wrongCount, answeredCount })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ─── Teacher Exam Routes ───────────────────────────────────────────
app.get('/api/teacher/exams', requireAuth, (req, res) => {
  try {
    const { status } = req.query
    let query = 'SELECT e.*, (SELECT COUNT(*) FROM exam_questions q WHERE q.exam_id=e.id) as question_count, (SELECT COUNT(*) FROM teacher_exam_sessions s WHERE s.exam_id=e.id) as attempt_count FROM teacher_exams e WHERE e.created_by=?'
    const params = [req.user.id]
    if (status) { query += ' AND e.status=?'; params.push(status) }
    query += ' ORDER BY e.created_at DESC'
    const exams = db.prepare(query).all(...params)
    res.json(exams)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/teacher/exams', requireAuth, (req, res) => {
  try {
    // Fix #5: strip HTML tags from all text inputs before saving
    const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, '').trim()
    const title       = stripHtml(req.body?.title)
    const description = stripHtml(req.body?.description)
    const subject     = stripHtml(req.body?.subject)
    const { duration, totalMarks, passingMarks, allowBacktrack, shuffleQuestions, showResults, examCode } = req.body || {}
    if (!title || !duration || !passingMarks) return res.status(400).json({ error: 'title, duration, passingMarks required' })
    const id = uuidv4()
    const now = nowIso()
    const code = (examCode || '').trim().toUpperCase() || Math.random().toString(36).substring(2,8).toUpperCase()
    const codeExists = db.prepare('SELECT id FROM teacher_exams WHERE exam_code=?').get(code)
    if (codeExists) return res.status(409).json({ error: 'Exam code already taken. Choose a different code.' })
    // totalMarks will be updated after questions are saved via bulk endpoint
    db.prepare('INSERT INTO teacher_exams (id,title,description,subject,duration,total_marks,passing_marks,status,exam_code,allow_backtrack,shuffle_questions,show_results,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, title, description||null, subject||null, Number(duration), Number(totalMarks)||0, Number(passingMarks), 'draft', code, allowBacktrack?1:0, shuffleQuestions?1:0, showResults?1:0, req.user.id, now, now)
    const exam = db.prepare('SELECT * FROM teacher_exams WHERE id=?').get(id)
    res.status(201).json(exam)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/teacher/exams/:id', requireAuth, (req, res) => {
  try {
    const exam = db.prepare('SELECT * FROM teacher_exams WHERE id=? AND created_by=?').get(req.params.id, req.user.id)
    if (!exam) return res.status(404).json({ error: 'Exam not found' })
    const questions = db.prepare('SELECT * FROM exam_questions WHERE exam_id=? ORDER BY order_idx ASC').all(req.params.id)
    questions.forEach(q => { try { q.options = JSON.parse(q.options || '[]') } catch { q.options = [] } })
    res.json({ ...exam, questions })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.put('/api/teacher/exams/:id', requireAuth, (req, res) => {
  try {
    const exam = db.prepare('SELECT id FROM teacher_exams WHERE id=? AND created_by=?').get(req.params.id, req.user.id)
    if (!exam) return res.status(404).json({ error: 'Exam not found' })
    const { title, description, subject, duration, totalMarks, passingMarks, allowBacktrack, shuffleQuestions, showResults } = req.body || {}
    db.prepare('UPDATE teacher_exams SET title=?,description=?,subject=?,duration=?,total_marks=?,passing_marks=?,allow_backtrack=?,shuffle_questions=?,show_results=?,updated_at=? WHERE id=?').run(title, description||null, subject||null, Number(duration), Number(totalMarks), Number(passingMarks), allowBacktrack?1:0, shuffleQuestions?1:0, showResults?1:0, nowIso(), req.params.id)
    const updated = db.prepare('SELECT * FROM teacher_exams WHERE id=?').get(req.params.id)
    res.json(updated)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.delete('/api/teacher/exams/:id', requireAuth, (req, res) => {
  try {
    const exam = db.prepare('SELECT id,status FROM teacher_exams WHERE id=? AND created_by=?').get(req.params.id, req.user.id)
    if (!exam) return res.status(404).json({ error: 'Exam not found' })
    if (exam.status === 'active') return res.status(400).json({ error: 'Cannot delete an active exam. End it first.' })
    db.prepare('DELETE FROM teacher_exams WHERE id=?').run(req.params.id)
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.put('/api/teacher/exams/:id/publish', requireAuth, (req, res) => {
  try {
    const exam = db.prepare('SELECT * FROM teacher_exams WHERE id=? AND created_by=?').get(req.params.id, req.user.id)
    if (!exam) return res.status(404).json({ error: 'Exam not found' })
    const qCount = db.prepare('SELECT COUNT(*) as c FROM exam_questions WHERE exam_id=?').get(req.params.id)
    if (qCount.c === 0) return res.status(400).json({ error: 'Add at least one question before publishing' })
    db.prepare("UPDATE teacher_exams SET status='published',updated_at=? WHERE id=?").run(nowIso(), req.params.id)
    res.json(db.prepare('SELECT * FROM teacher_exams WHERE id=?').get(req.params.id))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.put('/api/teacher/exams/:id/activate', requireAuth, (req, res) => {
  try {
    const exam = db.prepare('SELECT id FROM teacher_exams WHERE id=? AND created_by=?').get(req.params.id, req.user.id)
    if (!exam) return res.status(404).json({ error: 'Exam not found' })
    db.prepare("UPDATE teacher_exams SET status='active',start_time=?,updated_at=? WHERE id=?").run(nowIso(), nowIso(), req.params.id)
    res.json(db.prepare('SELECT * FROM teacher_exams WHERE id=?').get(req.params.id))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.put('/api/teacher/exams/:id/end', requireAuth, (req, res) => {
  try {
    const exam = db.prepare('SELECT id FROM teacher_exams WHERE id=? AND created_by=?').get(req.params.id, req.user.id)
    if (!exam) return res.status(404).json({ error: 'Exam not found' })
    db.prepare("UPDATE teacher_exams SET status='ended',end_time=?,updated_at=? WHERE id=?").run(nowIso(), nowIso(), req.params.id)
    res.json(db.prepare('SELECT * FROM teacher_exams WHERE id=?').get(req.params.id))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ─── Question Routes ───────────────────────────────────────────────
app.get('/api/teacher/exams/:id/questions', requireAuth, (req, res) => {
  try {
    const exam = db.prepare('SELECT id FROM teacher_exams WHERE id=? AND created_by=?').get(req.params.id, req.user.id)
    if (!exam) return res.status(404).json({ error: 'Exam not found' })
    const questions = db.prepare('SELECT * FROM exam_questions WHERE exam_id=? ORDER BY order_idx ASC').all(req.params.id)
    questions.forEach(q => { try { q.options = JSON.parse(q.options || '[]') } catch { q.options = [] } })
    res.json(questions)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/teacher/exams/:id/questions/bulk', requireAuth, (req, res) => {
  try {
    const exam = db.prepare('SELECT id FROM teacher_exams WHERE id=? AND created_by=?').get(req.params.id, req.user.id)
    if (!exam) return res.status(404).json({ error: 'Exam not found' })
    const { questions } = req.body || {}
    if (!Array.isArray(questions) || questions.length === 0) return res.status(400).json({ error: 'questions array required' })
    db.prepare('DELETE FROM exam_questions WHERE exam_id=?').run(req.params.id)
    const stmt = db.prepare('INSERT INTO exam_questions (id,exam_id,type,text,options,correct_answer,marks,negative_marks,explanation,order_idx,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, '').trim()
    const insertMany = db.transaction((qs) => {
      qs.forEach((q, idx) => stmt.run(uuidv4(), req.params.id, q.type||'multiple-choice', stripHtml(q.text), JSON.stringify(q.options||[]), q.correctAnswer||'', Number(q.marks)||1, Number(q.negativeMarks)||0, stripHtml(q.explanation), idx, nowIso()))
    })
    insertMany(questions)
    // Auto-update total_marks = sum of question marks
    const totalMarksSum = questions.reduce((sum, q) => sum + (Number(q.marks) || 1), 0)
    db.prepare('UPDATE teacher_exams SET total_marks=?,updated_at=? WHERE id=?').run(totalMarksSum, nowIso(), req.params.id)
    const saved = db.prepare('SELECT * FROM exam_questions WHERE exam_id=? ORDER BY order_idx ASC').all(req.params.id)
    saved.forEach(q => { try { q.options = JSON.parse(q.options||'[]') } catch { q.options = [] } })
    res.json(saved)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.put('/api/teacher/questions/:qId', requireAuth, (req, res) => {
  try {
    const q = db.prepare('SELECT eq.* FROM exam_questions eq JOIN teacher_exams e ON e.id=eq.exam_id WHERE eq.id=? AND e.created_by=?').get(req.params.qId, req.user.id)
    if (!q) return res.status(404).json({ error: 'Question not found' })
    const { type, text, options, correctAnswer, marks, explanation } = req.body || {}
    db.prepare('UPDATE exam_questions SET type=?,text=?,options=?,correct_answer=?,marks=?,explanation=? WHERE id=?').run(type||q.type, text||q.text, JSON.stringify(options||[]), correctAnswer||'', Number(marks)||q.marks, explanation||'', req.params.qId)
    res.json(db.prepare('SELECT * FROM exam_questions WHERE id=?').get(req.params.qId))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.delete('/api/teacher/questions/:qId', requireAuth, (req, res) => {
  try {
    const q = db.prepare('SELECT eq.id FROM exam_questions eq JOIN teacher_exams e ON e.id=eq.exam_id WHERE eq.id=? AND e.created_by=?').get(req.params.qId, req.user.id)
    if (!q) return res.status(404).json({ error: 'Question not found' })
    db.prepare('DELETE FROM exam_questions WHERE id=?').run(req.params.qId)
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ─── Results & Reports ─────────────────────────────────────────────
app.get('/api/teacher/exams/:id/results', requireAuth, (req, res) => {
  try {
    const exam = db.prepare('SELECT * FROM teacher_exams WHERE id=? AND created_by=?').get(req.params.id, req.user.id)
    if (!exam) return res.status(404).json({ error: 'Exam not found' })
    const sessions = db.prepare("SELECT * FROM teacher_exam_sessions WHERE exam_id=? ORDER BY submitted_at DESC").all(req.params.id)
    const completed = sessions.filter(s => s.status === 'submitted')
    const totalStudents = completed.length
    const avgScore = totalStudents ? Math.round(completed.reduce((sum,s) => sum+(s.score||0), 0) / totalStudents) : 0
    const highestScore = totalStudents ? Math.max(...completed.map(s=>s.score||0)) : 0
    const passCount = completed.filter(s => (s.score||0) >= exam.passing_marks).length
    const passRate = totalStudents ? Math.round((passCount/totalStudents)*100) : 0
    res.json({ exam, sessions: completed, statistics: { totalStudents, avgScore, highestScore, passRate, passCount } })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/teacher/exams/:id/results/export', requireAuth, (req, res) => {
  try {
    const exam = db.prepare('SELECT * FROM teacher_exams WHERE id=? AND created_by=?').get(req.params.id, req.user.id)
    if (!exam) return res.status(404).json({ error: 'Exam not found' })
    const sessions = db.prepare("SELECT * FROM teacher_exam_sessions WHERE exam_id=? AND status='submitted' ORDER BY score DESC").all(req.params.id)
    let csv = 'Rank,Student Name,Roll Number,Score,Total Marks,Percentage,Status,Violations,Risk Score,Submitted At\n'
    sessions.forEach((s, i) => {
      const pct = exam.total_marks ? Math.round((s.score||0)/exam.total_marks*100) : 0
      const status = (s.score||0) >= exam.passing_marks ? 'Pass' : 'Fail'
      csv += `${i+1},"${s.student_name}","${s.student_roll}",${s.score||0},${exam.total_marks},${pct}%,${status},${s.violations||0},${s.risk_score||0}%,"${s.submitted_at||''}"\n`
    })
    res.setHeader('Content-Type','text/csv')
    res.setHeader('Content-Disposition',`attachment; filename="results-${exam.title.replace(/[^a-z0-9]/gi,'_')}.csv"`)
    res.send(csv)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ─── Live monitoring — active sessions for an exam ─────────────────
app.get('/api/teacher/exams/:id/live', requireAuth, (req, res) => {
  try {
    const exam = db.prepare('SELECT id,title FROM teacher_exams WHERE id=? AND created_by=?').get(req.params.id, req.user.id)
    if (!exam) return res.status(404).json({ error: 'Exam not found' })
    const sessions = db.prepare("SELECT * FROM teacher_exam_sessions WHERE exam_id=? AND status='in_progress' ORDER BY started_at ASC").all(req.params.id)
    res.json({ exam, sessions })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ─── Student records (all students across all teacher exams) ────────
app.get('/api/teacher/students', requireAuth, (req, res) => {
  try {
    const students = db.prepare(`
      SELECT s.student_name, s.student_roll,
        COUNT(*) as total_exams,
        SUM(CASE WHEN s.status='submitted' THEN 1 ELSE 0 END) as completed,
        ROUND(AVG(CASE WHEN s.status='submitted' THEN CAST(s.score AS REAL) END),1) as avg_score,
        SUM(s.violations) as total_violations
      FROM teacher_exam_sessions s
      JOIN teacher_exams e ON e.id=s.exam_id
      WHERE e.created_by=?
      GROUP BY s.student_roll, s.student_name
      ORDER BY s.student_name ASC
    `).all(req.user.id)
    res.json(students)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/teacher/students/:roll', requireAuth, (req, res) => {
  try {
    const roll = req.params.roll
    const sessions = db.prepare(`
      SELECT s.*, e.title as exam_title, e.total_marks as exam_total_marks, e.passing_marks as exam_passing_marks, e.subject as exam_subject
      FROM teacher_exam_sessions s
      JOIN teacher_exams e ON e.id=s.exam_id
      WHERE e.created_by=? AND s.student_roll=?
      ORDER BY s.started_at DESC
    `).all(req.user.id, roll)
    if (sessions.length === 0) return res.status(404).json({ error: 'Student not found' })
    const completed = sessions.filter(s => s.status === 'submitted')
    const avgScore = completed.length ? Math.round(completed.reduce((sum,s)=>sum+(s.score||0),0)/completed.length) : 0
    res.json({
      studentName: sessions[0].student_name,
      studentRoll: sessions[0].student_roll,
      sessions,
      statistics: { totalExams: sessions.length, completed: completed.length, avgScore, totalViolations: sessions.reduce((sum,s)=>sum+(s.violations||0),0) }
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ─── Socket.io ─────────────────────────────────────────────────────
const server = http.createServer(app)
const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true,
  },
  // Base64 screenshots can be large
  maxHttpBufferSize: 50 * 1024 * 1024,
})

function addOrUpdateStudent(examId, studentId) {
  ensureExam(examId)
  ensureStudent(examId, studentId)
}

io.on('connection', (socket) => {
  console.log('[Socket] client connected:', socket.id)

  socket.on('exam:join', ({ examId }) => {
    const room = `exam:${examId}`
    socket.join(room)
    socket.data.examId = String(examId)
  })

  socket.on('student:join', ({ examId, studentId }) => {
    const room = `exam:${examId}`
    const sId = String(studentId)
    socket.join(room)
    socket.data.examId = String(examId)
    socket.data.studentId = sId
    addOrUpdateStudent(String(examId), sId)
    console.log('[Socket] student joined:', sId, 'exam:', examId)
  })

  socket.on('proctor:violation', (payload) => {
    try {
      if (!payload || typeof payload !== 'object') return
      const examId = String(payload.examId || '')
      const studentId = String(payload.studentId || socket.data.studentId || '')
      const type = String(payload.type || 'unknown_violation')
      if (!examId || !studentId) return

      const timestampMs = normalizeTimestampMs(payload.timestamp)
      const severity = payload.severity ?? null

      ensureExam(examId)
      ensureStudent(examId, studentId)

      const eventId = uuidv4()
      const evidenceDataUrl = payload.evidenceDataUrl || null

      const detailsForDb = payload.details !== undefined ? payload.details : { type, ...payload }
      const detailsJson = safeJsonStringify(detailsForDb)
      const detailsForEmit = detailsForDb

      const detailsStmt = db.prepare(`
        INSERT INTO events
          (id, exam_id, student_id, type, severity, timestamp_ms, details_json, evidence_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
      `)

      detailsStmt.run(
        eventId,
        examId,
        studentId,
        type,
        severity,
        timestampMs,
        detailsJson,
        nowIso()
      )

      let evidenceId = null
      let evidenceUrl = null

      if (evidenceDataUrl) {
        const decoded = decodeEvidenceDataUrl(evidenceDataUrl)
        if (decoded) {
          evidenceId = uuidv4()
          const fileName = `${evidenceId}.${decoded.ext}`
          const filePath = path.join(EVIDENCE_DIR, fileName)
          fs.writeFileSync(filePath, decoded.buffer)

          db.prepare(`
            INSERT INTO evidence (id, exam_id, student_id, kind, file_name, file_path, created_at)
            VALUES (?, ?, ?, 'screenshot', ?, ?, ?)
          `).run(
            evidenceId,
            examId,
            studentId,
            fileName,
            filePath,
            nowIso()
          )

          db.prepare(`UPDATE events SET evidence_id = ? WHERE id = ?`).run(evidenceId, eventId)
          evidenceUrl = `/evidence/${encodeURIComponent(fileName)}`
        }
      }

      const riskTotal = computeStudentRisk(examId, studentId)
      const emitPayload = {
        examId,
        event: {
          id: eventId,
          studentId,
          type,
          severity,
          timestampMs,
          evidenceUrl,
          details: detailsForEmit ?? null,
        },
        student: {
          studentId,
          riskTotal,
        },
      }

      io.to(`exam:${examId}`).emit('proctor:event', emitPayload)
      console.log('[proctor:event]', type, 'for', studentId, '| risk:', riskTotal)
    } catch (err) {
      console.warn('[proctor:violation] error:', err)
    }
  })

  socket.on('student:submit', (payload) => {
    try {
      if (!payload || typeof payload !== 'object') return
      const examId = String(payload.examId || '')
      const studentId = String(payload.studentId || socket.data.studentId || '')
      if (!examId || !studentId) return

      ensureExam(examId)
      ensureStudent(examId, studentId)

      const submissionId = uuidv4()
      const startedAt = payload.startedAt ? new Date(payload.startedAt).toISOString() : nowIso()
      const endedAt = payload.submittedAt ? new Date(payload.submittedAt).toISOString() : nowIso()

      const quizScore = payload.quizScore ?? null
      const quizTotal = payload.quizTotal ?? null

      const answersJson = payload.answers
        ? safeJsonStringify(payload.answers)
        : payload.questions
          ? safeJsonStringify(payload.questions)
          : null

      const suspiciousCount =
        payload.suspiciousCount ??
        db.prepare(`SELECT COUNT(*) AS c FROM events WHERE exam_id = ? AND student_id = ?`).get(examId, studentId).c

      const integrityRiskTotal =
        payload.integrityRiskTotal ?? computeStudentRisk(examId, studentId)

      const submittedReason = String(payload.submittedReason || payload.reason || 'manual_submit')

      db.prepare(`
        INSERT INTO student_submissions (
          id, exam_id, student_id,
          started_at, ended_at, submitted_reason,
          quiz_score, quiz_total,
          suspicious_count,
          integrity_risk_total,
          answers_json,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(exam_id, student_id) DO UPDATE SET
          started_at = COALESCE(excluded.started_at, student_submissions.started_at),
          ended_at = excluded.ended_at,
          submitted_reason = excluded.submitted_reason,
          quiz_score = excluded.quiz_score,
          quiz_total = excluded.quiz_total,
          suspicious_count = excluded.suspicious_count,
          integrity_risk_total = excluded.integrity_risk_total,
          answers_json = excluded.answers_json
      `).run(
        submissionId,
        examId,
        studentId,
        startedAt,
        endedAt,
        submittedReason,
        quizScore,
        quizTotal,
        suspiciousCount,
        integrityRiskTotal,
        answersJson,
        nowIso()
      )

      if (payload.autoEndExam) {
        db.prepare(
          `UPDATE exams SET status = 'ended', ended_at = ? WHERE id = ? AND status != 'ended'`
        ).run(nowIso(), examId)
      }

      io.to(`exam:${examId}`).emit('proctor:submission', {
        examId,
        studentId,
        submission: {
          quizScore,
          quizTotal,
          suspiciousCount,
          integrityRiskTotal,
          submittedReason,
          endedAt,
        },
      })

      console.log('[student:submit]', studentId, '| score:', quizScore, '/', quizTotal, '| risk:', integrityRiskTotal)
    } catch (err) {
      console.warn('[student:submit] error:', err)
    }
  })

  socket.on('disconnect', () => {
    console.log('[Socket] client disconnected:', socket.id)
  })
})

// ─── Start ─────────────────────────────────────────────────────────
initSchema()

server.listen(PORT, () => {
  console.log(`[Proctor Backend] Listening on http://localhost:${PORT}`)
  console.log(`[Proctor Backend] Database: ${DB_PATH}`)
  console.log(`[Proctor Backend] Evidence: ${EVIDENCE_DIR}`)
})
