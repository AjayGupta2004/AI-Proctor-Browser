/* eslint-disable no-console */
/**
 * middleware/auth.js — Authentication middleware and token helpers
 */
const crypto = require('crypto')
const pool   = require('../db/pool')
const redis  = require('../db/redis')
const { nowIso } = require('../helpers')

// Legacy password hashing (HMAC-SHA256) — kept only for migration from old hashes
function legacyHashPassword(pw, salt) {
  return crypto.createHmac('sha256', salt).update(pw).digest('hex')
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex')
}

function getTokenExpiry() {
  const d = new Date()
  d.setDate(d.getDate() + 7)
  return d.toISOString()
}

async function requireAuth(req, res, next) {
  try {
    const auth  = req.headers['authorization'] || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
    if (!token) return res.status(401).json({ error: 'No token provided' })

    const now = nowIso()

    // Try Redis cache first
    const cached = await redis.getCachedSession(token)
    if (cached) {
      req.user = cached
      return next()
    }

    // Fallback to database
    const sr = await pool.query('SELECT * FROM auth_sessions WHERE token=$1 AND expires_at>$2', [token, now])
    if (!sr.rows.length) return res.status(401).json({ error: 'Invalid or expired token' })

    const ur = await pool.query('SELECT * FROM user_accounts WHERE id=$1 AND is_active=1', [sr.rows[0].user_id])
    if (!ur.rows.length) return res.status(401).json({ error: 'User not found' })

    const user = ur.rows[0]
    req.user = user

    // Cache in Redis for faster subsequent requests
    await redis.setCachedSession(token, {
      id: user.id, username: user.username, full_name: user.full_name,
      email: user.email, role: user.role, is_active: user.is_active
    })

    next()
  } catch (err) {
    console.error('[Auth] requireAuth error:', err.message)
    res.status(500).json({ error: 'Authentication service unavailable. Please try again.' })
  }
}

module.exports = {
  legacyHashPassword,
  generateToken,
  getTokenExpiry,
  requireAuth,
}
