// api/proxy.js — Universal CORS-safe HTTP proxy
//
// Frontend (smartFetch) sends:
//   POST { url, method, headers, body, timeout }
//   GET  ?url=<encoded>
//
// Returns: { ok, status, status_code, text, body, redirected, finalUrl, proxy }
// Note: "status_code" alias included so both old and new frontend code works.

import { handleCors, checkAuth } from '../lib/auth.js';

export const config = { maxDuration: 60 };

// Private/loopback IP guard
function isBlockedHost(hostname) {
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|localhost|::1$)/i.test(hostname);
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!checkAuth(req, res))  return;

  let targetUrl, method, reqHeaders, reqBody, timeoutSec;

  if (req.method === 'POST') {
    const b        = req.body || {};
    targetUrl      = b.url;
    method         = (b.method  || 'GET').toUpperCase();
    reqHeaders     = b.headers  || {};
    timeoutSec     = Number(b.timeout || b.sfTimeout) || 55;

    // Accept body as: string, object, or null
    if (b.body !== undefined && b.body !== null) {
      if (typeof b.body === 'string') {
        try { reqBody = b.body; } catch (_) { reqBody = b.body; }
      } else {
        reqBody = b.body;
      }
    } else {
      reqBody = null;
    }
  } else if (req.method === 'GET') {
    targetUrl  = req.query?.url;
    method     = 'GET';
    reqHeaders = {};
    reqBody    = null;
    timeoutSec = 55;
  } else {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (!targetUrl) {
    return res.status(400).json({ ok: false, error: 'Missing required field: url' });
  }

  // Validate URL
  let parsed;
  try { parsed = new URL(targetUrl); } catch (e) {
    return res.status(400).json({ ok: false, error: 'Invalid URL: ' + targetUrl });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ ok: false, error: 'Only http/https protocols allowed' });
  }
  if (isBlockedHost(parsed.hostname)) {
    return res.status(400).json({ ok: false, error: 'Requests to private/loopback addresses are blocked' });
  }

  // Build fetch options
  const fetchOpts = {
    method,
    headers: {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...reqHeaders,
    },
    redirect: 'follow',
    signal:   AbortSignal.timeout(timeoutSec * 1000),
  };

  if (reqBody !== null && !['GET', 'HEAD'].includes(method)) {
    fetchOpts.body = typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody);
    // If content-type not set and body is object, default to JSON
    if (!fetchOpts.headers['Content-Type'] && !fetchOpts.headers['content-type'] && typeof reqBody === 'object') {
      fetchOpts.headers['Content-Type'] = 'application/json';
    }
  }

  try {
    const upstream  = await fetch(targetUrl, fetchOpts);
    const text      = await upstream.text();
    const status    = upstream.status;

    // Try to parse JSON so callers can do d.json directly
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}

    return res.status(200).json({
      ok:          upstream.ok,
      status,
      status_code: status,      // alias for legacy frontend code
      text,
      body:        json || text, // parsed JSON when available
      redirected:  upstream.redirected,
      finalUrl:    upstream.url,
      proxy:       'vercel',
    });
  } catch (err) {
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    return res.status(502).json({
      ok:          false,
      status:      isTimeout ? 504 : 502,
      status_code: isTimeout ? 504 : 502,
      text:        '',
      body:        null,
      error:       isTimeout ? `Request timed out after ${timeoutSec}s` : err.message,
      proxy:       'vercel',
    });
  }
}
