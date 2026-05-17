/**
 * api/proxy.js — Universal Server-Side Proxy  v2.0
 * Routes ALL browser requests through Vercel's servers, eliminating CORS.
 * Supports cookie threading for CSRF-protected sites (rentry.co, etc).
 * Supports arbitrary headers including auth tokens for API sites.
 *
 * GET  /api/proxy?url=<encoded>&cookies=<encoded>   — simple GET proxy
 * POST /api/proxy
 * Body: {
 *   url           string   — Target URL to fetch
 *   method        string   — HTTP method (default: GET)
 *   headers       object   — Request headers to forward
 *   body          string   — Request body (for POST/PUT)
 *   cookies       string   — Cookie string to inject (for CSRF threading)
 *   timeout       number   — Timeout in MILLISECONDS (default: 30000)
 *                           NOTE: also accepts seconds for back-compat (auto-detected)
 *   returnCookies boolean  — Whether to return Set-Cookie values (default: true)
 *   returnBody    boolean  — Always include raw HTML body string (default: true)
 *   followRedirects boolean — Follow redirects (default: true, always on)
 *   maxBodyBytes  number   — Max response body size in bytes (default: 3MB)
 * }
 * Response: {
 *   ok          boolean
 *   status      number
 *   status_code number    — alias of status (all frontend paths read this)
 *   redirected  boolean
 *   text        string    — Response body as raw text (ALWAYS present)
 *   body        string    — ALIAS of text (raw HTML/text, NOT parsed JSON)
 *                           ← SCANNER READS THIS — must be the raw string
 *   bodyJson    object    — Parsed JSON if response was JSON, else null
 *   cookies     string    — All Set-Cookie values joined
 *   finalUrl    string    — Final URL after redirects
 *   redirects   string[]  — Redirect chain
 *   truncated   boolean   — True if body was cut at maxBodyBytes
 * }
 *
 * BREAKING CHANGE from v1: `body` is now the raw text string, not parsed JSON.
 * Parsed JSON is available in `bodyJson`. All existing frontend code that reads
 * `body` for upload scanner purposes now works correctly.
 */

export const config = { maxDuration: 60 };

// ── ROTATING USER-AGENTS (realistic browser fingerprints) ────────────────────
// Sites like UCSF, ResearchGate, Academia block generic bot UAs.
// Rotate per-request to avoid pattern detection.

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Default browser-realistic headers for HTML page fetches
function browserHeaders(ua, cookies) {
  const h = {
    'User-Agent':      ua || randomUA(),
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control':   'no-cache',
    'Pragma':          'no-cache',
    'Sec-Fetch-Dest':  'document',
    'Sec-Fetch-Mode':  'navigate',
    'Sec-Fetch-Site':  'none',
    'Upgrade-Insecure-Requests': '1',
  };
  if (cookies) h['Cookie'] = cookies;
  return h;
}

// Max body size to prevent Vercel 4.5MB response limit crashes (default 3MB)
const DEFAULT_MAX_BODY_BYTES = 3 * 1024 * 1024;

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

// ── PDF UPLOAD: MULTIPART BUILDER ─────────────────────────────────────────────

function buildMultipart(fields, fileField, filename, pdfBuf) {
  const boundary = '----DaveAISEOBoundary' + Math.random().toString(36).slice(2);
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value == null || value === '') continue;
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  parts.push(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fileField}"; filename="${filename}"\r\n` +
    `Content-Type: application/pdf\r\n\r\n`
  );
  const textBuf = Buffer.from(parts.join(''));
  const endBuf  = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body    = Buffer.concat([textBuf, pdfBuf, endBuf]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function extractUploadUrl(body, platformDomain) {
  if (!body) return null;
  try {
    const j = JSON.parse(body);
    const candidates = [j.url, j.permalink, j.view_url, j.link, j.publicUrl,
      j.data?.url, j.data?.permalink, j.document?.view_url, j.document?.url,
      j.result?.url, j.file?.url];
    for (const c of candidates) {
      if (c && typeof c === 'string' && c.startsWith('http')) return c;
    }
  } catch {}
  const urlRe = /https?:\/\/[^\s"'<>]+/g;
  const all = [...(body.matchAll(urlRe) || [])].map(m => m[0]);
  if (platformDomain) {
    const match = all.find(u => u.includes(platformDomain) && u.length > 20);
    if (match) return match;
  }
  const og = body.match(/property=[\"']og:url[\"'][^>]*content=[\"']([^\"']+)[\"']/i)
          || body.match(/<link[^>]+rel=[\"']canonical[\"'][^>]*href=[\"']([^\"']+)[\"']/i);
  if (og?.[1]) return og[1];
  return null;
}

const PDF_PLATFORMS = {
  scribd:     { uploadUrl: 'https://www.scribd.com/upload-document',          fileField: 'file',      domain: 'scribd.com',     loginUrl: 'https://www.scribd.com/login',           extraFields: (t,d,k) => ({ title:t, description:d, tags:k }) },
  slideshare: { uploadUrl: 'https://www.slideshare.net/upload',               fileField: 'slidefile', domain: 'slideshare.net', loginUrl: 'https://www.slideshare.net/login',        extraFields: (t,d,k) => ({ title:t, description:d, tags:k }) },
  academia:   { uploadUrl: 'https://www.academia.edu/upload',                 fileField: 'file',      domain: 'academia.edu',   loginUrl: 'https://www.academia.edu/login',          extraFields: (t,d,k) => ({ title:t, description:d, keywords:k }) },
  calameo:    { uploadUrl: 'https://en.calameo.com/publish/',                 fileField: 'file',      domain: 'calameo.com',    loginUrl: 'https://en.calameo.com/login',            extraFields: (t,d)   => ({ name:t, description:d }) },
  edocr:      { uploadUrl: 'https://www.edocr.com/upload',                    fileField: 'file',      domain: 'edocr.com',      loginUrl: 'https://www.edocr.com/user/login',        extraFields: (t,d,k) => ({ title:t, description:d, tags:k }) },
  yumpu:      { uploadUrl: 'https://www.yumpu.com/en/document/upload',        fileField: 'file',      domain: 'yumpu.com',      loginUrl: 'https://www.yumpu.com/en/users/sign_in',  extraFields: (t,d)   => ({ name:t, description:d }) },
  docdroid:   { uploadUrl: 'https://www.docdroid.net/upload',                 fileField: 'file',      domain: 'docdroid.net',   loginUrl: 'https://www.docdroid.net/login',          extraFields: (t)     => ({ name:t }) },
  pdfcoffee:  { uploadUrl: 'https://pdfcoffee.com/upload/',                   fileField: 'file',      domain: 'pdfcoffee.com',  loginUrl: 'https://pdfcoffee.com/wp-login.php',      extraFields: (t,d)   => ({ title:t, description:d }) },
  kupdf:      { uploadUrl: 'https://kupdf.net/upload',                        fileField: 'file',      domain: 'kupdf.net',      loginUrl: 'https://kupdf.net/account/login',         extraFields: (t,d)   => ({ title:t, description:d }) },
  docplayer:  { uploadUrl: 'https://docplayer.net/upload/',                   fileField: 'file',      domain: 'docplayer.net',  loginUrl: 'https://docplayer.net/login',             extraFields: (t,d)   => ({ title:t, description:d }) },
};

async function handlePdfUpload(body, res) {
  const {
    platform = 'archive',
    pdfBase64,
    filename  = 'document.pdf',
    title     = 'Document',
    description = '',
    tags      = '',
    keyword   = '',
    cookie    = '',
    accessKey = '',
    secretKey = '',
    apiToken  = '',
    uploadUrl: customUrl,
    fileField: customField,
  } = body;

  if (!pdfBase64) return res.status(400).json({ ok: false, error: 'pdfBase64 is required' });

  let pdfBuf;
  try {
    pdfBuf = Buffer.from(pdfBase64, 'base64');
    if (pdfBuf.length < 100) throw new Error('PDF too small');
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'Invalid base64 PDF: ' + e.message });
  }

  try {
    // ── Archive.org S3 ───────────────────────────────────────────────────────
    if (platform === 'archive') {
      if (!accessKey || !secretKey)
        return res.status(400).json({ ok: false, error: 'Archive.org requires accessKey + secretKey', platform });

      const slugId = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
      const identifier = slugId + '-' + Date.now().toString(36);
      const uploadUrl  = `https://s3.us.archive.org/${identifier}/${encodeURIComponent(filename)}`;

      const archiveHeaders = {
        Authorization: `LOW ${accessKey}:${secretKey}`,
        'Content-Type': 'application/pdf',
        'Content-Length': String(pdfBuf.length),
        'x-archive-meta-title': title,
        'x-archive-meta-subject': keyword || title,
        'x-archive-meta-description': `Comprehensive guide on ${keyword || title}. SEO-optimized resource.`,
        'x-archive-meta-mediatype': 'texts',
        'x-archive-meta-language': 'en',
        'x-archive-meta-collection': 'opensource',
        'x-archive-auto-make-bucket': '1',
      };

      // Retry up to 4 times with exponential backoff — handles 503 SlowDown throttling
      let lastStatus = 0, lastErr = '';
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0) {
          const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
          await new Promise(r => setTimeout(r, delay));
        }
        let archiveRes;
        try {
          archiveRes = await fetch(uploadUrl, { method: 'PUT', headers: archiveHeaders, body: pdfBuf });
        } catch (fetchErr) {
          lastErr = fetchErr.message;
          continue;
        }
        lastStatus = archiveRes.status;
        if (archiveRes.ok || archiveRes.status === 200) {
          return res.status(200).json({ ok: true, platform, method: 's3_api', url: `https://archive.org/details/${identifier}` });
        }
        const errText = await archiveRes.text().catch(() => archiveRes.statusText);
        lastErr = `HTTP ${archiveRes.status}: ${errText.slice(0, 200)}`;
        // Only retry on 503 SlowDown — fail fast on auth errors
        if (archiveRes.status !== 503) break;
      }
      return res.status(200).json({ ok: false, platform, error: `Archive.org upload failed after retries — ${lastErr}` });
    }

    // ── Issuu API v2 ─────────────────────────────────────────────────────────
    if (platform === 'issuu') {
      if (!apiToken)
        return res.status(400).json({ ok: false, error: 'Issuu requires apiToken', platform });

      const draftRes = await fetch('https://api.issuu.com/v2/drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
        body: JSON.stringify({ title, description: description || title, access: 'public', downloadable: false }),
      });
      const draft = await draftRes.json();
      if (!draftRes.ok || !draft.slug)
        return res.status(200).json({ ok: false, platform, error: 'Issuu draft failed: ' + (draft.message || draftRes.status) });

      const { body: mpBody, contentType } = buildMultipart({}, 'file', filename, pdfBuf);
      const uploadRes = await fetch(`https://api.issuu.com/v2/drafts/${draft.slug}/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': contentType },
        body: mpBody,
      });
      if (!uploadRes.ok) {
        const t = await uploadRes.text().catch(() => '');
        return res.status(200).json({ ok: false, platform, error: `Issuu upload failed: ${uploadRes.status} ${t.slice(0, 100)}` });
      }

      const pubRes = await fetch(`https://api.issuu.com/v2/drafts/${draft.slug}/publish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ desiredName: draft.slug }),
      });
      const pub    = await pubRes.json().catch(() => ({}));
      const pubUrl = pub.publicUrl || pub.link || `https://issuu.com/publication/${draft.slug}`;
      return res.status(200).json({ ok: true, platform, method: 'api_v2', url: pubUrl });
    }

    // ── Custom platform ──────────────────────────────────────────────────────
    if (platform === 'custom') {
      if (!customUrl)
        return res.status(400).json({ ok: false, error: 'custom platform requires uploadUrl', platform });

      const cfg = {
        uploadUrl: customUrl,
        fileField: customField || 'file',
        domain: new URL(customUrl).hostname,
        extraFields: (t, d, k) => ({ title: t, description: d, tags: k }),
      };
      const fields = cfg.extraFields(title, description, tags);
      const { body: mpBody, contentType } = buildMultipart(fields, cfg.fileField, filename, pdfBuf);
      const upRes = await fetch(cfg.uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': contentType, 'User-Agent': 'Mozilla/5.0', Accept: '*/*', ...(cookie ? { Cookie: cookie } : {}) },
        body: mpBody,
        redirect: 'follow',
      });
      const resText = await upRes.text().catch(() => '');
      const foundUrl = extractUploadUrl(resText, cfg.domain) || (upRes.redirected ? upRes.url : null);
      return res.status(200).json({ ok: upRes.ok || upRes.status < 400, platform, method: 'form_post', url: foundUrl || cfg.uploadUrl, note: foundUrl ? undefined : 'Uploaded — check dashboard for live URL' });
    }

    // ── Known platforms (cookie-based form POST) ─────────────────────────────
    const cfg = PDF_PLATFORMS[platform];
    if (!cfg)
      return res.status(400).json({ ok: false, error: `Unknown platform: ${platform}`, platform });

    if (!cookie) {
      return res.status(400).json({
        ok: false, platform,
        error: `${platform} requires a session cookie. Log in at ${cfg.loginUrl} and copy your cookie from DevTools → Application → Cookies.`,
        loginUrl: cfg.loginUrl,
        manual: true,
      });
    }

    const fields = cfg.extraFields ? cfg.extraFields(title, description, tags) : { title };
    const { body: mpBody, contentType } = buildMultipart(fields, cfg.fileField || 'file', filename, pdfBuf);
    const upRes = await fetch(cfg.uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: '*/*', Cookie: cookie },
      body: mpBody,
      redirect: 'follow',
    });
    const resText = await upRes.text().catch(() => '');
    const foundUrl = extractUploadUrl(resText, cfg.domain)
                  || (upRes.redirected ? upRes.url : null)
                  || upRes.headers.get('location');

    if (upRes.ok || upRes.status < 400) {
      return res.status(200).json({ ok: true, platform, method: 'form_post', url: foundUrl || cfg.uploadUrl, note: foundUrl ? undefined : 'Uploaded — check dashboard for live URL' });
    }
    return res.status(200).json({ ok: false, platform, error: `Upload failed ${upRes.status}: ${resText.slice(0, 120)}`, manual: true });

  } catch (err) {
    console.error(`[proxy/pdf-upload] ${platform}:`, err.message);
    return res.status(200).json({ ok: false, platform, error: err.message, manual: true });
  }
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  // Parse request — GET uses query params, POST uses JSON body
  let url, method, reqHeaders, reqBody, incomingCookies, timeoutMs, returnCookies, maxBodyBytes;

  if (req.method === 'GET') {
    url             = req.query.url || '';
    method          = 'GET';
    reqHeaders      = {};
    reqBody         = null;
    incomingCookies = req.query.cookies || '';
    // GET params: assume seconds for back-compat
    timeoutMs       = (parseInt(req.query.timeout) || 30) * 1000;
    returnCookies   = true;
    maxBodyBytes    = DEFAULT_MAX_BODY_BYTES;
  } else {
    let body = {};
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
    // ── PDF Upload mode ──────────────────────────────────────────────────────
    if (body.mode === 'pdf-upload') return handlePdfUpload(body, res);

    url             = body.url;
    method          = body.method || 'GET';
    reqHeaders      = body.headers || {};
    reqBody         = body.body || null;
    incomingCookies = body.cookies || '';
    returnCookies   = body.returnCookies !== undefined ? body.returnCookies : true;
    maxBodyBytes    = body.maxBodyBytes || DEFAULT_MAX_BODY_BYTES;

    // ── Timeout: auto-detect ms vs seconds ──────────────────────────────────
    // New scanner sends ms (e.g. 15000). Old callers sent seconds (e.g. 30).
    // Heuristic: if value > 300, treat as ms; otherwise multiply by 1000.
    const rawTimeout = body.timeout;
    if (rawTimeout == null) {
      timeoutMs = 30000;
    } else if (rawTimeout > 300) {
      timeoutMs = rawTimeout; // already milliseconds
    } else {
      timeoutMs = rawTimeout * 1000; // seconds → ms
    }
    // Hard cap: Vercel maxDuration is 60s, leave 5s buffer for response write
    timeoutMs = Math.min(timeoutMs, 55000);
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

  // ── Build fetch headers ───────────────────────────────────────────────────
  // Use browser-realistic defaults for GET (HTML fetches), merge caller overrides.
  const isHtmlFetch = method.toUpperCase() === 'GET' && !reqHeaders['Content-Type'];
  const baseHeaders = isHtmlFetch
    ? browserHeaders(reqHeaders['User-Agent'], incomingCookies)
    : {
        'User-Agent': reqHeaders['User-Agent'] || randomUA(),
        'Accept':     reqHeaders['Accept'] || '*/*',
        ...(incomingCookies ? { Cookie: incomingCookies } : {}),
      };

  const fetchHeaders = { ...baseHeaders, ...reqHeaders };

  // Remove hop-by-hop / problematic headers
  for (const h of ['host', 'Host', 'origin', 'Origin', 'connection', 'Connection', 'content-length', 'Content-Length']) {
    delete fetchHeaders[h];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let fetchResponse;
  const redirectHistory = [];

  try {
    let currentUrl         = url;
    let accumulatedCookies = incomingCookies;
    let currentMethod      = method.toUpperCase();
    let currentBody        = reqBody;
    let redirectCount      = 0;

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

      // Accumulate Set-Cookie headers across redirect chain
      if (returnCookies) {
        const setCookies = [];
        fetchResponse.headers.forEach((value, key) => {
          if (key.toLowerCase() === 'set-cookie') setCookies.push(value);
        });
        if (setCookies.length) {
          accumulatedCookies = mergeCookies(accumulatedCookies, setCookies);
        }
      }

      // Follow redirects manually — captures every Set-Cookie in the chain
      if ([301, 302, 303, 307, 308].includes(fetchResponse.status)) {
        const location = fetchResponse.headers.get('location');
        if (!location) break;
        redirectHistory.push(currentUrl);
        currentUrl = location.startsWith('http') ? location : new URL(location, currentUrl).href;
        // 303 and POST→301/302 always become GET with no body (browser convention)
        if (fetchResponse.status === 303 || ([301, 302].includes(fetchResponse.status) && currentMethod === 'POST')) {
          currentMethod = 'GET';
          currentBody   = null;
        }
        redirectCount++;
        continue;
      }
      break; // non-redirect → done
    }

    clearTimeout(timer);

    // ── Read response body with size cap ─────────────────────────────────────
    // Prevents Vercel 4.5MB response limit crashes on large JS bundles / pages.
    let responseText = '';
    let truncated    = false;
    try {
      const buf = await fetchResponse.arrayBuffer();
      const full = Buffer.from(buf);
      if (full.length > maxBodyBytes) {
        responseText = full.slice(0, maxBodyBytes).toString('utf-8');
        truncated    = true;
      } else {
        responseText = full.toString('utf-8');
      }
    } catch (_) {
      responseText = '';
    }

    // Try to parse as JSON (for API responses) — stored separately
    let responseJson = null;
    try { responseJson = JSON.parse(responseText); } catch (_) {}

    // Collect final Set-Cookie
    const finalSetCookies = [];
    fetchResponse.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'set-cookie') finalSetCookies.push(value);
    });
    const allCookies = returnCookies ? mergeCookies(incomingCookies, finalSetCookies) : '';

    const upstreamStatus = fetchResponse.status;
    const wasRedirected  = redirectHistory.length > 0;

    return res.status(200).json({
      ok:          fetchResponse.ok,
      status:      upstreamStatus,
      status_code: upstreamStatus,   // ← all frontend paths read status_code
      redirected:  wasRedirected,
      // ── BODY FIELDS ──────────────────────────────────────────────────────
      // `text` and `body` are BOTH the raw response string.
      // This is the key fix: scanner reads r.body and expects raw HTML, not
      // a parsed JSON object. `bodyJson` holds the parsed JSON when available.
      text:        responseText,
      body:        responseText,     // ← RAW STRING (was parsed JSON in v1 — FIXED)
      bodyJson:    responseJson,     // ← parsed JSON if applicable, else null
      // ─────────────────────────────────────────────────────────────────────
      cookies:     allCookies,
      finalUrl:    currentUrl,
      redirects:   redirectHistory,
      truncated,
    });

  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err.name === 'AbortError';
    return res.status(502).json({
      ok:          false,
      status:      502,
      status_code: 502,
      error:       isTimeout ? `Request timed out after ${timeoutMs}ms` : err.message,
      text:        '',
      body:        '',
      bodyJson:    null,
      url,
    });
  }
}
