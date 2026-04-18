'use strict';

/**
 * lib/auth.js
 * Shared auth + CORS helpers for all Vercel API routes.
 * Validates X-API-Key against API_SECRET env var.
 */

const API_SECRET = process.env.API_SECRET || process.env.VERCEL_SECRET || '';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
}

/**
 * Validates X-API-Key header. Returns true if valid (or no secret configured).
 * Sends 401 and returns false if invalid.
 */
function requireAuth(req, res) {
  if (!API_SECRET) return true; // no secret = open (dev mode)
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (!key || key !== API_SECRET) {
    res.status(401).json({ ok: false, error: 'Unauthorized — invalid X-API-Key' });
    return false;
  }
  return true;
}

function jsonErr(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}

module.exports = { cors, requireAuth, jsonErr };
