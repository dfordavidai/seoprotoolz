/**
 * /api/utils.js — Unified utility endpoint
 * Merges ping.js + whois.js + headers.js into one function to stay within
 * Vercel Hobby plan's 12-function limit.
 *
 * Route via ?action=<action>
 *
 * ── Ping ─────────────────────────────────────────────────────────────────────
 * POST /api/utils?action=ping
 * Body: { urls[], pingGoogle?, pingBing?, pingIndexNow?, indexNowKey?, siteUrl?, batch? }
 * Returns: { ok, mode, total, success, results[] }
 *
 * ── WHOIS / Domain Info ───────────────────────────────────────────────────────
 * POST /api/utils?action=whois   { domain }
 * GET  /api/utils?action=whois&domain=example.com
 * Returns: { ok, domain, whois, da, ip }
 *
 * ── HTTP Headers ─────────────────────────────────────────────────────────────
 * POST /api/utils?action=headers   { url }
 * GET  /api/utils?action=headers&url=<encoded>
 * Returns: { ok, status, headers{}, server, contentType, ... }
 */

import { handleCors, checkAuth } from '../lib/auth.js';

export const config = { maxDuration: 60 }; // ping needs up to 60s; others are faster

const TIMEOUT = 10000;

// ═══════════════════════════════════════════════════════════════════════════════
// PING HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function pingGoogle(url) {
  try {
    const pingUrl = `https://www.google.com/ping?sitemap=${encodeURIComponent(url)}`;
    const r = await fetch(pingUrl, { method: 'GET', signal: AbortSignal.timeout(TIMEOUT) });
    return { ok: r.ok || r.status === 200, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function pingBingSitemap(url) {
  try {
    const pingUrl = `https://www.bing.com/ping?sitemap=${encodeURIComponent(url)}`;
    const r = await fetch(pingUrl, { method: 'GET', signal: AbortSignal.timeout(TIMEOUT) });
    return { ok: r.ok || r.status === 200, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function pingBingWebmaster(url) {
  const bingKey = process.env.BING_WEBMASTER_KEY;
  if (!bingKey) return { ok: false, skipped: true, error: 'BING_WEBMASTER_KEY not set' };
  try {
    const r = await fetch('https://ssl.bing.com/webmaster/api.svc/json/SubmitUrl?apikey=' + bingKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ siteUrl: url, url }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function submitIndexNow(url, key) {
  let host;
  try { host = new URL(url).hostname; } catch { return { ok: false, error: 'Invalid URL' }; }
  try {
    const r = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host, key, keyLocation: `https://${host}/${key}.txt`, urlList: [url] }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    return { ok: r.status === 200 || r.status === 202, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function batchIndexNow(urls, key) {
  if (!urls.length || !key) return { ok: false, error: 'No URLs or key' };
  const byHost = {};
  for (const url of urls) {
    try { const { hostname } = new URL(url); if (!byHost[hostname]) byHost[hostname] = []; byHost[hostname].push(url); } catch (_) {}
  }
  const results = [];
  for (const [host, hostUrls] of Object.entries(byHost)) {
    try {
      const r = await fetch('https://api.indexnow.org/indexnow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ host, key, keyLocation: `https://${host}/${key}.txt`, urlList: hostUrls }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      results.push({ host, ok: r.status === 200 || r.status === 202, status: r.status, count: hostUrls.length });
    } catch (e) {
      results.push({ host, ok: false, error: e.message, count: hostUrls.length });
    }
  }
  return { ok: results.some(r => r.ok), results };
}

async function handlePing(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const {
    urls          = [],
    pingGoogle:   doGoogle   = true,
    pingBing:     doBing     = true,
    pingIndexNow: doIndexNow = false,
    indexNowKey               = process.env.INDEXNOW_KEY || null,
    siteUrl                   = null,
    batch                     = false,
  } = req.body || {};

  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls must be a non-empty array' });
  }

  if (batch && indexNowKey) {
    const batchResult  = await batchIndexNow(urls, indexNowKey);
    const googleResult = doGoogle ? await pingGoogle(siteUrl || urls[0]) : null;
    const bingResult   = doBing   ? await pingBingSitemap(siteUrl || urls[0]) : null;
    return res.status(200).json({ ok: batchResult.ok, mode: 'batch', total: urls.length, indexNow: batchResult, google: googleResult, bing: bingResult });
  }

  const results = await Promise.all(urls.map(async (url) => {
    const row = { url, google: null, bing: null, bingWebmaster: null, indexNow: null };
    try {
      new URL(url);
      const tasks = [];
      if (doGoogle)                     tasks.push(pingGoogle(url).then(r      => { row.google        = r; }));
      if (doBing)                      { tasks.push(pingBingSitemap(url).then(r => { row.bing          = r; }));
                                         tasks.push(pingBingWebmaster(url).then(r => { row.bingWebmaster = r; })); }
      if (doIndexNow && indexNowKey)    tasks.push(submitIndexNow(url, indexNowKey).then(r => { row.indexNow = r; }));
      await Promise.allSettled(tasks);
      row.ok = true;
    } catch (e) { row.ok = false; row.error = e.message; }
    return row;
  }));

  const successCount = results.filter(r => r.ok).length;
  return res.status(200).json({ ok: successCount > 0, mode: 'per-url', total: urls.length, success: successCount, results });
}

// ═══════════════════════════════════════════════════════════════════════════════
// WHOIS HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

async function handleWhois(req, res) {
  let domain = req.method === 'POST' ? req.body?.domain : req.query?.domain;
  if (!domain) return res.status(400).json({ error: 'Missing domain parameter' });

  domain = domain.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim().toLowerCase();
  const result = { ok: false, domain, whois: null, ip: null, da: null };

  try {
    const rdapRes = await fetch(`https://rdap.org/domain/${domain}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    }).catch(() => null);

    if (rdapRes?.ok) {
      const rdap = await rdapRes.json().catch(() => ({}));
      const nameservers = (rdap.nameservers || []).map(n => n.ldhName?.toLowerCase()).filter(Boolean);
      const events = rdap.events || [];
      const registrar = (rdap.entities || []).find(e => (e.roles || []).includes('registrar'));
      const registrarName = registrar?.vcardArray?.[1]?.find(v => v[0] === 'fn')?.[3] || registrar?.handle || null;
      result.whois = {
        registrar:   registrarName,
        created:     events.find(e => e.eventAction === 'registration')?.eventDate || null,
        expires:     events.find(e => e.eventAction === 'expiration')?.eventDate || null,
        updated:     events.find(e => e.eventAction === 'last changed')?.eventDate || null,
        status:      (rdap.status || []).join(', ') || null,
        nameservers,
        handle:      rdap.handle || null,
      };
      result.ok = true;
    }

    const dnsRes = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=A`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (dnsRes?.ok) {
      const dns = await dnsRes.json().catch(() => ({}));
      const aRecord = (dns.Answer || []).find(r => r.type === 1);
      if (aRecord) result.ip = aRecord.data;
    }

    const mozKey = process.env.MOZ_ACCESS_ID && process.env.MOZ_SECRET_KEY
      ? Buffer.from(`${process.env.MOZ_ACCESS_ID}:${process.env.MOZ_SECRET_KEY}`).toString('base64')
      : null;

    if (mozKey) {
      const mozRes = await fetch('https://lsapi.seomoz.com/v2/url_metrics', {
        method: 'POST',
        headers: { 'Authorization': `Basic ${mozKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets: [domain] }),
        signal: AbortSignal.timeout(10000),
      }).catch(() => null);
      if (mozRes?.ok) {
        const mozData = await mozRes.json().catch(() => ({}));
        result.da = mozData?.results?.[0]?.domain_authority ?? null;
        result.pa = mozData?.results?.[0]?.page_authority   ?? null;
      }
    }

    result.ok = true;
    return res.status(200).json(result);
  } catch (err) {
    return res.status(200).json({ ...result, ok: false, error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HEADERS HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

async function handleHeaders(req, res) {
  const url = req.method === 'POST' ? req.body?.url : req.query?.url;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  try { new URL(url); } catch (e) { return res.status(400).json({ error: 'Invalid URL' }); }

  try {
    const upstream = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEOBot/2.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });

    const headers = {};
    upstream.headers.forEach((value, key) => { headers[key] = value; });

    return res.status(200).json({
      ok:           upstream.ok,
      status:       upstream.status,
      statusText:   upstream.statusText,
      finalUrl:     upstream.url,
      redirected:   upstream.redirected,
      headers,
      server:       headers['server']        || null,
      contentType:  headers['content-type']  || null,
      poweredBy:    headers['x-powered-by']  || null,
      cacheControl: headers['cache-control'] || null,
    });
  } catch (err) {
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    return res.status(502).json({ ok: false, error: isTimeout ? 'Request timed out' : err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ROUTER
// ═══════════════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!checkAuth(req, res))  return;

  const action = req.query?.action || (req.method === 'POST' ? req.body?.action : null);

  switch (action) {
    case 'ping':    return handlePing(req, res);
    case 'whois':   return handleWhois(req, res);
    case 'headers': return handleHeaders(req, res);
    default:
      return res.status(400).json({
        error: 'Missing or unknown action. Use ?action=ping | whois | headers',
        actions: ['ping', 'whois', 'headers'],
      });
  }
}
