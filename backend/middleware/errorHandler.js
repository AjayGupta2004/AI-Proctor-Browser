/* eslint-disable no-console */
/**
 * middleware/errorHandler.js — Centralized Express error handler
 */
function errorHandler(err, _req, res, _next) {
  // CORS errors from our origin check
  if (err.message && err.message.startsWith('CORS:')) {
    return res.status(403).json({ error: 'Access denied: origin not allowed.' })
  }
  console.error('[Server] Unhandled error:', err.message)
  res.status(500).json({ error: 'An unexpected error occurred. Please try again.' })
}

module.exports = errorHandler
