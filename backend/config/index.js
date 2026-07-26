/* eslint-disable no-console */
/**
 * config/index.js — Centralized configuration
 * All environment variables, constants, and CORS setup.
 */
const crypto = require('crypto')

require('dotenv').config()

// ─── Server ───────────────────────────────────────────────────────
const PORT         = process.env.PROCTOR_PORT ? Number(process.env.PROCTOR_PORT) : 4000
const BCRYPT_ROUNDS = 12
const KIOSK_SECRET  = process.env.KIOSK_SECRET || 'proctor-kiosk-attestation-key'

// ─── Paths ────────────────────────────────────────────────────────
const path = require('path')
const EVIDENCE_DIR = path.join(__dirname, '..', 'evidence')
const DATA_DIR     = path.join(__dirname, '..', 'data')

// ─── CORS ─────────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:4000,http://127.0.0.1:4000')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean)

function corsOriginCheck(origin, callback) {
  if (!origin) return callback(null, true)
  if (origin.startsWith('file://')) return callback(null, true)
  if (allowedOrigins.includes(origin)) return callback(null, true)
  callback(new Error('CORS: origin ' + origin + ' not allowed'))
}

// ─── Redis ────────────────────────────────────────────────────────
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379'
const REDIS_ENABLED = process.env.REDIS_ENABLED !== 'false'  // default: enabled

// ─── Kiosk Attestation ───────────────────────────────────────────
function verifyKioskAttestation(attestation) {
  if (!attestation || typeof attestation !== 'object') return false
  const { isKiosk, timestamp, signature } = attestation
  if (!isKiosk || !timestamp || !signature) return false
  const age = Date.now() - timestamp
  if (age > 5 * 60 * 1000 || age < -30000) return false
  const expected = crypto.createHmac('sha256', KIOSK_SECRET)
    .update(`kiosk:${isKiosk}:${timestamp}`)
    .digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
  } catch { return false }
}

module.exports = {
  PORT,
  BCRYPT_ROUNDS,
  KIOSK_SECRET,
  EVIDENCE_DIR,
  DATA_DIR,
  allowedOrigins,
  corsOriginCheck,
  REDIS_URL,
  REDIS_ENABLED,
  verifyKioskAttestation,
}
