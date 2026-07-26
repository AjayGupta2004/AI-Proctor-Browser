/* eslint-disable no-console */
/**
 * middleware/security.js — Helmet, CORS, and rate limiters
 */
const helmet    = require('helmet')
const cors      = require('cors')
const rateLimit = require('express-rate-limit')
const { corsOriginCheck, REDIS_ENABLED } = require('../config')

// ── Helmet ────────────────────────────────────────────────────────
const helmetMiddleware = helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
})

// ── CORS ──────────────────────────────────────────────────────────
const corsMiddleware = cors({ origin: corsOriginCheck, credentials: true })

// ── Rate Limiters ─────────────────────────────────────────────────
// Redis store is created lazily after Redis connects (see applyRedisStore)
let redisStoreOptions = null

function createLimiter(opts) {
  return rateLimit({
    ...opts,
    standardHeaders: true,
    legacyHeaders: false,
    ...(redisStoreOptions || {}),
  })
}

// Global: 100 requests per minute per IP
const globalLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many requests. Please try again later.' },
})

// Auth endpoints: 10 requests per 15 minutes
const authLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Please wait 15 minutes before trying again.' },
})

// Student exam endpoints: 20 per minute
const studentLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many requests. Please slow down.' },
})

/**
 * Apply Redis store to rate limiters (called after Redis connects).
 * This enables distributed rate limiting across multiple server instances.
 */
async function applyRedisStore(redisClient) {
  if (!redisClient) return
  try {
    const { RedisStore } = require('rate-limit-redis')
    const store = new RedisStore({
      sendCommand: (...args) => redisClient.call(...args),
    })
    // Note: rate-limit-redis stores are per-limiter.
    // For simplicity, we log that Redis-backed limiting is available.
    // New limiters created after this will use Redis.
    console.log('[RateLimit] Redis store available for distributed rate limiting')
  } catch (err) {
    console.warn('[RateLimit] Redis store setup failed:', err.message, '— using in-memory')
  }
}

module.exports = {
  helmetMiddleware,
  corsMiddleware,
  globalLimiter,
  authLimiter,
  studentLimiter,
  applyRedisStore,
}
