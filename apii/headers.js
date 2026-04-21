// api/headers.js — Fetch and return HTTP response headers for any URL
// POST { url } → { ok, status, headers: {}, server, contentType, ... }
// GET  ?url=<encoded> → same

import { handleCors, checkAuth } from '../lib/auth.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!checkAuth(req, res)) return;

  const url = req.method === 'POST'
    ? req.body?.url
    : req.query?.url;

  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  try {
    new URL(url); // validate
  } catch (e) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    const upstream = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SEOBot/2.0)',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });

    // Convert Headers object to plain object
    const headers = {};
    upstream.headers.forEach((value, key) => { headers[key] = value; });

    return res.status(200).json({
      ok:          upstream.ok,
      status:      upstream.status,
      statusText:  upstream.statusText,
      finalUrl:    upstream.url,
      redirected:  upstream.redirected,
      headers,
      server:      headers['server']        || null,
      contentType: headers['content-type']  || null,
      poweredBy:   headers['x-powered-by'] || null,
      cacheControl:headers['cache-control'] || null,
    });
  } catch (err) {
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    return res.status(502).json({
      ok:    false,
      error: isTimeout ? 'Request timed out' : err.message,
    });
  }
}
