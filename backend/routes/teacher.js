/* eslint-disable no-console */
/**
 * routes/teacher.js — Teacher dashboard API
 * All /api/teacher/* routes (exams, questions, results, students)
 */
const express = require('express')
const { v4: uuidv4 } = require('uuid')

const pool = require('../db/pool')
const redis = require('../db/redis')
const { requireAuth } = require('../middleware/auth')
const { nowIso, sanitize } = require('../helpers')

const router = express.Router()

// ── List exams ────────────────────────────────────────────────────
router.get('/exams', requireAuth, async (req, res) => {
  try {
    const { status } = req.query
    let sql = `
      SELECT e.*,
        (SELECT COUNT(*) FROM exam_questions x WHERE x.exam_id=e.id) AS question_count,
        (SELECT COUNT(*) FROM teacher_exam_sessions s WHERE s.exam_id=e.id) AS attempt_count
      FROM teacher_exams e WHERE e.created_by=$1`
    const params = [req.user.id]
    if (status) { sql += ` AND e.status=$2`; params.push(status) }
    sql += ' ORDER BY e.created_at DESC'
    res.json((await pool.query(sql, params)).rows)
  } catch (err) {
    console.error('[Teacher] List exams error:', err.message)
    res.status(500).json({ error: 'Unable to load exams. Please try again.' })
  }
})

// ── Create exam ───────────────────────────────────────────────────
router.post('/exams', requireAuth, async (req, res) => {
  try {
    const title = sanitize(req.body?.title)
    const description = sanitize(req.body?.description)
    const subject = sanitize(req.body?.subject)
    const { duration, totalMarks, passingMarks, allowBacktrack, shuffleQuestions, showResults, examCode } = req.body || {}
    if (!title || !duration || !passingMarks) return res.status(400).json({ error: 'title, duration, passingMarks required' })
    const id = uuidv4(), now = nowIso()
    const code = (examCode || '').trim().toUpperCase() || Math.random().toString(36).substring(2, 8).toUpperCase()
    if ((await pool.query('SELECT id FROM teacher_exams WHERE exam_code=$1', [code])).rows.length)
      return res.status(409).json({ error: 'Exam code already taken. Choose a different code.' })
    await pool.query(
      `INSERT INTO teacher_exams
        (id,title,description,subject,duration,total_marks,passing_marks,status,exam_code,allow_backtrack,shuffle_questions,show_results,created_by,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10,$11,$12,$13,$14)`,
      [id, title, description || null, subject || null, Number(duration), Number(totalMarks) || 0,
       Number(passingMarks), code, allowBacktrack ? 1 : 0, shuffleQuestions ? 1 : 0,
       showResults ? 1 : 0, req.user.id, now, now])
    res.status(201).json((await pool.query('SELECT * FROM teacher_exams WHERE id=$1', [id])).rows[0])
  } catch (err) {
    console.error('[Teacher] Create exam error:', err.message)
    res.status(500).json({ error: 'Unable to create exam. Please try again.' })
  }
})

// ── Get single exam (with questions) ──────────────────────────────
router.get('/exams/:id', requireAuth, async (req, res) => {
  try {
    const er = await pool.query('SELECT * FROM teacher_exams WHERE id=$1 AND created_by=$2', [req.params.id, req.user.id])
    if (!er.rows.length) return res.status(404).json({ error: 'Exam not found' })
    const qr = await pool.query('SELECT * FROM exam_questions WHERE exam_id=$1 ORDER BY order_idx ASC', [req.params.id])
    qr.rows.forEach(q => { try { q.options = JSON.parse(q.options || '[]') } catch { q.options = [] } })
    res.json({ ...er.rows[0], questions: qr.rows })
  } catch (err) { console.error('[API]', err.message); res.status(500).json({ error: 'An error occurred. Please try again.' }) }
})

// ── Update exam metadata ──────────────────────────────────────────
router.put('/exams/:id', requireAuth, async (req, res) => {
  try {
    if (!(await pool.query('SELECT id FROM teacher_exams WHERE id=$1 AND created_by=$2', [req.params.id, req.user.id])).rows.length)
      return res.status(404).json({ error: 'Exam not found' })
    const { title, description, subject, duration, totalMarks, passingMarks, allowBacktrack, shuffleQuestions, showResults } = req.body || {}
    await pool.query(
      `UPDATE teacher_exams SET title=$1,description=$2,subject=$3,duration=$4,total_marks=$5,
       passing_marks=$6,allow_backtrack=$7,shuffle_questions=$8,show_results=$9,updated_at=$10 WHERE id=$11`,
      [title, description || null, subject || null, Number(duration), Number(totalMarks),
       Number(passingMarks), allowBacktrack ? 1 : 0, shuffleQuestions ? 1 : 0, showResults ? 1 : 0, nowIso(), req.params.id])
    // Invalidate cache if exam code exists
    const exam = (await pool.query('SELECT exam_code FROM teacher_exams WHERE id=$1', [req.params.id])).rows[0]
    if (exam?.exam_code) await redis.invalidateExam(exam.exam_code)
    res.json((await pool.query('SELECT * FROM teacher_exams WHERE id=$1', [req.params.id])).rows[0])
  } catch (err) {
    console.error('[Teacher] Update exam error:', err.message)
    res.status(500).json({ error: 'Unable to update exam. Please try again.' })
  }
})

// ── Delete exam ───────────────────────────────────────────────────
router.delete('/exams/:id', requireAuth, async (req, res) => {
  try {
    const er = await pool.query('SELECT id,status,exam_code FROM teacher_exams WHERE id=$1 AND created_by=$2', [req.params.id, req.user.id])
    if (!er.rows.length) return res.status(404).json({ error: 'Exam not found' })
    if (er.rows[0].status === 'active') return res.status(400).json({ error: 'Cannot delete an active exam. End it first.' })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM teacher_exam_sessions WHERE exam_id=$1', [req.params.id])
      await client.query('DELETE FROM exam_questions WHERE exam_id=$1', [req.params.id])
      await client.query('DELETE FROM teacher_exams WHERE id=$1', [req.params.id])
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally { client.release() }
    // Invalidate cache
    if (er.rows[0].exam_code) await redis.invalidateExam(er.rows[0].exam_code)
    res.json({ ok: true })
  } catch (err) {
    console.error('[Teacher] Delete exam error:', err.message)
    res.status(500).json({ error: 'Unable to delete exam. Please try again.' })
  }
})

// ── Publish exam ──────────────────────────────────────────────────
router.put('/exams/:id/publish', requireAuth, async (req, res) => {
  try {
    if (!(await pool.query('SELECT id FROM teacher_exams WHERE id=$1 AND created_by=$2', [req.params.id, req.user.id])).rows.length)
      return res.status(404).json({ error: 'Exam not found' })
    const qc = await pool.query('SELECT COUNT(*) AS c FROM exam_questions WHERE exam_id=$1', [req.params.id])
    if (Number(qc.rows[0].c) === 0) return res.status(400).json({ error: 'Add at least one question before publishing' })
    await pool.query(`UPDATE teacher_exams SET status='published',updated_at=$1 WHERE id=$2`, [nowIso(), req.params.id])
    res.json((await pool.query('SELECT * FROM teacher_exams WHERE id=$1', [req.params.id])).rows[0])
  } catch (err) { console.error('[API]', err.message); res.status(500).json({ error: 'An error occurred. Please try again.' }) }
})

// ── Activate exam ─────────────────────────────────────────────────
router.put('/exams/:id/activate', requireAuth, async (req, res) => {
  try {
    if (!(await pool.query('SELECT id FROM teacher_exams WHERE id=$1 AND created_by=$2', [req.params.id, req.user.id])).rows.length)
      return res.status(404).json({ error: 'Exam not found' })
    await pool.query(`UPDATE teacher_exams SET status='active',start_time=$1,updated_at=$2 WHERE id=$3`, [nowIso(), nowIso(), req.params.id])
    res.json((await pool.query('SELECT * FROM teacher_exams WHERE id=$1', [req.params.id])).rows[0])
  } catch (err) { console.error('[API]', err.message); res.status(500).json({ error: 'An error occurred. Please try again.' }) }
})

// ── End exam ──────────────────────────────────────────────────────
router.put('/exams/:id/end', requireAuth, async (req, res) => {
  try {
    if (!(await pool.query('SELECT id FROM teacher_exams WHERE id=$1 AND created_by=$2', [req.params.id, req.user.id])).rows.length)
      return res.status(404).json({ error: 'Exam not found' })
    await pool.query(`UPDATE teacher_exams SET status='ended',end_time=$1,updated_at=$2 WHERE id=$3`, [nowIso(), nowIso(), req.params.id])
    // Invalidate cache
    const exam = (await pool.query('SELECT exam_code FROM teacher_exams WHERE id=$1', [req.params.id])).rows[0]
    if (exam?.exam_code) await redis.invalidateExam(exam.exam_code)
    res.json((await pool.query('SELECT * FROM teacher_exams WHERE id=$1', [req.params.id])).rows[0])
  } catch (err) { console.error('[API]', err.message); res.status(500).json({ error: 'An error occurred. Please try again.' }) }
})

// ─── Question Routes ──────────────────────────────────────────────

router.get('/exams/:id/questions', requireAuth, async (req, res) => {
  try {
    if (!(await pool.query('SELECT id FROM teacher_exams WHERE id=$1 AND created_by=$2', [req.params.id, req.user.id])).rows.length)
      return res.status(404).json({ error: 'Exam not found' })
    const qr = await pool.query('SELECT * FROM exam_questions WHERE exam_id=$1 ORDER BY order_idx ASC', [req.params.id])
    qr.rows.forEach(q => { try { q.options = JSON.parse(q.options || '[]') } catch { q.options = [] } })
    res.json(qr.rows)
  } catch (err) { console.error('[API]', err.message); res.status(500).json({ error: 'An error occurred. Please try again.' }) }
})

router.post('/exams/:id/questions/bulk', requireAuth, async (req, res) => {
  try {
    if (!(await pool.query('SELECT id FROM teacher_exams WHERE id=$1 AND created_by=$2', [req.params.id, req.user.id])).rows.length)
      return res.status(404).json({ error: 'Exam not found' })
    const { questions } = req.body || {}
    if (!Array.isArray(questions) || !questions.length) return res.status(400).json({ error: 'questions array required' })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM exam_questions WHERE exam_id=$1', [req.params.id])
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i]
        await client.query(
          `INSERT INTO exam_questions
            (id,exam_id,type,text,options,correct_answer,marks,negative_marks,explanation,order_idx,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [uuidv4(), req.params.id, q.type || 'multiple-choice', sanitize(q.text),
           JSON.stringify(q.options || []), sanitize(q.correctAnswer || ''),
           Number(q.marks) || 1, Number(q.negativeMarks) || 0, sanitize(q.explanation), i, nowIso()])
      }
      const totalMarks = questions.reduce((s, q) => s + (Number(q.marks) || 1), 0)
      await client.query('UPDATE teacher_exams SET total_marks=$1,updated_at=$2 WHERE id=$3', [totalMarks, nowIso(), req.params.id])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
    // Invalidate exam cache since questions changed
    const exam = (await pool.query('SELECT exam_code FROM teacher_exams WHERE id=$1', [req.params.id])).rows[0]
    if (exam?.exam_code) await redis.invalidateExam(exam.exam_code)
    const saved = (await pool.query('SELECT * FROM exam_questions WHERE exam_id=$1 ORDER BY order_idx ASC', [req.params.id])).rows
    saved.forEach(q => { try { q.options = JSON.parse(q.options || '[]') } catch { q.options = [] } })
    res.json(saved)
  } catch (err) { console.error('[API]', err.message); res.status(500).json({ error: 'An error occurred. Please try again.' }) }
})

router.put('/questions/:qId', requireAuth, async (req, res) => {
  try {
    const qr = await pool.query(
      `SELECT eq.* FROM exam_questions eq JOIN teacher_exams e ON e.id=eq.exam_id WHERE eq.id=$1 AND e.created_by=$2`,
      [req.params.qId, req.user.id])
    if (!qr.rows.length) return res.status(404).json({ error: 'Question not found' })
    const q = qr.rows[0]
    const { type, text, options, correctAnswer, marks, explanation } = req.body || {}
    await pool.query(
      `UPDATE exam_questions SET type=$1,text=$2,options=$3,correct_answer=$4,marks=$5,explanation=$6 WHERE id=$7`,
      [type || q.type, text || q.text, JSON.stringify(options || []), correctAnswer || '', Number(marks) || q.marks, explanation || '', req.params.qId])
    res.json((await pool.query('SELECT * FROM exam_questions WHERE id=$1', [req.params.qId])).rows[0])
  } catch (err) { console.error('[API]', err.message); res.status(500).json({ error: 'An error occurred. Please try again.' }) }
})

router.delete('/questions/:qId', requireAuth, async (req, res) => {
  try {
    const qr = await pool.query(
      `SELECT eq.id FROM exam_questions eq JOIN teacher_exams e ON e.id=eq.exam_id WHERE eq.id=$1 AND e.created_by=$2`,
      [req.params.qId, req.user.id])
    if (!qr.rows.length) return res.status(404).json({ error: 'Question not found' })
    await pool.query('DELETE FROM exam_questions WHERE id=$1', [req.params.qId])
    res.json({ ok: true })
  } catch (err) { console.error('[API]', err.message); res.status(500).json({ error: 'An error occurred. Please try again.' }) }
})

// ─── Results & Reports ────────────────────────────────────────────

router.get('/exams/:id/results', requireAuth, async (req, res) => {
  try {
    const er = await pool.query('SELECT * FROM teacher_exams WHERE id=$1 AND created_by=$2', [req.params.id, req.user.id])
    if (!er.rows.length) return res.status(404).json({ error: 'Exam not found' })
    const exam = er.rows[0]
    const sr = await pool.query(`SELECT * FROM teacher_exam_sessions WHERE exam_id=$1 ORDER BY submitted_at DESC NULLS LAST`, [req.params.id])
    const completed = sr.rows.filter(s => s.status === 'submitted')
    const n   = completed.length
    const avg = n ? Math.round(completed.reduce((s, r) => s + (r.score || 0), 0) / n) : 0
    const hi  = n ? Math.max(...completed.map(r => r.score || 0)) : 0
    const pc  = completed.filter(r => (r.score || 0) >= exam.passing_marks).length
    res.json({ exam, sessions: sr.rows, statistics: { totalStudents: n, avgScore: avg, highestScore: hi, passRate: n ? Math.round(pc / n * 100) : 0, passCount: pc } })
  } catch (err) { console.error('[API]', err.message); res.status(500).json({ error: 'An error occurred. Please try again.' }) }
})

router.get('/exams/:id/results/export', requireAuth, async (req, res) => {
  try {
    const er = await pool.query('SELECT * FROM teacher_exams WHERE id=$1 AND created_by=$2', [req.params.id, req.user.id])
    if (!er.rows.length) return res.status(404).json({ error: 'Exam not found' })
    const exam = er.rows[0]
    const sr = await pool.query(
      `SELECT * FROM teacher_exam_sessions WHERE exam_id=$1 AND status='submitted' ORDER BY score DESC NULLS LAST`, [req.params.id])
    let csv = 'Rank,Student Name,Roll Number,Score,Total Marks,Percentage,Status,Violations,Risk Score,Submitted At\n'
    sr.rows.forEach((s, i) => {
      const pct = exam.total_marks ? Math.round((s.score || 0) / exam.total_marks * 100) : 0
      const status = (s.score || 0) >= exam.passing_marks ? 'Pass' : 'Fail'
      csv += `${i + 1},"${s.student_name}","${s.student_roll}",${s.score || 0},${exam.total_marks},${pct}%,${status},${s.violations || 0},${s.risk_score || 0}%,"${s.submitted_at || ''}"\n`
    })
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="results-${exam.title.replace(/[^a-z0-9]/gi, '_')}.csv"`)
    res.send(csv)
  } catch (err) { console.error('[API]', err.message); res.status(500).json({ error: 'An error occurred. Please try again.' }) }
})

// ── Live monitoring ───────────────────────────────────────────────
router.get('/exams/:id/live', requireAuth, async (req, res) => {
  try {
    const er = await pool.query('SELECT id,title FROM teacher_exams WHERE id=$1 AND created_by=$2', [req.params.id, req.user.id])
    if (!er.rows.length) return res.status(404).json({ error: 'Exam not found' })
    const sr = await pool.query(
      `SELECT * FROM teacher_exam_sessions WHERE exam_id=$1 AND status='in_progress' ORDER BY started_at ASC`, [req.params.id])
    res.json({ exam: er.rows[0], sessions: sr.rows })
  } catch (err) { console.error('[API]', err.message); res.status(500).json({ error: 'An error occurred. Please try again.' }) }
})

// ── All students (aggregated) ─────────────────────────────────────
router.get('/students', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.student_name, s.student_roll,
        COUNT(*) AS total_exams,
        SUM(CASE WHEN s.status='submitted' THEN 1 ELSE 0 END) AS completed,
        ROUND(AVG(CASE WHEN s.status='submitted' THEN s.score::NUMERIC END), 1) AS avg_score,
        COALESCE(SUM(s.violations), 0) AS total_violations
      FROM teacher_exam_sessions s
      JOIN teacher_exams e ON e.id = s.exam_id
      WHERE e.created_by = $1
      GROUP BY s.student_roll, s.student_name
      ORDER BY s.student_name ASC`, [req.user.id])
    res.json(r.rows)
  } catch (err) { console.error('[API]', err.message); res.status(500).json({ error: 'An error occurred. Please try again.' }) }
})

// ── Single student detail ─────────────────────────────────────────
router.get('/students/:roll', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.*, e.title AS exam_title, e.total_marks AS exam_total_marks,
             e.passing_marks AS exam_passing_marks, e.subject AS exam_subject
      FROM teacher_exam_sessions s
      JOIN teacher_exams e ON e.id = s.exam_id
      WHERE e.created_by=$1 AND s.student_roll=$2
      ORDER BY s.started_at DESC`, [req.user.id, req.params.roll])
    if (!r.rows.length) return res.status(404).json({ error: 'Student not found' })
    const completed = r.rows.filter(s => s.status === 'submitted')
    const avgScore  = completed.length ? Math.round(completed.reduce((s, r) => s + (r.score || 0), 0) / completed.length) : 0
    res.json({
      studentName: r.rows[0].student_name, studentRoll: r.rows[0].student_roll,
      sessions: r.rows,
      statistics: { totalExams: r.rows.length, completed: completed.length, avgScore, totalViolations: r.rows.reduce((s, r) => s + (r.violations || 0), 0) }
    })
  } catch (err) { console.error('[API]', err.message); res.status(500).json({ error: 'An error occurred. Please try again.' }) }
})

module.exports = router
