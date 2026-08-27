/* eslint-disable no-console */
/**
 * routes/student.js — Public student API
 * GET /api/student/exam/:code — Fetch exam data
 * POST /api/student/exam/:code/session — Create session
 * POST /api/student/exam/:code/submit — Submit answers
 */
const express = require('express')
const crypto  = require('crypto')
const { v4: uuidv4 } = require('uuid')

const pool  = require('../db/pool')
const redis = require('../db/redis')
const { verifyKioskAttestation } = require('../config')
const { nowIso, sanitize } = require('../helpers')

const router = express.Router()

// ── Fetch exam by code ────────────────────────────────────────────
router.get('/exam/:code', async (req, res) => {
  try {
    const code = (req.params.code || '').trim().toUpperCase()

    // Try Redis cache first
    const cached = await redis.getCachedExam(code)
    if (cached) return res.json(cached)

    const er = await pool.query(`SELECT * FROM teacher_exams WHERE exam_code=$1 AND status IN ('published','active')`, [code])
    if (!er.rows.length) return res.status(404).json({ error: 'Exam not found or not available. Check the code and try again.' })
    const exam = er.rows[0]
    const qr = await pool.query('SELECT id,type,text,options,marks,negative_marks,order_idx FROM exam_questions WHERE exam_id=$1 ORDER BY order_idx ASC', [exam.id])
    const questions = qr.rows.map(q => { try { q.options = JSON.parse(q.options || '[]') } catch { q.options = [] }; return q })
    if (exam.shuffle_questions) {
      for (let i = questions.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[questions[i], questions[j]] = [questions[j], questions[i]] }
    }

    const examData = {
      id: exam.id, title: exam.title, description: exam.description, subject: exam.subject,
      duration: exam.duration, totalMarks: exam.total_marks, passingMarks: exam.passing_marks,
      allowBacktrack: exam.allow_backtrack, showResults: exam.show_results, examCode: exam.exam_code, questions
    }

    // Cache for 5 minutes (questions don't change during an active exam)
    await redis.setCachedExam(code, examData)

    res.json(examData)
  } catch (err) {
    console.error('[Student] Exam lookup error:', err.message)
    res.status(500).json({ error: 'Unable to load exam. Please try again.' })
  }
})

// ── Create session ────────────────────────────────────────────────
router.post('/exam/:code/session', async (req, res) => {
  try {
    const code = (req.params.code || '').trim().toUpperCase()
    const er = await pool.query(`SELECT * FROM teacher_exams WHERE exam_code=$1 AND status IN ('published','active')`, [code])
    if (!er.rows.length) return res.status(404).json({ error: 'Exam not found or not active.' })
    const exam = er.rows[0]
    const { studentName, studentRoll, kioskAttestation } = req.body || {}
    if (!studentName || !studentRoll) return res.status(400).json({ error: 'studentName and studentRoll required' })
    const sessionId = uuidv4()
    const cryptoNonce = crypto.randomBytes(32).toString('hex')
    const kioskVerified = verifyKioskAttestation(kioskAttestation) ? 1 : 0
    await pool.query(
      `INSERT INTO teacher_exam_sessions (id,exam_id,student_name,student_roll,status,violations,risk_score,kiosk_verified,crypto_nonce,started_at)
       VALUES ($1,$2,$3,$4,'in_progress',0,0,$5,$6,$7)`,
      [sessionId, exam.id, sanitize(studentName), sanitize(studentRoll), kioskVerified, cryptoNonce, nowIso()])
    if (!kioskVerified) {
      console.warn(`[Session] Student ${sanitize(studentRoll)} session ${sessionId} created WITHOUT kiosk verification`)
    }
    res.status(201).json({ sessionId, examId: exam.id, cryptoNonce })
  } catch (err) {
    console.error('[Student] Session creation error:', err.message)
    res.status(500).json({ error: 'Unable to create exam session. Please try again.' })
  }
})

// ── Submit answers ────────────────────────────────────────────────
router.post('/exam/:code/submit', async (req, res) => {
  try {
    const code = (req.params.code || '').trim().toUpperCase()
    const er = await pool.query('SELECT * FROM teacher_exams WHERE exam_code=$1', [code])
    if (!er.rows.length) return res.status(404).json({ error: 'Exam not found.' })
    const exam = er.rows[0]
    const { sessionId, answers, violations, riskScore } = req.body || {}
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' })

    // Load questions to calculate score
    const qr = await pool.query('SELECT * FROM exam_questions WHERE exam_id=$1 ORDER BY order_idx ASC', [exam.id])
    const questions = qr.rows

    let score = 0, correctCount = 0, wrongCount = 0, answeredCount = 0
    if (answers && typeof answers === 'object') {
      for (const q of questions) {
        const studentAnswer = answers[q.id]
        if (studentAnswer !== undefined && studentAnswer !== null) {
          answeredCount++
          // correct_answer is stored as the option index (e.g. "0" = A, "1" = B, etc.)
          // studentAnswer is also the option index from the frontend
          if (String(studentAnswer) === String(q.correct_answer)) {
            score += (q.marks || 1)
            correctCount++
          } else {
            wrongCount++
            if (q.negative_marks) score -= q.negative_marks
          }
        }
      }
    }
    score = Math.max(0, score)

    // Update session
    await pool.query(
      `UPDATE teacher_exam_sessions SET status='submitted', score=$1, total_marks=$2, answers_json=$3, violations=$4, risk_score=$5, submitted_at=$6 WHERE id=$7`,
      [score, exam.total_marks, JSON.stringify(answers || {}), violations || 0, riskScore || 0, nowIso(), sessionId])

    res.json({ ok: true, score, totalMarks: exam.total_marks, passed: score >= exam.passing_marks, passingMarks: exam.passing_marks, showResults: exam.show_results, correctCount, wrongCount, answeredCount })
  } catch (err) {
    console.error('[Student] Submit error:', err.message)
    res.status(500).json({ error: 'Submission failed. Your answers have been saved locally. Please try again.' })
  }
})

module.exports = router
