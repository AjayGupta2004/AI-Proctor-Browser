/* eslint-disable no-console */
/**
 * db/redis.js — Redis client singleton with graceful fallback
 *
 * If Redis is unavailable, all cache operations silently return null
 * so the app continues to work (just without caching benefits).
 */
const Redis = require('ioredis')
const { REDIS_URL, REDIS_ENABLED } = require('../config')

let redis = null
let isConnected = false

// Cache TTLs (seconds)
const TTL = {
  EXAM_DATA: 300,        // 5 min — exam questions rarely change during an exam
  AUTH_SESSION: 3600,    // 1 hour — auth sessions checked frequently
  STUDENT_SESSION: 1800, // 30 min — active exam sessions
}

function createClient() {
  if (!REDIS_ENABLED) {
    console.log('[Redis] Disabled via REDIS_ENABLED=false')
    return null
  }

  try {
    const client = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 5) {
          console.warn('[Redis] Max reconnect attempts reached, giving up')
          return null  // stop retrying
        }
        return Math.min(times * 200, 3000)
      },
      lazyConnect: true,
      enableOfflineQueue: false,
    })

    client.on('connect', () => {
      isConnected = true
      console.log('[Redis] Connected to', REDIS_URL)
    })

    client.on('error', (err) => {
      if (isConnected) {
        console.warn('[Redis] Connection error:', err.message)
      }
      isConnected = false
    })

    client.on('close', () => {
      isConnected = false
    })

    return client
  } catch (err) {
    console.warn('[Redis] Failed to create client:', err.message)
    return null
  }
}

async function connect() {
  if (!REDIS_ENABLED) return false
  redis = createClient()
  if (!redis) return false

  try {
    await redis.connect()
    return true
  } catch (err) {
    console.warn('[Redis] Initial connection failed:', err.message, '— running without cache')
    redis = null
    return false
  }
}

// ── Cache Operations (safe — never throw) ─────────────────────────

async function cacheGet(key) {
  if (!redis || !isConnected) return null
  try {
    const val = await redis.get(key)
    return val ? JSON.parse(val) : null
  } catch { return null }
}

async function cacheSet(key, value, ttlSeconds) {
  if (!redis || !isConnected) return false
  try {
    const str = JSON.stringify(value)
    if (ttlSeconds) {
      await redis.setex(key, ttlSeconds, str)
    } else {
      await redis.set(key, str)
    }
    return true
  } catch { return false }
}

async function cacheDel(key) {
  if (!redis || !isConnected) return false
  try {
    await redis.del(key)
    return true
  } catch { return false }
}

async function cacheDelPattern(pattern) {
  if (!redis || !isConnected) return false
  try {
    const keys = await redis.keys(pattern)
    if (keys.length > 0) await redis.del(...keys)
    return true
  } catch { return false }
}

// ── Exam Data Cache ───────────────────────────────────────────────

async function getCachedExam(examCode) {
  return cacheGet(`exam:${examCode}`)
}

async function setCachedExam(examCode, examData) {
  return cacheSet(`exam:${examCode}`, examData, TTL.EXAM_DATA)
}

async function invalidateExam(examCode) {
  return cacheDel(`exam:${examCode}`)
}

// ── Auth Session Cache ────────────────────────────────────────────

async function getCachedSession(token) {
  return cacheGet(`auth:${token}`)
}

async function setCachedSession(token, sessionData) {
  return cacheSet(`auth:${token}`, sessionData, TTL.AUTH_SESSION)
}

async function invalidateSession(token) {
  return cacheDel(`auth:${token}`)
}

// ── Graceful shutdown ─────────────────────────────────────────────

async function disconnect() {
  if (redis) {
    try { await redis.quit() } catch {}
    redis = null
    isConnected = false
  }
}

function getClient() {
  return redis
}

function getIsConnected() {
  return isConnected
}

module.exports = {
  connect,
  disconnect,
  getClient,
  getIsConnected,
  cacheGet,
  cacheSet,
  cacheDel,
  cacheDelPattern,
  getCachedExam,
  setCachedExam,
  invalidateExam,
  getCachedSession,
  setCachedSession,
  invalidateSession,
  TTL,
}
