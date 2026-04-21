/**
 * api/proxy.js — Universal Server-Side Proxy
 * Routes ALL browser requests through Vercel's servers, eliminating CORS.
 * Supports cookie threading for CSRF-protected sites (rentry.co, etc).
 * Supports arbitrary headers including auth tokens for API sites.
 *
 * POST /api/proxy
 * Body: {
 *   url        string   — Target URL to fetch
 *   method     string   — HTTP method (default: GET)
 *   headers    object   — Request headers to forward
 *   body       string   — Request body (for POST/PUT)
 *   cookies    string   — Cookie string to inject (for CSRF threading)
 *   timeout    number   — Timeout in seconds (default: 30)
 *   returnCookies boolean — Whether to return Set-Cookie values
 * }
 * Response: {
 *   ok         boolean
 *   status     number
 *   text       string  — Response body as text
 *   body       object  — Response body parsed as JSON (if applicable)
 *   cookies    string  — All Set-Cookie values joined
 *   finalUrl   string  — Final URL after redirects
 * }
 */

export const config = { maxDuration: 60 };

// ── AUTH ──────────────────────────────────────────────────────────────────────

function isAuthorized(req) {
  const apiKey = process.env.API_SECRET || process.env.PROXY_SECRET || '';
  if (!apiKey) return true; // No secret set → open (dev mode)
  const provided = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  return provided === apiKey;
}

// ── CORS HEADERS ──────────────────────────────────────────────────────────────

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
}

// ── DISALLOWED TARGETS (safety) ───────────────────────────────────────────────

const BLOCKED_PATTERNS = [
  /localhost/i, /127\.0\.0\.1/, /::1/, /0\.0\.0\.0/,
  /169\.254\./, /10\.\d+\.\d+\.\d+/, /192\.168\./,
];

function isBlockedUrl(url) {
  return BLOCKED_PATTERNS.some(p => p.test(url));
}

// ── COOKIE HELPERS ────────────────────────────────────────────────────────────

function parseSetCookieHeaders(headers) {
  // Node fetch returns set-cookie as array or single string
  const raw = headers.raw?.()?.['set-cookie'] || [];
  return Array.isArray(raw) ? raw : [raw].filter(Boolean);
}

function mergeCookies(existing, incoming) {
  const cookieMap = new Map();
  // Parse existing
  (existing || '').split(';').forEach(pair => {
    const [k, ...v] = pair.trim().split('=');
    if (k && k.trim()) cookieMap.set(k.trim(), v.join('=').trim());
  });
  // Parse incoming (set-cookie values, newline separated)
  incoming.forEach(setCookie => {
    const nameVal = setCookie.split(';')[0].trim();
    const [k, ...v] = nameVal.split('=');
    if (k && k.trim()) cookieMap.set(k.trim(), v.join('=').trim());
  });
  return [...cookieMap.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const {
    url,
    method = 'GET',
    headers: reqHeaders = {},
    body: reqBody = null,
    cookies: incomingCookies = '',
    timeout = 30,
    returnCookies = true,
  } = body;

  if (!url) return res.status(400).json({ error: 'url is required' });
  if (isBlockedUrl(url)) return res.status(403).json({ error: 'Blocked URL' });

  // Validate URL
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch (e) {
    return res.status(400).json({ error: 'Invalid URL: ' + url });
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return res.status(400).json({ error: 'Only http/https URLs allowed' });
  }

  // Build fetch options
  const fetchHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    ...reqHeaders,
  };

  // Inject cookies if provided (for CSRF threading)
  if (incomingCookies) {
    fetchHeaders['Cookie'] = incomingCookies;
  }

  // Remove headers that could cause issues
  delete fetchHeaders['host'];
  delete fetchHeaders['Host'];
  delete fetchHeaders['origin'];
  delete fetchHeaders['Origin'];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);

  let fetchResponse;
  const redirectHistory = [];

  try {
    // Manual redirect handling to capture intermediate Set-Cookie headers
    let currentUrl = url;
    let accumulatedCookies = incomingCookies;
    let redirectCount = 0;

    while (redirectCount < 10) {
      const opts = {
        method: method.toUpperCase(),
        headers: { ...fetchHeaders, ...(accumulatedCookies ? { Cookie: accumulatedCookies } : {}) },
        signal: controller.signal,
        redirect: 'manual', // handle redirects manually to capture cookies
      };

      // Only send body for non-GET/HEAD requests
      if (reqBody != null && !['GET','HEAD'].includes(opts.method)) {
        opts.body = typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody);
      }

      fetchResponse = await fetch(currentUrl, opts);

      // Collect cookies from this response
      if (returnCookies) {
        const setCookies = [];
        fetchResponse.headers.forEach((value, key) => {
          if (key.toLowerCase() === 'set-cookie') setCookies.push(value);
        });
        if (setCookies.length) {
          accumulatedCookies = mergeCookies(accumulatedCookies, setCookies);
        }
      }

      // Follow redirect
      if ([301, 302, 303, 307, 308].includes(fetchResponse.status)) {
        const location = fetchResponse.headers.get('location');
        if (!location) break;
        redirectHistory.push(currentUrl);
        currentUrl = location.startsWith('http') ? location : new URL(location, currentUrl).href;
        // For 303, always switch to GET
        if (fetchResponse.status === 303) {
          opts.method = 'GET';
          delete opts.body;
        }
        redirectCount++;
        continue;
      }
      break; // Non-redirect — we're done
    }

    clearTimeout(timer);

    const responseText = await fetchResponse.text().catch(() => '');
    let responseJson = null;
    try { responseJson = JSON.parse(responseText); } catch (_) {}

    // Collect all Set-Cookie from final response
    const finalSetCookies = [];
    fetchResponse.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'set-cookie') finalSetCookies.push(value);
    });
    const allCookies = returnCookies
      ? mergeCookies(incomingCookies, finalSetCookies)
      : '';

    const wasRedirected = redirectHistory.length > 0;
    return res.status(200).json({
      ok: fetchResponse.ok,
      status: fetchResponse.status,        // backward compat
      status_code: fetchResponse.status,   // frontend reads status_code — this was the false-flag bug
      text: responseText,
      body: responseJson,
      cookies: allCookies,
      finalUrl: fetchResponse.url || currentUrl,
      redirects: redirectHistory,
      redirected: wasRedirected,           // frontend reads redirected for WP 302 success detection
    });

  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err.name === 'AbortError';
    return res.status(502).json({
      ok: false,
      error: isTimeout ? `Request timed out after ${timeout}s` : err.message,
      url,
    });
  }
}
