// lib/auth.js — Shared auth + CORS helpers for all Vercel API routes.
// Validates X-API-Key (or Authorization: Bearer) against API_SECRET env var.

const API_SECRET = process.env.API_SECRET || process.env.VERCEL_SECRET || '';

/**
 * handleCors — set CORS headers, short-circuit OPTIONS preflight.
 * Returns true if the request was an OPTIONS preflight (caller must return immediately).
 */
export function handleCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization, x-secret');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

/**
 * checkAuth — validates X-API-Key or Authorization: Bearer header.
 * Returns true if authenticated (or no secret configured = open/dev mode).
 * Sends 401 and returns false if the key is wrong.
 */
export function checkAuth(req, res) {
  if (!API_SECRET) return true; // no secret = open dev mode
  const key =
    req.headers['x-api-key'] ||
    req.headers['x-secret'] ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (!key || key !== API_SECRET) {
    res.status(401).json({ ok: false, error: 'Unauthorized — invalid X-API-Key' });
    return false;
  }
  return true;
}

// Legacy aliases — kept for backwards compatibility with older api files
export const cors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization, x-secret');
};
export const requireAuth = checkAuth;

export function jsonErr(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}
