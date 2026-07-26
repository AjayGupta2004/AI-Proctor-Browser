/* Verification script — checks all routes and cross-references with frontend */
require('dotenv').config()
const express = require('express')
const app = express()
app.use(express.json())
app.get('/api/health', (q,s) => s.json({ok:1}))
app.use('/api/auth', require('./routes/auth'))
app.use('/api/student', require('./routes/student'))
app.use('/api/teacher', require('./routes/teacher'))
app.use('/api/exams', require('./routes/events'))
app.use('/api/exams', require('./routes/legacy'))

// Expected endpoints from frontend pages
const expected = [
  'POST /api/auth/register',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'GET /api/auth/me',
  'GET /api/student/exam/:code',
  'POST /api/student/exam/:code/session',
  'POST /api/student/exam/:code/submit',
  'GET /api/teacher/exams',
  'POST /api/teacher/exams',
  'GET /api/teacher/exams/:id',
  'PUT /api/teacher/exams/:id',
  'DELETE /api/teacher/exams/:id',
  'PUT /api/teacher/exams/:id/publish',
  'PUT /api/teacher/exams/:id/activate',
  'PUT /api/teacher/exams/:id/end',
  'GET /api/teacher/exams/:id/questions',
  'POST /api/teacher/exams/:id/questions/bulk',
  'PUT /api/teacher/questions/:qId',
  'DELETE /api/teacher/questions/:qId',
  'GET /api/teacher/exams/:id/results',
  'GET /api/teacher/exams/:id/results/export',
  'GET /api/teacher/exams/:id/live',
  'GET /api/teacher/students',
  'GET /api/teacher/students/:roll',
  'POST /api/exams',
  'POST /api/exams/:examId/end',
  'POST /api/exams/:examId/events',
  'GET /api/exams/:examId/events',
  'GET /api/exams/:examId/report',
  'GET /api/health',
]

// Collect registered routes
const registered = []
function collect(stack, prefix) {
  stack.forEach(layer => {
    if (layer.route) {
      Object.keys(layer.route.methods).forEach(method => {
        registered.push(method.toUpperCase() + ' ' + prefix + layer.route.path)
      })
    } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      // Extract path from regexp
      const re = layer.regexp.source
      const match = re.match(/^\^\\\/([^\\?]+)/)
      const seg = match ? '/' + match[1].replace(/\\\//g, '/') : ''
      collect(layer.handle.stack, prefix + seg)
    }
  })
}
collect(app._router.stack, '')

console.log('=== Route Verification ===')
let allOk = true
expected.forEach(e => {
  const [method, path] = e.split(' ')
  // Normalize :param to match
  const normalizedPath = path.replace(/:[^/]+/g, ':param')
  const found = registered.some(r => {
    const [rm, rp] = r.split(' ')
    return rm === method && rp.replace(/:[^/]+/g, ':param') === normalizedPath
  })
  if (found) {
    console.log('✅', e)
  } else {
    console.log('❌ MISSING:', e)
    allOk = false
  }
})

if (allOk) {
  console.log('\n🎉 All', expected.length, 'expected routes are registered!')
} else {
  console.log('\n⚠️  Some routes are missing!')
}
process.exit(0)
