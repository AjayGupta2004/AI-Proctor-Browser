/* eslint-disable no-console */
/**
 * index.js — Slim entry point for the AI Proctor Backend
 *
 * Wires together:
 *  - Config (env vars, CORS)
 *  - Database (PostgreSQL + Redis)
 *  - Middleware (helmet, CORS, rate limiting, compression, logging)
 *  - Routes (auth, student, teacher, events, legacy)
 *  - WebSockets (Socket.IO with optional Redis adapter)
 *  - Graceful shutdown
 */
const fs   = require('fs')
const http = require('http')

const express     = require('express')
const compression = require('compression')
const morgan      = require('morgan')
const { Server }  = require('socket.io')

// ── Config ────────────────────────────────────────────────────────
const { PORT, EVIDENCE_DIR, DATA_DIR, corsOriginCheck } = require('./config')

// ── Database ──────────────────────────────────────────────────────
const pool          = require('./db/pool')
const { initSchema } = require('./db/schema')
const redis         = require('./db/redis')

// ── Middleware ─────────────────────────────────────────────────────
const { helmetMiddleware, corsMiddleware, globalLimiter, authLimiter, studentLimiter } = require('./middleware/security')
const errorHandler = require('./middleware/errorHandler')

// ── Routes ────────────────────────────────────────────────────────
const authRoutes    = require('./routes/auth')
const studentRoutes = require('./routes/student')
const teacherRoutes = require('./routes/teacher')
const eventsRoutes  = require('./routes/events')
const legacyRoutes  = require('./routes/legacy')

// ── Sockets ───────────────────────────────────────────────────────
const { setupSocketHandlers } = require('./sockets')

// ═══════════════════════════════════════════════════════════════════
// EXPRESS APP
// ═══════════════════════════════════════════════════════════════════
const app = express()

// Ensure directories exist
fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
fs.mkdirSync(DATA_DIR,     { recursive: true })

// ── Security middleware ───────────────────────────────────────────
app.use(helmetMiddleware)
app.use(corsMiddleware)
app.use(express.json({ limit: '5mb' }))

// ── Compression (gzip) ───────────────────────────────────────────
app.use(compression())

// ── Request logging ───────────────────────────────────────────────
app.use(morgan(':method :url :status :res[content-length] - :response-time ms', {
  skip: (_req, res) => res.statusCode < 400,  // Only log errors in production
  stream: { write: (msg) => console.log('[HTTP]', msg.trim()) }
}))

// ── Rate limiting ─────────────────────────────────────────────────
app.use('/api/', globalLimiter)
app.use('/api/auth/login', authLimiter)
app.use('/api/auth/register', authLimiter)
app.use('/api/student/exam/', studentLimiter)

// ── Static files ──────────────────────────────────────────────────
app.use('/evidence', express.static(EVIDENCE_DIR))

// ── Health check ──────────────────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1')
    res.json({
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      redis: redis.getIsConnected() ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString()
    })
  } catch {
    res.status(503).json({ status: 'degraded', error: 'Database connection issue' })
  }
})

// ── API Routes ────────────────────────────────────────────────────
app.use('/api/auth',    authRoutes)
app.use('/api/student', studentRoutes)
app.use('/api/teacher', teacherRoutes)
app.use('/api/exams',   eventsRoutes)   // /api/exams/:examId/events, /api/exams/:examId/report
app.use('/api/exams',   legacyRoutes)   // POST /api/exams, POST /api/exams/:examId/end

// ── Error handler (must be last) ──────────────────────────────────
app.use(errorHandler)

// ═══════════════════════════════════════════════════════════════════
// HTTP SERVER + SOCKET.IO
// ═══════════════════════════════════════════════════════════════════
const httpServer = http.createServer(app)
const io = new Server(httpServer, {
  cors: { origin: corsOriginCheck, methods: ['GET', 'POST'] },
  maxHttpBufferSize: 50 * 1024 * 1024,
})

// Set up socket event handlers
setupSocketHandlers(io)

// ═══════════════════════════════════════════════════════════════════
// SERVER BOOTSTRAP
// ═══════════════════════════════════════════════════════════════════
async function startServer() {
  try {
    // 1. Test DB connection
    await pool.query('SELECT 1')
    console.log('[DB] PostgreSQL connected successfully')

    // 2. Create/migrate schema
    await initSchema()

    // 3. Connect Redis (non-blocking — app works without it)
    const redisOk = await redis.connect()
    if (redisOk) {
      // Set up Socket.IO Redis adapter for multi-server scaling
      try {
        const { createAdapter } = require('@socket.io/redis-adapter')
        const pubClient = redis.getClient().duplicate()
        const subClient = redis.getClient().duplicate()
        await pubClient.connect()
        await subClient.connect()
        io.adapter(createAdapter(pubClient, subClient))
        console.log('[Socket.IO] Redis adapter active — multi-server broadcasting enabled')
      } catch (err) {
        console.warn('[Socket.IO] Redis adapter setup skipped:', err.message)
      }
    }

    // 4. Start HTTP + Socket.IO server
    httpServer.listen(PORT, () => {
      console.log(`[Server] AI Proctor Backend running on http://localhost:${PORT}`)
      console.log(`[Server] Database: ${process.env.DB_NAME || 'proctordb'} @ ${process.env.DB_HOST || 'localhost'}`)
      console.log(`[Server] Redis: ${redisOk ? 'connected' : 'offline (app still works)'}`)
    })
  } catch (err) {
    console.error('[FATAL] Could not start server:', err.message)
    console.error('Make sure PostgreSQL is running and .env credentials are correct.')
    process.exit(1)
  }
}

// ═══════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════
async function shutdown(signal) {
  console.log(`\n[Server] ${signal} received — shutting down gracefully...`)

  // 1. Stop accepting new connections
  httpServer.close(() => {
    console.log('[Server] HTTP server closed')
  })

  // 2. Close Socket.IO
  io.close(() => {
    console.log('[Server] Socket.IO closed')
  })

  // 3. Close Redis
  await redis.disconnect()
  console.log('[Server] Redis disconnected')

  // 4. Close PostgreSQL pool
  await pool.end()
  console.log('[Server] PostgreSQL pool closed')

  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))

// Start the server
startServer()
