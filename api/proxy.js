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

      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
      const identifier = slug + '-' + Date.now().toString(36);
      const uploadUrl  = `https://s3.us.archive.org/${identifier}/${encodeURIComponent(filename)}`;

      const archiveRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          Authorization: `LOW ${accessKey}:${secretKey}`,
          'Content-Type': 'application/pdf',
          'x-archive-meta-title': title,
          'x-archive-meta-subject': keyword || title,
          'x-archive-meta-mediatype': 'texts',
          'x-archive-meta-language': 'en',
          'x-archive-auto-make-bucket': '1',
          'Content-Length': String(pdfBuf.length),
        },
        body: pdfBuf,
      });

      if (archiveRes.ok || archiveRes.status === 200) {
        return res.status(200).json({ ok: true, platform, method: 's3_api', url: `https://archive.org/details/${identifier}` });
      }
      const errText = await archiveRes.text().catch(() => archiveRes.statusText);
      return res.status(200).json({ ok: false, platform, error: `Archive.org error ${archiveRes.status}: ${errText.slice(0, 120)}` });
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
    // ── PDF Upload mode ──────────────────────────────────────────────────────
    if (body.mode === 'pdf-upload') return handlePdfUpload(body, res);

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
