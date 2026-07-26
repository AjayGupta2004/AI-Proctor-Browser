/* eslint-disable no-console */
/**
 * routes/legacy.js — Legacy exam REST routes
 * Used by Electron main.js for socket-based demo exams
 */
const express = require('express')
const { v4: uuidv4 } = require('uuid')

const pool = require('../db/pool')
const { nowIso, safeJsonParse, ensureExam, ensureStudent, computeStudentRisk } = require('../helpers')

const router = express.Router()

// ── Create/ensure a demo exam ─────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { id, title } = req.body || {}
    const examId    = String(id || uuidv4())
    const examTitle = String(title || 'Demo Exam')
    await ensureExam(examId, examTitle)
    res.json({ examId, title: examTitle })
  } catch (err) { console.error('[API]', err.message); res.status(500).json({ error: 'An error occurred. Please try again.' }) }
})

// ── End an exam and return a full report ──────────────────────────
router.post('/:examId/end', async (req, res) => {
  try {
    const examId = String(req.params.examId)
    await ensureExam(examId)
    await pool.query(`UPDATE exams SET status='ended', ended_at=$1 WHERE id=$2`, [nowIso(), examId])
    const er = await pool.query('SELECT * FROM exams WHERE id=$1', [examId])
    const exam = er.rows[0]
    const studentsR = await pool.query('SELECT id FROM students WHERE exam_id=$1 ORDER BY created_at ASC', [examId])
    const timelineR = await pool.query('SELECT * FROM events WHERE exam_id=$1 ORDER BY timestamp_ms ASC LIMIT 5000', [examId])
    const evidenceR = await pool.query('SELECT * FROM evidence WHERE exam_id=$1', [examId])
    const evidenceMap = new Map(evidenceR.rows.map(e => [e.id, e]))
    const studentReports = await Promise.all(studentsR.rows.map(async s => {
      const riskTotal  = await computeStudentRisk(examId, s.id)
      const riskRecent = await computeStudentRisk(examId, s.id, 60000)
      const subR = await pool.query('SELECT * FROM student_submissions WHERE exam_id=$1 AND student_id=$2', [examId, s.id])
      const sub  = subR.rows[0] || null
      const cntR = await pool.query('SELECT COUNT(*) AS c FROM events WHERE exam_id=$1 AND student_id=$2', [examId, s.id])
      return { studentId: s.id, riskTotal, riskRecent,
        suspiciousCount: sub?.suspicious_count ?? Number(cntR.rows[0].c),
        quizScore: sub?.quiz_score ?? null, quizTotal: sub?.quiz_total ?? null,
        submissionReason: sub?.submitted_reason ?? null, submissionEndedAt: sub?.ended_at ?? null }
    }))
    res.json({
      exam: { id: exam.id, title: exam.title, status: exam.status, createdAt: exam.created_at, endedAt: exam.ended_at },
      integritySummary: { studentsCount: studentsR.rows.length, highestRisk: studentReports.reduce((a, r) => Math.max(a, r.riskTotal), 0) },
      students: studentReports,
      timeline: timelineR.rows.map(e => {
        const ev = evidenceMap.get(e.evidence_id) || null
        return { id: e.id, studentId: e.student_id, type: e.type, severity: e.severity, timestampMs: e.timestamp_ms,
          details: e.details_json ? safeJsonParse(e.details_json) : null,
          evidenceUrl: ev ? `/evidence/${encodeURIComponent(ev.file_name)}` : null }
      })
    })
  } catch (err) { console.error('[API]', err.message); res.status(500).json({ error: 'An error occurred. Please try again.' }) }
})

module.exports = router
