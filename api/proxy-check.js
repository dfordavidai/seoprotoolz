/**
 * /api/proxy-check
 *
 * Tests whether a given HTTP/HTTPS proxy is alive and usable by routing a
 * real test request THROUGH the proxy using Node's http/https + tunnel.
 *
 * POST body:
 *   { proxy: "http://1.2.3.4:8080", target: "https://api.ipify.org?format=json" }
 *
 * Response:
 *   200 { ok: true,  status: 200, ms: 423, ip: "1.2.3.4" }
 *   200 { ok: false, error: "ECONNREFUSED" }
 *
 * Auth: same X-API-Key / x-secret header as all other endpoints.
 */

const http  = require('http');
const https = require('https');
const { URL } = require('url');

// ── inline auth (mirrors lib/auth.js pattern) ──────────────────────────────
function checkAuth(req) {
  const secret = process.env.API_SECRET_KEY;
  if (!secret) return true; // dev mode — open
  const key = req.headers['x-api-key'] || req.headers['x-secret'] || '';
  return key === secret;
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, x-secret');
}

// ── Read POST body ─────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 4096) reject(new Error('Body too large')); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch(e) { resolve({}); } });
    req.on('error', reject);
  });
}

// ── Block private / loopback IPs ──────────────────────────────────────────
function isPrivateIp(host) {
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|localhost|::1)/i.test(host);
}

// ── Tunnel CONNECT through an HTTP proxy, then fetch target ───────────────
function proxyFetch({ proxyHost, proxyPort, targetUrl, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const targetHost = parsed.hostname;
    const targetPort = parsed.port || (isHttps ? '443' : '80');

    const start = Date.now();

    // Step 1: CONNECT tunnel through the proxy
    const tunnel = http.request({
      host:    proxyHost,
      port:    proxyPort,
      method:  'CONNECT',
      path:    `${targetHost}:${targetPort}`,
      headers: { Host: `${targetHost}:${targetPort}` },
      timeout: timeoutMs,
    });

    tunnel.on('error', err => reject(err));
    tunnel.on('timeout', () => { tunnel.destroy(); reject(new Error('CONNECT timeout')); });

    tunnel.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
      }

      // Step 2: make the real request over the tunnel socket
      const lib = isHttps ? https : http;
      const req = lib.request({
        host:     targetHost,
        port:     parseInt(targetPort, 10),
        path:     parsed.pathname + parsed.search,
        method:   'GET',
        socket,
        agent:    false,
        timeout:  timeoutMs,
        headers: {
          Host:         targetHost,
          'User-Agent': 'Mozilla/5.0 (compatible; SEO-Proxy-Check/1.0)',
          Accept:       '*/*',
        },
      }, (response) => {
        let body = '';
        response.on('data', chunk => { body += chunk; if (body.length > 8192) response.destroy(); });
        response.on('end', () => {
          resolve({
            ok:     response.statusCode < 400,
            status: response.statusCode,
            ms:     Date.now() - start,
            body:   body.slice(0, 256),
          });
        });
        response.on('error', reject);
      });

      req.on('error', err => reject(err));
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.end();
    });

    tunnel.end();
  });
}

// ── Main handler ──────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  cors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!checkAuth(req)) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  let body;
  try { body = await readBody(req); }
  catch(e) { return res.status(400).json({ ok: false, error: 'Bad body' }); }

  const { proxy, target } = body;

  if (!proxy || !target) {
    return res.status(400).json({ ok: false, error: 'proxy and target are required' });
  }

  // Parse proxy URL  e.g. http://1.2.3.4:8080 or socks5://... (SOCKS not supported natively)
  let proxyParsed;
  try {
    proxyParsed = new URL(proxy.startsWith('http') ? proxy : 'http://' + proxy);
  } catch(e) {
    return res.status(400).json({ ok: false, error: 'Invalid proxy URL' });
  }

  const proxyHost = proxyParsed.hostname;
  const proxyPort = parseInt(proxyParsed.port || '8080', 10);
  const protocol  = proxyParsed.protocol.replace(':', '');

  // Block private IPs
  if (isPrivateIp(proxyHost)) {
    return res.status(400).json({ ok: false, error: 'Private IP not allowed' });
  }

  // SOCKS proxies: not supported natively in Node without extra deps — return honest error
  if (protocol.startsWith('socks')) {
    return res.status(200).json({
      ok:    false,
      error: 'SOCKS proxy testing not supported by this endpoint (HTTP/HTTPS only)',
      ms:    0,
    });
  }

  // Test targets in priority order
  const targets = target
    ? [target]
    : [
        'https://api.ipify.org?format=json',
        'https://httpbin.org/ip',
        'https://ipecho.net/plain',
      ];

  for (const t of targets) {
    try {
      const result = await proxyFetch({ proxyHost, proxyPort, targetUrl: t, timeoutMs: 10000 });
      // Try to extract the returned IP from the response body
      let detectedIp = null;
      try {
        const j = JSON.parse(result.body);
        detectedIp = j.ip || j.origin || null;
      } catch(_) {
        const m = (result.body || '').match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
        if (m) detectedIp = m[1];
      }
      return res.status(200).json({
        ok:    result.ok,
        status: result.status,
        ms:    result.ms,
        ip:    detectedIp,
        proxy: proxyHost + ':' + proxyPort,
      });
    } catch(e) {
      // Try next target
    }
  }

  // All targets failed
  return res.status(200).json({ ok: false, error: 'All test targets failed', ms: 0 });
};
