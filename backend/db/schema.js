/* eslint-disable no-console */
/**
 * db/schema.js — Database schema creation and migrations
 */
const pool = require('./pool')

async function initSchema() {
  const c = await pool.connect()
  try {
    // ── Legacy/demo tables ────────────────────────────────────────
    await c.query(`
      CREATE TABLE IF NOT EXISTS exams (
        id TEXT PRIMARY KEY, title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL, ended_at TEXT
      )`)
    await c.query(`
      CREATE TABLE IF NOT EXISTS students (
        id TEXT NOT NULL, exam_id TEXT NOT NULL,
        last_seen_at TEXT, created_at TEXT NOT NULL,
        PRIMARY KEY (id, exam_id),
        FOREIGN KEY (exam_id) REFERENCES exams(id)
      )`)
    await c.query(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, exam_id TEXT NOT NULL,
        student_id TEXT NOT NULL, type TEXT NOT NULL,
        severity TEXT, timestamp_ms BIGINT NOT NULL,
        details_json TEXT, evidence_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (exam_id) REFERENCES exams(id)
      )`)
    await c.query(`
      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY, exam_id TEXT NOT NULL,
        student_id TEXT NOT NULL, kind TEXT NOT NULL,
        file_name TEXT NOT NULL, file_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`)
    await c.query(`
      CREATE TABLE IF NOT EXISTS student_submissions (
        id TEXT PRIMARY KEY, exam_id TEXT NOT NULL,
        student_id TEXT NOT NULL, started_at TEXT,
        ended_at TEXT, submitted_reason TEXT,
        quiz_score INTEGER, quiz_total INTEGER,
        suspicious_count INTEGER, integrity_risk_total INTEGER,
        answers_json TEXT, created_at TEXT NOT NULL,
        UNIQUE (exam_id, student_id),
        FOREIGN KEY (exam_id) REFERENCES exams(id)
      )`)
    await c.query(`CREATE INDEX IF NOT EXISTS idx_events_exam_time ON events(exam_id, timestamp_ms)`)
    await c.query(`CREATE INDEX IF NOT EXISTS idx_events_student   ON events(exam_id, student_id)`)

    // ── Auth tables ──────────────────────────────────────────────
    await c.query(`
      CREATE TABLE IF NOT EXISTS user_accounts (
        id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
        full_name TEXT NOT NULL, email TEXT,
        password_hash TEXT NOT NULL, salt TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'teacher',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      )`)
    await c.query(`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES user_accounts(id)
      )`)

    // ── Teacher exam tables ──────────────────────────────────────
    await c.query(`
      CREATE TABLE IF NOT EXISTS teacher_exams (
        id TEXT PRIMARY KEY, title TEXT NOT NULL,
        description TEXT, subject TEXT,
        duration INTEGER NOT NULL DEFAULT 60,
        total_marks INTEGER NOT NULL DEFAULT 100,
        passing_marks INTEGER NOT NULL DEFAULT 40,
        status TEXT NOT NULL DEFAULT 'draft',
        exam_code TEXT UNIQUE,
        allow_backtrack INTEGER NOT NULL DEFAULT 1,
        shuffle_questions INTEGER NOT NULL DEFAULT 0,
        show_results INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        start_time TEXT, end_time TEXT
      )`)
    await c.query(`
      CREATE TABLE IF NOT EXISTS exam_questions (
        id TEXT PRIMARY KEY, exam_id TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'multiple-choice',
        text TEXT NOT NULL, options TEXT,
        correct_answer TEXT,
        marks INTEGER NOT NULL DEFAULT 1,
        negative_marks FLOAT8 NOT NULL DEFAULT 0,
        explanation TEXT,
        order_idx INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (exam_id) REFERENCES teacher_exams(id) ON DELETE CASCADE
      )`)
    await c.query(`
      CREATE TABLE IF NOT EXISTS teacher_exam_sessions (
        id TEXT PRIMARY KEY, exam_id TEXT NOT NULL,
        student_name TEXT NOT NULL, student_roll TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'in_progress',
        score INTEGER, total_marks INTEGER,
        answers_json TEXT,
        violations INTEGER NOT NULL DEFAULT 0,
        risk_score INTEGER NOT NULL DEFAULT 0,
        kiosk_verified INTEGER NOT NULL DEFAULT 0,
        crypto_nonce TEXT,
        started_at TEXT NOT NULL, submitted_at TEXT,
        FOREIGN KEY (exam_id) REFERENCES teacher_exams(id)
      )`)
    await c.query(`CREATE INDEX IF NOT EXISTS idx_teacher_exam_sessions ON teacher_exam_sessions(exam_id)`)

    // ── Safe migrations ──────────────────────────────────────────
    await c.query(`ALTER TABLE teacher_exams    ADD COLUMN IF NOT EXISTS exam_code TEXT`).catch(() => {})
    await c.query(`ALTER TABLE exam_questions   ADD COLUMN IF NOT EXISTS negative_marks FLOAT8 NOT NULL DEFAULT 0`).catch(() => {})
    await c.query(`ALTER TABLE teacher_exam_sessions ADD COLUMN IF NOT EXISTS kiosk_verified INTEGER NOT NULL DEFAULT 0`).catch(() => {})
    await c.query(`ALTER TABLE teacher_exam_sessions ADD COLUMN IF NOT EXISTS crypto_nonce TEXT`).catch(() => {})

    // ── Performance indexes ──────────────────────────────────────
    await c.query(`CREATE INDEX IF NOT EXISTS idx_sessions_student_roll ON teacher_exam_sessions(student_roll)`)
    await c.query(`CREATE INDEX IF NOT EXISTS idx_exams_status ON teacher_exams(status)`)
    await c.query(`CREATE INDEX IF NOT EXISTS idx_exams_code ON teacher_exams(exam_code)`)
    await c.query(`CREATE INDEX IF NOT EXISTS idx_events_exam ON events(exam_id)`)
    await c.query(`CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at)`)
    await c.query(`CREATE INDEX IF NOT EXISTS idx_exams_created ON teacher_exams(created_at DESC)`)

    console.log('[DB] Schema ready')
  } finally { c.release() }
}

module.exports = { initSchema }
