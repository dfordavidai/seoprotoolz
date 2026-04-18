// api/proxy.js — Universal CORS-safe HTTP proxy v3.0
//
// Frontend (bcProxyFetch / smartFetch) sends:
//   POST { url, method, headers, body, timeout, cookies, returnCookies }
//   GET  ?url=<encoded>&cookies=<cookie-string>
//
// Returns: { ok, status, status_code, text, body, redirected, finalUrl, proxy, cookies }
//   cookies — flattened Set-Cookie values for threading between stateful requests
//
// Cookie threading pattern (Django CSRF — rentry, dpaste, etc):
//   Step 1: POST { url:"https://rentry.co/", returnCookies:true }
//            → { cookies:"csrftoken=abc123", text:"<html>...csrfmiddlewaretoken...value=\"abc123\"..." }
//   Step 2: POST { url:"https://rentry.co/api/new", cookies:"csrftoken=abc123",
//                  headers:{"X-CSRFToken":"abc123","Referer":"https://rentry.co/"},
//                  body:"csrfmiddlewaretoken=abc123&text=..." }

import { handleCors, checkAuth } from '../lib/auth.js';
import http from 'http';
import https from 'https';

export const config = { maxDuration: 60 };

function isBlockedHost(hostname) {
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|localhost|::1$)/i.test(hostname);
}

// Extract all Set-Cookie values from a Response into a flat "name=value; name=value" string
function extractCookies(response) {
  try {
    const setCookieHeaders = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie') || ''].filter(Boolean);

    if (!setCookieHeaders || setCookieHeaders.length === 0) return '';

    return setCookieHeaders
      .map(h => h.split(';')[0].trim())   // name=value only, strip path/domain/expires
      .filter(Boolean)
      .join('; ');
  } catch (_) {
    return '';
  }
}

export default async function handler(req, res) {
  // Route proxy-test requests (from /api/proxy-test redirect in vercel.json)
  if (req.query?._mode === 'proxytest') return handleProxyTest(req, res);

  if (handleCors(req, res)) return;
  if (!checkAuth(req, res))  return;

  let targetUrl, method, reqHeaders, reqBody, timeoutSec, incomingCookies, returnCookies;

  if (req.method === 'POST') {
    const b         = req.body || {};
    targetUrl       = b.url;
    method          = (b.method || 'GET').toUpperCase();
    reqHeaders      = b.headers || {};
    timeoutSec      = Number(b.timeout || b.sfTimeout) || 55;
    incomingCookies = b.cookies || '';
    returnCookies   = b.returnCookies !== false; // default true

    if (b.body !== undefined && b.body !== null) {
      reqBody = typeof b.body === 'string' ? b.body : b.body;
    } else {
      reqBody = null;
    }
  } else if (req.method === 'GET') {
    targetUrl       = req.query?.url;
    method          = 'GET';
    reqHeaders      = {};
    reqBody         = null;
    timeoutSec      = 55;
    incomingCookies = req.query?.cookies || '';
    returnCookies   = true;
  } else {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (!targetUrl) {
    return res.status(400).json({ ok: false, error: 'Missing required field: url' });
  }

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

  // Build merged headers — thread cookies from request body into Cookie header
  const mergedHeaders = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    ...reqHeaders,
  };

  // Merge incoming cookie string with any Cookie header from reqHeaders
  const existingCookieHeader = mergedHeaders['Cookie'] || mergedHeaders['cookie'] || '';
  const allCookies = [existingCookieHeader, incomingCookies].filter(Boolean).join('; ').trim();
  if (allCookies) {
    mergedHeaders['Cookie'] = allCookies;
    delete mergedHeaders['cookie'];
  }

  const fetchOpts = {
    method,
    headers: mergedHeaders,
    redirect: 'follow',
    signal:   AbortSignal.timeout(timeoutSec * 1000),
  };

  if (reqBody !== null && !['GET', 'HEAD'].includes(method)) {
    fetchOpts.body = typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody);
    if (!fetchOpts.headers['Content-Type'] && !fetchOpts.headers['content-type'] && typeof reqBody === 'object') {
      fetchOpts.headers['Content-Type'] = 'application/json';
    }
  }

  try {
    const upstream = await fetch(targetUrl, fetchOpts);
    const text     = await upstream.text();
    const status   = upstream.status;

    const responseCookies = returnCookies ? extractCookies(upstream) : '';

    let json = null;
    try { json = JSON.parse(text); } catch (_) {}

    return res.status(200).json({
      ok:          upstream.ok,
      status,
      status_code: status,
      text,
      body:        json || text,
      redirected:  upstream.redirected,
      finalUrl:    upstream.url,
      proxy:       'vercel',
      cookies:     responseCookies,
    });
  } catch (err) {
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    return res.status(502).json({
      ok:          false,
      status:      isTimeout ? 504 : 502,
      status_code: isTimeout ? 504 : 502,
      text:        '',
      body:        null,
      cookies:     '',
      error:       isTimeout ? `Request timed out after ${timeoutSec}s` : err.message,
      proxy:       'vercel',
    });
  }
}

// ── PROXY-TEST MODE (replaces api/proxy-test.js) ────────────────────────────
// Handles requests routed from /api/proxy-test via vercel.json rewrite

function isPrivateIp(host) {
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|localhost|::1)/i.test(host);
}

function proxyFetch({ proxyHost, proxyPort, targetUrl, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const parsed     = new URL(targetUrl);
    const isHttps    = parsed.protocol === 'https:';
    const targetHost = parsed.hostname;
    const targetPort = parsed.port || (isHttps ? '443' : '80');
    const start      = Date.now();
    const tunnel = http.request({
      host: proxyHost, port: proxyPort, method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: { Host: `${targetHost}:${targetPort}` }, timeout: timeoutMs,
    });
    tunnel.on('error', err => reject(err));
    tunnel.on('timeout', () => { tunnel.destroy(); reject(new Error('CONNECT timeout')); });
    tunnel.on('connect', (connRes, socket) => {
      if (connRes.statusCode !== 200) { socket.destroy(); return reject(new Error(`Proxy CONNECT failed: ${connRes.statusCode}`)); }
      const lib = isHttps ? https : http;
      const innerReq = lib.request({
        host: targetHost, port: parseInt(targetPort, 10),
        path: parsed.pathname + parsed.search, method: 'GET', socket, agent: false, timeout: timeoutMs,
        headers: { Host: targetHost, 'User-Agent': 'Mozilla/5.0 (compatible; SEO-Proxy-Check/2.0)', Accept: '*/*' },
      }, (response) => {
        let body = '';
        response.on('data', chunk => { body += chunk; if (body.length > 8192) response.destroy(); });
        response.on('end', () => resolve({ ok: response.statusCode < 400, status: response.statusCode, ms: Date.now() - start, body: body.slice(0, 512) }));
        response.on('error', reject);
      });
      innerReq.on('error', err => reject(err));
      innerReq.on('timeout', () => { innerReq.destroy(); reject(new Error('Request timeout')); });
      innerReq.end();
    });
    tunnel.end();
  });
}

export async function handleProxyTest(req, res) {
  if (handleCors(req, res)) return;
  if (!checkAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
  const { proxy, url: target } = req.body || {};
  if (!proxy) return res.status(400).json({ ok: false, error: 'proxy is required' });
  let proxyParsed;
  try { proxyParsed = new URL(proxy.startsWith('http') ? proxy : 'http://' + proxy); }
  catch (e) { return res.status(400).json({ ok: false, error: 'Invalid proxy URL' }); }
  const proxyHost = proxyParsed.hostname;
  const proxyPort = parseInt(proxyParsed.port || '8080', 10);
  const protocol  = proxyParsed.protocol.replace(':', '');
  if (isPrivateIp(proxyHost)) return res.status(400).json({ ok: false, error: 'Private/loopback IP not allowed' });
  if (protocol.startsWith('socks')) return res.status(200).json({ ok: false, error: 'SOCKS proxy not supported', ms: 0 });
  const targets = target ? [target] : ['https://api.ipify.org?format=json', 'https://httpbin.org/ip'];
  for (const t of targets) {
    try {
      const result = await proxyFetch({ proxyHost, proxyPort, targetUrl: t, timeoutMs: 10000 });
      let detectedIp = null;
      try { const j = JSON.parse(result.body); detectedIp = j.ip || j.origin || null; } catch (_) {
        const m = (result.body || '').match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/); if (m) detectedIp = m[1];
      }
      return res.status(200).json({ ok: result.ok, status: result.status, ms: result.ms, ip: detectedIp, proxy: `${proxyHost}:${proxyPort}` });
    } catch (e) {}
  }
  return res.status(200).json({ ok: false, error: 'All test targets failed', ms: 0 });
}
