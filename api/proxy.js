// api/proxy.js — CORS-safe proxy for all outbound HTTP requests
// Receives: POST { url, method, headers, body, timeout }
//           GET  ?url=<encoded>
// Returns:  { ok, status, text, redirected, proxy:'vercel' }

import { handleCors, checkAuth } from '../lib/auth.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!checkAuth(req, res)) return;

  // ── Parse request ─────────────────────────────────────────────────────────
  let targetUrl, method, reqHeaders, reqBody, timeoutSec;

  if (req.method === 'POST') {
    const b = req.body || {};
    targetUrl   = b.url;
    method      = (b.method  || 'GET').toUpperCase();
    reqHeaders  = b.headers  || {};
    // Accept body as object OR pre-serialized JSON string — normalize to object
    if (b.body && typeof b.body === 'string') {
      try { reqBody = JSON.parse(b.body); } catch (_) { reqBody = b.body; }
    } else {
      reqBody = b.body || null;
    }
    timeoutSec  = Number(b.timeout) || 55;
  } else if (req.method === 'GET') {
    targetUrl   = req.query?.url;
    method      = 'GET';
    reqHeaders  = {};
    reqBody     = null;
    timeoutSec  = 55;
  } else {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing required field: url' });
  }

  // Validate URL
  let parsed;
  try { parsed = new URL(targetUrl); } catch (e) {
    return res.status(400).json({ error: 'Invalid URL: ' + targetUrl });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'Only http/https protocols are allowed' });
  }

  // ── Build fetch options ───────────────────────────────────────────────────
  const fetchOpts = {
    method,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...reqHeaders,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutSec * 1000),
  };

  if (reqBody && !['GET', 'HEAD'].includes(method)) {
    fetchOpts.body = typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody);
  }

  // ── Execute proxy request ─────────────────────────────────────────────────
  try {
    const upstream = await fetch(targetUrl, fetchOpts);
    const text = await upstream.text();

    return res.status(200).json({
      ok:        upstream.ok,
      status:    upstream.status,
      text,
      redirected: upstream.redirected,
      finalUrl:   upstream.url,
      proxy:     'vercel',
    });
  } catch (err) {
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    return res.status(502).json({
      ok:      false,
      status:  isTimeout ? 504 : 502,
      text:    '',
      error:   isTimeout ? `Request timed out after ${timeoutSec}s` : err.message,
      proxy:  'vercel',
    });
  }
}
