/* eslint-disable no-console */
/**
 * routes/auth.js — Authentication routes
 * POST /api/auth/register, /api/auth/login, /api/auth/logout, GET /api/auth/me
 */
const express = require('express')
const bcrypt  = require('bcrypt')
const { v4: uuidv4 } = require('uuid')

const pool = require('../db/pool')
const redis = require('../db/redis')
const { BCRYPT_ROUNDS } = require('../config')
const { nowIso, sanitize } = require('../helpers')
const { requireAuth, legacyHashPassword, generateToken, getTokenExpiry } = require('../middleware/auth')

const router = express.Router()

// ── Register ──────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { username, password, fullName, email } = req.body || {}
    if (!username || !password || !fullName) return res.status(400).json({ error: 'username, password and fullName are required' })
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' })
    const ex = await pool.query('SELECT id FROM user_accounts WHERE username=$1', [username])
    if (ex.rows.length) return res.status(409).json({ error: 'Username already taken' })
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS)
    const id = uuidv4()
    await pool.query(
      'INSERT INTO user_accounts (id,username,full_name,email,password_hash,salt,role,is_active,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8)',
      [id, sanitize(username), sanitize(fullName), email ? sanitize(email) : null, hash, 'bcrypt', 'teacher', nowIso()])
    res.status(201).json({ ok: true, id, username: sanitize(username), fullName: sanitize(fullName), role: 'teacher' })
  } catch (err) {
    console.error('[Auth] Register error:', err.message)
    res.status(500).json({ error: 'Registration failed. Please try again.' })
  }
})

// ── Login ─────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {}
    if (!username || !password) return res.status(400).json({ error: 'username and password required' })
    const ur = await pool.query('SELECT * FROM user_accounts WHERE username=$1 AND is_active=1', [username])
    if (!ur.rows.length) return res.status(401).json({ error: 'Invalid credentials' })
    const user = ur.rows[0]

    let passwordValid = false

    if (user.salt === 'bcrypt') {
      passwordValid = await bcrypt.compare(password, user.password_hash)
    } else {
      const legacyHash = legacyHashPassword(password, user.salt)
      if (legacyHash === user.password_hash) {
        passwordValid = true
        const newHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
        await pool.query('UPDATE user_accounts SET password_hash=$1, salt=$2 WHERE id=$3', [newHash, 'bcrypt', user.id])
        console.log('[Auth] Auto-migrated password to bcrypt for user:', user.username)
      }
    }

    if (!passwordValid) return res.status(401).json({ error: 'Invalid credentials' })
    const token = generateToken()
    await pool.query('INSERT INTO auth_sessions (token,user_id,created_at,expires_at) VALUES ($1,$2,$3,$4)', [token, user.id, nowIso(), getTokenExpiry()])
    res.json({ ok: true, token, user: { id: user.id, username: user.username, fullName: user.full_name, email: user.email, role: user.role } })
  } catch (err) {
    console.error('[Auth] Login error:', err.message)
    res.status(500).json({ error: 'Authentication service unavailable. Please try again.' })
  }
})

// ── Me ────────────────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  const u = req.user
  res.json({ id: u.id, username: u.username, fullName: u.full_name, email: u.email, role: u.role })
})

// ── Logout ────────────────────────────────────────────────────────
router.post('/logout', requireAuth, async (req, res) => {
  try {
    const token = req.headers['authorization'].slice(7)
    await pool.query('DELETE FROM auth_sessions WHERE token=$1', [token])
    // Invalidate cached session
    await redis.invalidateSession(token)
    res.json({ ok: true })
  } catch (err) {
    console.error('[Auth] Logout error:', err.message)
    res.status(500).json({ error: 'Logout failed. Please try again.' })
  }
})

module.exports = router
