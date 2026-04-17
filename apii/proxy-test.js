// api/proxy-test.js — Test whether an HTTP/HTTPS proxy is alive
//
// Frontend calls: POST { proxy: "http://ip:port", url: "https://api.ipify.org?format=json" }
// Returns: { ok, status, ms, ip, proxy }
//
// Mirrors api/proxy-check.js but uses ESM + shared auth helper to match
// the rest of the codebase. The frontend (Proxy Manager) calls /api/proxy-test
// with x-secret header.

import { handleCors, checkAuth } from '../lib/auth.js';
import http  from 'http';
import https from 'https';
import { URL } from 'url';

export const config = { maxDuration: 20 };

// Block private / loopback IPs
function isPrivateIp(host) {
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|localhost|::1)/i.test(host);
}

// Tunnel CONNECT through an HTTP proxy then fetch the target
function proxyFetch({ proxyHost, proxyPort, targetUrl, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const parsed     = new URL(targetUrl);
    const isHttps    = parsed.protocol === 'https:';
    const targetHost = parsed.hostname;
    const targetPort = parsed.port || (isHttps ? '443' : '80');
    const start      = Date.now();

    const tunnel = http.request({
      host:    proxyHost,
      port:    proxyPort,
      method:  'CONNECT',
      path:    `${targetHost}:${targetPort}`,
      headers: { Host: `${targetHost}:${targetPort}` },
      timeout: timeoutMs,
    });

    tunnel.on('error',   err => reject(err));
    tunnel.on('timeout', ()  => { tunnel.destroy(); reject(new Error('CONNECT timeout')); });

    tunnel.on('connect', (connRes, socket) => {
      if (connRes.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`Proxy CONNECT failed: ${connRes.statusCode}`));
      }

      const lib = isHttps ? https : http;
      const innerReq = lib.request({
        host:    targetHost,
        port:    parseInt(targetPort, 10),
        path:    parsed.pathname + parsed.search,
        method:  'GET',
        socket,
        agent:   false,
        timeout: timeoutMs,
        headers: {
          Host:         targetHost,
          'User-Agent': 'Mozilla/5.0 (compatible; SEO-Proxy-Check/2.0)',
          Accept:       '*/*',
        },
      }, (response) => {
        let body = '';
        response.on('data', chunk => { body += chunk; if (body.length > 8192) response.destroy(); });
        response.on('end',  ()    => resolve({ ok: response.statusCode < 400, status: response.statusCode, ms: Date.now() - start, body: body.slice(0, 512) }));
        response.on('error', reject);
      });

      innerReq.on('error',   err => reject(err));
      innerReq.on('timeout', ()  => { innerReq.destroy(); reject(new Error('Request timeout')); });
      innerReq.end();
    });

    tunnel.end();
  });
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!checkAuth(req, res))  return;
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });

  const { proxy, url: target } = req.body || {};

  if (!proxy) return res.status(400).json({ ok: false, error: 'proxy is required' });

  // Parse proxy URL
  let proxyParsed;
  try {
    proxyParsed = new URL(proxy.startsWith('http') ? proxy : 'http://' + proxy);
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'Invalid proxy URL' });
  }

  const proxyHost = proxyParsed.hostname;
  const proxyPort = parseInt(proxyParsed.port || '8080', 10);
  const protocol  = proxyParsed.protocol.replace(':', '');

  if (isPrivateIp(proxyHost)) {
    return res.status(400).json({ ok: false, error: 'Private/loopback IP not allowed' });
  }

  if (protocol.startsWith('socks')) {
    return res.status(200).json({ ok: false, error: 'SOCKS proxy testing not supported (HTTP/HTTPS only)', ms: 0 });
  }

  // Test target priority
  const targets = target
    ? [target]
    : ['https://api.ipify.org?format=json', 'https://httpbin.org/ip', 'https://ipecho.net/plain'];

  for (const t of targets) {
    try {
      const result = await proxyFetch({ proxyHost, proxyPort, targetUrl: t, timeoutMs: 10000 });

      let detectedIp = null;
      try {
        const j = JSON.parse(result.body);
        detectedIp = j.ip || j.origin || null;
      } catch (_) {
        const m = (result.body || '').match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
        if (m) detectedIp = m[1];
      }

      return res.status(200).json({
        ok:     result.ok,
        status: result.status,
        ms:     result.ms,
        ip:     detectedIp,
        proxy:  `${proxyHost}:${proxyPort}`,
      });
    } catch (e) {
      // try next target
    }
  }

  return res.status(200).json({ ok: false, error: 'All test targets failed or proxy unreachable', ms: 0 });
}
