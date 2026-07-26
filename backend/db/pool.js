/* eslint-disable no-console */
/**
 * db/pool.js — PostgreSQL connection pool (singleton)
 */
const { Pool } = require('pg')

const isLocalSocket = !process.env.DB_HOST || process.env.DB_HOST === 'localhost' || process.env.DB_HOST === '127.0.0.1'

const pool = new Pool({
  host:     isLocalSocket ? '/tmp' : process.env.DB_HOST,
  port:     Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME     || 'proctordb',
  user:     process.env.DB_USER     || process.env.USER || 'postgres',
  password: process.env.DB_PASSWORD ? process.env.DB_PASSWORD : undefined,
  ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
})

pool.on('error', (err) => console.error('[DB] Pool error:', err.message))

module.exports = pool
