// api/ping.js — Submit / ping URLs to search engines and indexing services
// POST { urls: string[], pingGoogle?: bool, pingBing?: bool, pingIndexNow?: bool, indexNowKey?: string }
// Returns: { ok, results: [ { url, google, bing, indexNow, error } ] }

import { handleCors, checkAuth } from '../lib/auth.js';

export const config = { maxDuration: 30 };

const TIMEOUT = 8000;

async function pingGoogle(url) {
  try {
    const r = await fetch(
      `https://www.google.com/ping?sitemap=${encodeURIComponent(url)}`,
      { method: 'GET', signal: AbortSignal.timeout(TIMEOUT) }
    );
    return { ok: r.ok || r.status === 200, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function pingBing(url) {
  const bingKey = process.env.BING_WEBMASTER_KEY;
  if (!bingKey) return { ok: false, error: 'BING_WEBMASTER_KEY not configured' };
  try {
    const r = await fetch(
      `https://ssl.bing.com/webmaster/api.svc/json/SubmitUrl?apikey=${bingKey}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body:    JSON.stringify({ siteUrl: url, url }),
        signal:  AbortSignal.timeout(TIMEOUT),
      }
    );
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function pingIndexNow(url, key) {
  const host = new URL(url).hostname;
  try {
    const r = await fetch('https://api.indexnow.org/indexnow', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body:    JSON.stringify({
        host,
        key,
        urlList: [url],
        keyLocation: `https://${host}/${key}.txt`,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    return { ok: r.status === 200 || r.status === 202, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!checkAuth(req, res)) return;

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const {
    urls = [],
    pingGoogle:   doGoogle   = true,
    pingBing:     doBing     = true,
    pingIndexNow: doIndexNow = false,
    indexNowKey               = process.env.INDEXNOW_KEY || null,
  } = req.body || {};

  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls must be a non-empty array' });
  }

  const results = await Promise.all(
    urls.map(async (url) => {
      const row = { url, google: null, bing: null, indexNow: null };
      try {
        new URL(url); // validate
        const tasks = [];
        if (doGoogle)   tasks.push(pingGoogle(url).then(r   => { row.google   = r; }));
        if (doBing)     tasks.push(pingBing(url).then(r     => { row.bing     = r; }));
        if (doIndexNow && indexNowKey)
                        tasks.push(pingIndexNow(url, indexNowKey).then(r => { row.indexNow = r; }));
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
    total:   urls.length,
    success: successCount,
    results,
  });
}
