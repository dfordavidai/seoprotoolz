/**
 * api/proxy.js — Universal Server-Side Proxy
 * Routes ALL browser requests through Vercel's servers, eliminating CORS.
 * Supports cookie threading for CSRF-protected sites (rentry.co, etc).
 * Supports arbitrary headers including auth tokens for API sites.
 *
 * GET  /api/proxy?url=<encoded>&cookies=<encoded>   — simple GET proxy
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
 *   ok          boolean
 *   status      number
 *   status_code number  — alias of status (frontend reads this field)
 *   redirected  boolean
 *   text        string  — Response body as text
 *   body        object  — Response body parsed as JSON (if applicable)
 *   cookies     string  — All Set-Cookie values joined
 *   finalUrl    string  — Final URL after redirects
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

function mergeCookies(existing, incoming) {
  const cookieMap = new Map();
  (existing || '').split(';').forEach(pair => {
    const [k, ...v] = pair.trim().split('=');
    if (k && k.trim()) cookieMap.set(k.trim(), v.join('=').trim());
  });
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
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  // Parse request — GET uses query params, POST uses JSON body
  let url, method, reqHeaders, reqBody, incomingCookies, timeout, returnCookies;

  if (req.method === 'GET') {
    url             = req.query.url || '';
    method          = 'GET';
    reqHeaders      = {};
    reqBody         = null;
    incomingCookies = req.query.cookies || '';
    timeout         = parseInt(req.query.timeout) || 30;
    returnCookies   = true;
  } else {
    let body = {};
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
    url             = body.url;
    method          = body.method || 'GET';
    reqHeaders      = body.headers || {};
    reqBody         = body.body || null;
    incomingCookies = body.cookies || '';
    timeout         = body.timeout || 30;
    returnCookies   = body.returnCookies !== undefined ? body.returnCookies : true;
  }

  if (!url) return res.status(400).json({ error: 'url is required' });
  if (isBlockedUrl(url)) return res.status(403).json({ error: 'Blocked URL' });

  let parsedUrl;
  try { parsedUrl = new URL(url); } catch (e) {
    return res.status(400).json({ error: 'Invalid URL: ' + url });
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return res.status(400).json({ error: 'Only http/https URLs allowed' });
  }

  // Build fetch headers
  const fetchHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    ...reqHeaders,
  };

  if (incomingCookies) {
    fetchHeaders['Cookie'] = incomingCookies;
  }

  // Remove problematic hop-by-hop headers
  delete fetchHeaders['host'];
  delete fetchHeaders['Host'];
  delete fetchHeaders['origin'];
  delete fetchHeaders['Origin'];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);

  let fetchResponse;
  const redirectHistory = [];

  try {
    let currentUrl          = url;
    let accumulatedCookies  = incomingCookies;
    let currentMethod       = method.toUpperCase();
    let currentBody         = reqBody;
    let redirectCount       = 0;

    while (redirectCount < 10) {
      const opts = {
        method:   currentMethod,
        headers:  { ...fetchHeaders, ...(accumulatedCookies ? { Cookie: accumulatedCookies } : {}) },
        signal:   controller.signal,
        redirect: 'manual',
      };

      if (currentBody != null && !['GET', 'HEAD'].includes(currentMethod)) {
        opts.body = typeof currentBody === 'string' ? currentBody : JSON.stringify(currentBody);
      }

      fetchResponse = await fetch(currentUrl, opts);

      // Accumulate Set-Cookie headers
      if (returnCookies) {
        const setCookies = [];
        fetchResponse.headers.forEach((value, key) => {
          if (key.toLowerCase() === 'set-cookie') setCookies.push(value);
        });
        if (setCookies.length) {
          accumulatedCookies = mergeCookies(accumulatedCookies, setCookies);
        }
      }

      // Follow redirects manually so we capture every Set-Cookie along the chain
      if ([301, 302, 303, 307, 308].includes(fetchResponse.status)) {
        const location = fetchResponse.headers.get('location');
        if (!location) break;
        redirectHistory.push(currentUrl);
        currentUrl = location.startsWith('http') ? location : new URL(location, currentUrl).href;
        // 303 always becomes GET with no body
        if (fetchResponse.status === 303) {
          currentMethod = 'GET';
          currentBody   = null;
        }
        // 301/302 POST→GET convention (match browser behaviour)
        if ([301, 302].includes(fetchResponse.status) && currentMethod === 'POST') {
          currentMethod = 'GET';
          currentBody   = null;
        }
        redirectCount++;
        continue;
      }
      break; // non-redirect → done
    }

    clearTimeout(timer);

    const responseText = await fetchResponse.text().catch(() => '');
    let responseJson   = null;
    try { responseJson = JSON.parse(responseText); } catch (_) {}

    const finalSetCookies = [];
    fetchResponse.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'set-cookie') finalSetCookies.push(value);
    });
    const allCookies = returnCookies
      ? mergeCookies(incomingCookies, finalSetCookies)
      : '';

    const upstreamStatus = fetchResponse.status;
    const wasRedirected  = redirectHistory.length > 0;

    return res.status(200).json({
      ok:          fetchResponse.ok,
      status:      upstreamStatus,
      status_code: upstreamStatus,   // ← frontend reads status_code in all unwrap paths
      redirected:  wasRedirected,
      text:        responseText,
      body:        responseJson,
      cookies:     allCookies,
      finalUrl:    currentUrl,
      redirects:   redirectHistory,
    });

  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err.name === 'AbortError';
    return res.status(502).json({
      ok:          false,
      status:      502,
      status_code: 502,
      error:       isTimeout ? `Request timed out after ${timeout}s` : err.message,
      url,
    });
  }
}
