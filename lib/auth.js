// lib/auth.js — shared auth + CORS helpers for all endpoints
// Set API_SECRET_KEY in Vercel env vars to lock down the API.
// If not set, the API runs in open/dev mode (all requests allowed).

/**
 * Adds CORS headers to every response.
 * Called at the top of every handler before anything else.
 */
export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-API-Key,Authorization');
}

/**
 * Validates the API secret key from:
 *   - X-API-Key header
 *   - Authorization: Bearer <key> header
 *   - ?key=<key> query param
 *
 * Returns true if auth passes, false + sends 401 if not.
 */
export function checkAuth(req, res) {
  const secret = process.env.API_SECRET_KEY;
  if (!secret) return true; // dev mode — no key set

  const provided =
    req.headers['x-api-key'] ||
    req.headers['authorization']?.replace(/^Bearer\s+/i, '') ||
    req.query?.key;

  if (!provided || provided !== secret) {
    res.status(401).json({
      error: 'Unauthorized',
      hint: 'Pass your API key via X-API-Key header, Authorization: Bearer <key>, or ?key=<key>',
    });
    return false;
  }
  return true;
}

/**
 * Helper: handle OPTIONS preflight + CORS in one call.
 * Returns true if the caller should return early (preflight handled).
 */
export function handleCors(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }
  return false;
}
