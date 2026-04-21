// api/ping.js — URL pinging + IndexNow submission
//
// Frontend calls this for:
//   - autoSubmitToIndexers() after each successful publish
//   - Manual "Submit to Indexers" in the Indexing Suite module
//
// POST {
//   urls:          string[]   — URLs to ping/submit
//   pingGoogle?:   bool       — ping Google sitemap endpoint  (default true)
//   pingBing?:     bool       — ping Bing sitemap endpoint    (default true)
//   pingIndexNow?: bool       — submit via IndexNow           (default false unless key present)
//   indexNowKey?:  string     — IndexNow key (falls back to env INDEXNOW_KEY)
//   siteUrl?:      string     — sitemap URL for Google/Bing ping
// }
// Returns: { ok, total, success, results[] }

import { handleCors, checkAuth } from '../lib/auth.js';

export const config = { maxDuration: 60 };

const TIMEOUT = 10000;

// ── Google sitemap ping ───────────────────────────────────────────────────────
async function pingGoogle(url) {
  try {
    const pingUrl = `https://www.google.com/ping?sitemap=${encodeURIComponent(url)}`;
    const r = await fetch(pingUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(TIMEOUT),
    });
    return { ok: r.ok || r.status === 200, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Bing sitemap + IndexNow ping ─────────────────────────────────────────────
async function pingBingSitemap(url) {
  try {
    const pingUrl = `https://www.bing.com/ping?sitemap=${encodeURIComponent(url)}`;
    const r = await fetch(pingUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(TIMEOUT),
    });
    return { ok: r.ok || r.status === 200, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Bing Webmaster API submission ─────────────────────────────────────────────
async function pingBingWebmaster(url) {
  const bingKey = process.env.BING_WEBMASTER_KEY;
  if (!bingKey) return { ok: false, skipped: true, error: 'BING_WEBMASTER_KEY not set' };
  try {
    const r = await fetch('https://ssl.bing.com/webmaster/api.svc/json/SubmitUrl?apikey=' + bingKey, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body:    JSON.stringify({ siteUrl: url, url }),
      signal:  AbortSignal.timeout(TIMEOUT),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── IndexNow (Bing + Yandex + Seznam) ────────────────────────────────────────
async function submitIndexNow(url, key) {
  let host;
  try { host = new URL(url).hostname; } catch { return { ok: false, error: 'Invalid URL' }; }

  try {
    const r = await fetch('https://api.indexnow.org/indexnow', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body:    JSON.stringify({
        host,
        key,
        keyLocation: `https://${host}/${key}.txt`,
        urlList:     [url],
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    return { ok: r.status === 200 || r.status === 202, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Batch IndexNow (more efficient for many URLs on same host) ────────────────
async function batchIndexNow(urls, key) {
  if (!urls.length || !key) return { ok: false, error: 'No URLs or key' };

  // Group by host
  const byHost = {};
  for (const url of urls) {
    try {
      const { hostname } = new URL(url);
      if (!byHost[hostname]) byHost[hostname] = [];
      byHost[hostname].push(url);
    } catch (_) {}
  }

  const results = [];
  for (const [host, hostUrls] of Object.entries(byHost)) {
    try {
      const r = await fetch('https://api.indexnow.org/indexnow', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body:    JSON.stringify({
          host,
          key,
          keyLocation: `https://${host}/${key}.txt`,
          urlList:     hostUrls,
        }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      results.push({ host, ok: r.status === 200 || r.status === 202, status: r.status, count: hostUrls.length });
    } catch (e) {
      results.push({ host, ok: false, error: e.message, count: hostUrls.length });
    }
  }
  return { ok: results.some(r => r.ok), results };
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!checkAuth(req, res))  return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const {
    urls          = [],
    pingGoogle:   doGoogle   = true,
    pingBing:     doBing     = true,
    pingIndexNow: doIndexNow = false,
    indexNowKey               = process.env.INDEXNOW_KEY || null,
    siteUrl                   = null,
    batch                     = false,  // if true: batch IndexNow by host
  } = req.body || {};

  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls must be a non-empty array' });
  }

  // Batch mode: submit all URLs at once via IndexNow, plus Google/Bing pings
  if (batch && indexNowKey) {
    const batchResult  = await batchIndexNow(urls, indexNowKey);
    const googleResult = doGoogle ? await pingGoogle(siteUrl || urls[0]) : null;
    const bingResult   = doBing   ? await pingBingSitemap(siteUrl || urls[0]) : null;

    return res.status(200).json({
      ok:           batchResult.ok,
      mode:         'batch',
      total:        urls.length,
      indexNow:     batchResult,
      google:       googleResult,
      bing:         bingResult,
    });
  }

  // Per-URL mode
  const results = await Promise.all(
    urls.map(async (url) => {
      const row = { url, google: null, bing: null, bingWebmaster: null, indexNow: null };
      try {
        new URL(url); // validate
        const tasks = [];

        if (doGoogle) {
          tasks.push(pingGoogle(url).then(r => { row.google = r; }));
        }
        if (doBing) {
          tasks.push(pingBingSitemap(url).then(r      => { row.bing          = r; }));
          tasks.push(pingBingWebmaster(url).then(r    => { row.bingWebmaster = r; }));
        }
        if (doIndexNow && indexNowKey) {
          tasks.push(submitIndexNow(url, indexNowKey).then(r => { row.indexNow = r; }));
        }

        await Promise.allSettled(tasks);
        row.ok = true;
      } catch (e) {
        row.ok    = false;
        row.error = e.message;
      }
      return row;
    })
  );

  const successCount = results.filter(r => r.ok).length;
  return res.status(200).json({
    ok:      successCount > 0,
    mode:    'per-url',
    total:   urls.length,
    success: successCount,
    results,
  });
}
