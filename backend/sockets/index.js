/* eslint-disable no-console */
/**
 * sockets/index.js — Socket.IO event handlers
 * All real-time WebSocket logic (proctor rooms, student violations, submissions)
 */
const path = require('path')
const fs   = require('fs')
const { v4: uuidv4 } = require('uuid')

const pool = require('../db/pool')
const { EVIDENCE_DIR } = require('../config')
const { nowIso, safeJsonStringify, normalizeTimestampMs, decodeEvidenceDataUrl, ensureExam, ensureStudent, computeStudentRisk } = require('../helpers')

// Track connected proctors (teacher dashboards)
const proctorSockets = new Map() // examId → Set<socketId>

function setupSocketHandlers(io) {
  io.on('connection', (socket) => {
    console.log('[Socket] Client connected:', socket.id)

    // ── Teacher joins proctor room ──────────────────────────────
    socket.on('proctor:join', ({ examId }) => {
      if (!examId) return
      socket.join(`proctor:${examId}`)
      if (!proctorSockets.has(examId)) proctorSockets.set(examId, new Set())
      proctorSockets.get(examId).add(socket.id)
      console.log(`[Socket] Proctor ${socket.id} joined exam ${examId}`)
    })

    // ── Teacher/proctor joins monitoring room (legacy) ──────────
    socket.on('exam:join', ({ examId }) => {
      if (!examId) return
      socket.join(`exam:${examId}`)
      socket.join(`proctor:${examId}`)
      socket.data.examId = examId
      console.log(`[Socket] Proctor joined exam room: ${examId}`)
    })

    // ── Student joins exam room ────────────────────────────────
    socket.on('student:join', async ({ examId, studentId }) => {
      if (!examId || !studentId) return
      try {
        await ensureExam(examId)
        await ensureStudent(examId, studentId)
        socket.join(`exam:${examId}`)
        socket.data.examId = examId
        socket.data.studentId = studentId
        console.log(`[Socket] Student ${studentId} joined exam ${examId}`)
        io.to(`proctor:${examId}`).emit('student:joined', { studentId, examId, ts: Date.now() })
      } catch (err) { console.error('[Socket] student:join error:', err.message) }
    })

    // ── Violation event from student ───────────────────────────
    socket.on('student:violation', async (data) => {
      const examId    = data?.examId    || socket.data.examId
      const studentId = data?.studentId || socket.data.studentId
      if (!examId || !studentId) return
      try {
        await ensureExam(examId)
        await ensureStudent(examId, studentId)

        const eventId = uuidv4()
        const ts = normalizeTimestampMs(data.timestampMs || data.timestamp)
        let evidenceId = null

        if (data.evidenceDataUrl) {
          const decoded = decodeEvidenceDataUrl(data.evidenceDataUrl)
          if (decoded) {
            const fileName = `${examId}_${studentId}_${ts}.${decoded.ext}`
            const filePath = path.join(EVIDENCE_DIR, fileName)
            try {
              fs.writeFileSync(filePath, decoded.buffer)
              evidenceId = uuidv4()
              await pool.query(
                `INSERT INTO evidence (id,exam_id,student_id,kind,file_name,file_path,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                [evidenceId, examId, studentId, 'screenshot', fileName, filePath, nowIso()])
            } catch (e) { console.warn('[Evidence] Save failed:', e.message) }
          }
        }

        await pool.query(
          `INSERT INTO events (id,exam_id,student_id,type,severity,timestamp_ms,details_json,evidence_id,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [eventId, examId, studentId, data.type || 'violation', data.severity || 'medium', ts,
           data.details ? safeJsonStringify(data.details) : null, evidenceId, nowIso()])

        const riskTotal = await computeStudentRisk(examId, studentId)
        const emitPayload = {
          examId, event: { id: eventId, studentId, type: data.type || 'violation',
            severity: data.severity, timestampMs: ts,
            evidenceUrl: evidenceId ? `/evidence/${examId}_${studentId}_${ts}.jpg` : null,
            details: data.details ?? null },
          student: { studentId, riskTotal }
        }
        io.to(`exam:${examId}`).emit('proctor:event', emitPayload)
        io.to(`proctor:${examId}`).emit('student:violation', emitPayload)
        console.log('[proctor:event]', data.type, 'for', studentId, '| risk:', riskTotal)
      } catch (err) { console.error('[Socket] student:violation error:', err.message) }
    })

    // ── proctor:violation = alias used by Electron main.js ─────
    socket.on('proctor:violation', async (payload) => {
      if (!payload || typeof payload !== 'object') return
      const examId    = String(payload.examId    || socket.data.examId    || '')
      const studentId = String(payload.studentId || socket.data.studentId || '')
      if (!examId || !studentId) return
      try {
        await ensureExam(examId)
        await ensureStudent(examId, studentId)
        const eventId = uuidv4()
        const ts = normalizeTimestampMs(payload.timestamp || payload.timestampMs)
        const details = payload.details !== undefined ? payload.details : { type: payload.type, ...payload }
        let evidenceId = null
        if (payload.evidenceDataUrl) {
          const decoded = decodeEvidenceDataUrl(payload.evidenceDataUrl)
          if (decoded) {
            const fileName = `${uuidv4()}.${decoded.ext}`
            const filePath = path.join(EVIDENCE_DIR, fileName)
            try {
              fs.writeFileSync(filePath, decoded.buffer)
              evidenceId = uuidv4()
              await pool.query(
                `INSERT INTO evidence (id,exam_id,student_id,kind,file_name,file_path,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                [evidenceId, examId, studentId, 'screenshot', fileName, filePath, nowIso()])
            } catch (e) { console.warn('[Evidence] Save failed:', e.message) }
          }
        }
        await pool.query(
          `INSERT INTO events (id,exam_id,student_id,type,severity,timestamp_ms,details_json,evidence_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [eventId, examId, studentId, payload.type || 'violation', payload.severity ?? null, ts, safeJsonStringify(details), evidenceId, nowIso()])
        const riskTotal = await computeStudentRisk(examId, studentId)
        const emitPayload = { examId, event: { id: eventId, studentId, type: payload.type, severity: payload.severity, timestampMs: ts,
          evidenceUrl: evidenceId ? `/evidence/${evidenceId}.jpg` : null, details: details ?? null },
          student: { studentId, riskTotal } }
        io.to(`exam:${examId}`).emit('proctor:event', emitPayload)
        io.to(`proctor:${examId}`).emit('student:violation', emitPayload)
        console.log('[proctor:violation]', payload.type, 'for', studentId, '| risk:', riskTotal)
      } catch (err) { console.error('[Socket] proctor:violation error:', err.message) }
    })

    // ── Student submits exam ───────────────────────────────────
    socket.on('student:submit', async (payload) => {
      if (!payload || typeof payload !== 'object') return
      const examId    = String(payload.examId    || socket.data.examId    || '')
      const studentId = String(payload.studentId || socket.data.studentId || '')
      if (!examId || !studentId) return
      try {
        await ensureExam(examId)
        await ensureStudent(examId, studentId)
        const startedAt      = payload.startedAt ? new Date(payload.startedAt).toISOString() : nowIso()
        const endedAt        = payload.submittedAt ? new Date(payload.submittedAt).toISOString() : nowIso()
        const quizScore      = payload.quizScore ?? null
        const quizTotal      = payload.quizTotal ?? null
        const answersJson    = payload.answers ? safeJsonStringify(payload.answers) : (payload.questions ? safeJsonStringify(payload.questions) : null)
        const submittedReason = String(payload.submittedReason || payload.reason || 'manual_submit')
        const cntR           = await pool.query('SELECT COUNT(*) AS c FROM events WHERE exam_id=$1 AND student_id=$2', [examId, studentId])
        const suspiciousCount = payload.suspiciousCount ?? Number(cntR.rows[0].c)
        const integrityRiskTotal = payload.integrityRiskTotal ?? await computeStudentRisk(examId, studentId)
        await pool.query(
          `INSERT INTO student_submissions (id,exam_id,student_id,started_at,ended_at,submitted_reason,quiz_score,quiz_total,suspicious_count,integrity_risk_total,answers_json,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (exam_id,student_id) DO UPDATE SET
             ended_at=EXCLUDED.ended_at, submitted_reason=EXCLUDED.submitted_reason,
             quiz_score=EXCLUDED.quiz_score, quiz_total=EXCLUDED.quiz_total,
             suspicious_count=EXCLUDED.suspicious_count, integrity_risk_total=EXCLUDED.integrity_risk_total,
             answers_json=EXCLUDED.answers_json`,
          [uuidv4(), examId, studentId, startedAt, endedAt, submittedReason, quizScore, quizTotal, suspiciousCount, integrityRiskTotal, answersJson, nowIso()])
        if (payload.autoEndExam) {
          await pool.query(`UPDATE exams SET status='ended', ended_at=$1 WHERE id=$2 AND status!='ended'`, [nowIso(), examId])
        }
        const emitPayload = { examId, studentId, submission: { quizScore, quizTotal, suspiciousCount, integrityRiskTotal, submittedReason, endedAt } }
        io.to(`exam:${examId}`).emit('proctor:submission', emitPayload)
        io.to(`proctor:${examId}`).emit('student:submitted', { examId, studentId, ts: Date.now(), status: payload.status })
        console.log('[student:submit]', studentId, '| score:', quizScore, '/', quizTotal, '| risk:', integrityRiskTotal)
      } catch (err) { console.error('[Socket] student:submit error:', err.message) }
    })

    // ── Proctor sends warning to a student ──────────────────────
    socket.on('proctor:warn', ({ examId, studentId, message }) => {
      if (!examId || !studentId) return
      io.to(`exam:${examId}`).emit('proctor:warning', { studentId, message, ts: Date.now() })
    })

    // ── Cleanup on disconnect ──────────────────────────────────
    socket.on('disconnect', () => {
      const { examId, studentId } = socket.data || {}
      if (examId) {
        pool.query('UPDATE students SET last_seen_at=$1 WHERE id=$2 AND exam_id=$3', [nowIso(), studentId, examId])
          .catch(() => {})
        io.to(`proctor:${examId}`).emit('student:disconnected', { studentId, examId, ts: Date.now() })
        if (proctorSockets.has(examId)) proctorSockets.get(examId).delete(socket.id)
      }
      console.log('[Socket] Client disconnected:', socket.id)
    })
  })
}

module.exports = { setupSocketHandlers, proctorSockets }
