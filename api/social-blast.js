/**
 * /api/social-blast.js  — UNIFIED Social Blast Engine
 * ─────────────────────────────────────────────────────────────────────────────
 * Single serverless function replacing social-blast.js + social-blast-accounts.js
 * + social-blast-queue.js. Routing is done via URL path suffix or ?_module= param.
 *
 * ── SUBMISSION ────────────────────────────────────────────────────────────────
 * POST /api/social-blast
 *      { platform, url, keyword, title?, description?, tags[], credentials{},
 *        subreddit?, tumblr_blog? }
 * POST /api/social-blast   (batch)
 *      { platforms[], url, keyword, ..., credentials_map{}, drip_mode?, drip_delay_ms? }
 * GET  /api/social-blast   → service info + platform list
 *
 * ── ACCOUNTS ─────────────────────────────────────────────────────────────────
 * POST /api/social-blast?_module=accounts&action=create
 *      { platforms[], profile_overrides?, captchaKey?, auto_verify?, save_to_db? }
 * GET  /api/social-blast?_module=accounts&action=list[&platform=X&status=Y]
 * POST /api/social-blast?_module=accounts&action=credentials
 *      { platform, username?, credentials{}, notes? }
 * GET  /api/social-blast?_module=accounts&action=health[&platform=X&limit=N]
 * DELETE /api/social-blast?_module=accounts&id=X
 *
 * ── QUEUE ─────────────────────────────────────────────────────────────────────
 * POST /api/social-blast?_module=queue
 *      { campaign_id?, platforms[], url, keyword, ..., drip?, drip_options{}, fire_now? }
 * GET  /api/social-blast?_module=queue[&process=1&limit=N]
 * GET  /api/social-blast?_module=queue&campaign_id=X
 * DELETE /api/social-blast?_module=queue&id=X
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Supabase tables required:
 *
 *   create table if not exists spp_blast_accounts (
 *     id          uuid primary key default gen_random_uuid(),
 *     platform    text not null,
 *     username    text,
 *     email       text,
 *     password    text,
 *     credentials jsonb,
 *     status      text default 'active',
 *     created_at  timestamptz not null default now(),
 *     last_used   timestamptz,
 *     notes       text
 *   );
 *
 *   create table if not exists spp_blast_queue (
 *     id           uuid primary key default gen_random_uuid(),
 *     campaign_id  text,
 *     platform     text not null,
 *     url          text not null,
 *     keyword      text not null,
 *     title        text,
 *     description  text,
 *     tags         text[],
 *     credentials  jsonb,
 *     subreddit    text,
 *     tumblr_blog  text,
 *     status       text not null default 'pending',
 *     result       jsonb,
 *     error        text,
 *     scheduled_at timestamptz not null default now(),
 *     executed_at  timestamptz,
 *     created_at   timestamptz not null default now()
 *   );
 */

import { allowCors, authCheck, jsonError } from '../lib/auth.js';

export const config = { maxDuration: 120 };

// ═══════════════════════════════════════════════════════════════════════════════
// ── SUPABASE HELPERS ──────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function sbCreds() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
  return { url: url.replace(/\/$/, ''), key };
}

function sbHeaders() {
  const { key } = sbCreds();
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

async function sbSelect(table, filter = {}, opts = {}) {
  const { url } = sbCreds();
  const params = new URLSearchParams({ select: opts.select || '*', ...filter });
  if (opts.order) params.set('order', opts.order);
  if (opts.limit) params.set('limit', String(opts.limit));
  const res = await fetch(`${url}/rest/v1/${table}?${params}`, { headers: sbHeaders() });
  return res.json();
}

async function sbInsert(table, rows) {
  const { url } = sbCreds();
  const res = await fetch(`${url}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
  });
  return res.json();
}

async function sbUpsert(table, row, onConflict = 'id') {
  const { url } = sbCreds();
  const res = await fetch(`${url}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: { ...sbHeaders(), Prefer: 'return=representation,resolution=merge-duplicates' },
    body: JSON.stringify(row),
  });
  return res.json();
}

async function sbPatch(table, id, patch) {
  const { url } = sbCreds();
  const res = await fetch(`${url}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { ...sbHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
  return res.ok;
}

async function sbDelete(table, id) {
  const { url } = sbCreds();
  const res = await fetch(`${url}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: sbHeaders(),
  });
  return res.ok;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── INTERNAL HELPERS ──────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function selfBase() {
  return process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';
}

function internalHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-API-Key': process.env.API_SECRET_KEY || '',
    'X-Internal': '1',
  };
}

/** Route outbound requests through our own proxy to avoid CORS / IP blocks */
async function proxyFetch(_req, { url, method = 'GET', headers = {}, body, timeout = 20000 }) {
  const res = await fetch(`${selfBase()}/api/proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...internalHeaders() },
    body: JSON.stringify({ url, method, headers, body, timeout }),
    signal: AbortSignal.timeout(timeout + 2000),
  });
  return res.json(); // { ok, status_code, body, content_type, ... }
}

function extractCookies(proxyResult) {
  try {
    const parsed = typeof proxyResult.body === 'string'
      ? JSON.parse(proxyResult.body)
      : proxyResult.body;
    if (parsed?.set_cookie) return parsed.set_cookie;
  } catch { /* ignore */ }
  if (proxyResult.response_headers?.['set-cookie']) {
    const c = proxyResult.response_headers['set-cookie'];
    if (Array.isArray(c)) return c.map(x => x.split(';')[0]).join('; ');
    return String(c).split(';')[0];
  }
  return null;
}

/**
 * Minimal OAuth1 / HMAC-SHA1 header builder — no external deps.
 */
async function buildOAuth1Header({ method, url, consumerKey, consumerSecret, token, tokenSecret, params }) {
  const { createHmac } = await import('node:crypto');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

  const oauthParams = {
    oauth_consumer_key:     consumerKey,
    oauth_nonce:            nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        timestamp,
    oauth_token:            token,
    oauth_version:          '1.0',
  };

  const allParams = { ...params, ...oauthParams };
  const sortedParams = Object.keys(allParams).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`).join('&');

  const baseString = [method.toUpperCase(), encodeURIComponent(url), encodeURIComponent(sortedParams)].join('&');
  const signingKey = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(tokenSecret)}`;
  const signature = createHmac('sha1', signingKey).update(baseString).digest('base64');

  oauthParams.oauth_signature = signature;
  const headerParts = Object.keys(oauthParams)
    .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
    .join(', ');
  return `OAuth ${headerParts}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── PLATFORM SUBMISSION HANDLERS ──────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

async function submitPocket(req, { url, keyword, title, tags, credentials }) {
  const { consumer_key, access_token } = credentials || {};
  if (!consumer_key || !access_token)
    return { manual: true, message: 'Pocket requires consumer_key + access_token in credentials' };

  const result = await proxyFetch(req, {
    url: 'https://getpocket.com/v3/add',
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Accept': 'application/json' },
    body: JSON.stringify({ url, title: title || keyword, tags: (tags || [keyword]).join(','), consumer_key, access_token }),
  });

  if (!result.ok || result.status_code !== 200)
    throw new Error(`Pocket API error: ${result.status_code} — ${String(result.body).substring(0, 200)}`);

  let parsed = {};
  try { parsed = JSON.parse(result.body); } catch {}
  return { submitted_url: `https://getpocket.com/read/${parsed.item?.item_id || ''}`, item_id: parsed.item?.item_id, message: 'Added to Pocket' };
}

async function submitReddit(req, { url, keyword, title, subreddit, credentials }) {
  const { username, password, client_id, client_secret } = credentials || {};
  if (!username || !password || !client_id || !client_secret)
    return { manual: true, message: 'Reddit requires username, password, client_id, client_secret. Use a "script" app at reddit.com/prefs/apps' };

  const sub = subreddit || 'u_' + username;

  const tokenRes = await proxyFetch(req, {
    url: 'https://www.reddit.com/api/v1/access_token',
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${client_id}:${client_secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'SEOParasitePro/1.0',
    },
    body: `grant_type=password&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
  });

  let tokenData = {};
  try { tokenData = JSON.parse(tokenRes.body); } catch { throw new Error('Reddit OAuth token parse failed'); }
  if (!tokenData.access_token) throw new Error(`Reddit OAuth failed: ${tokenData.error || 'unknown'}`);

  const submitBody = new URLSearchParams({ kind: 'link', sr: sub, title: title || keyword, url, resubmit: 'true', nsfw: 'false', spoiler: 'false' });
  const submitRes = await proxyFetch(req, {
    url: 'https://oauth.reddit.com/api/submit',
    method: 'POST',
    headers: { Authorization: `bearer ${tokenData.access_token}`, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SEOParasitePro/1.0' },
    body: submitBody.toString(),
  });

  let submitData = {};
  try { submitData = JSON.parse(submitRes.body); } catch { throw new Error('Reddit submit parse failed'); }
  const postUrl = submitData?.jquery?.find?.(x => Array.isArray(x) && x[3] === 'call' && Array.isArray(x[4]) && typeof x[4][0] === 'string' && x[4][0].includes('reddit.com/r/'))?.[4]?.[0];
  return { submitted_url: postUrl || `https://www.reddit.com/r/${sub}/`, message: `Submitted to r/${sub}` };
}

async function submitTumblr(req, { url, keyword, title, description, tags, credentials, tumblr_blog }) {
  const { consumer_key, consumer_secret, oauth_token, oauth_token_secret } = credentials || {};
  const blog = tumblr_blog || credentials?.blog;
  if (!consumer_key || !consumer_secret || !oauth_token || !oauth_token_secret || !blog)
    return { manual: true, message: 'Tumblr requires consumer_key, consumer_secret, oauth_token, oauth_token_secret, and blog name' };

  const postParams = { type: 'link', url, title: title || keyword, description: description || keyword, tags: (tags || [keyword]).join(','), native_inline_images: 'false' };
  const oauthHeader = await buildOAuth1Header({ method: 'POST', url: `https://api.tumblr.com/v2/blog/${blog}/post`, consumerKey: consumer_key, consumerSecret: consumer_secret, token: oauth_token, tokenSecret: oauth_token_secret, params: postParams });

  const result = await proxyFetch(req, {
    url: `https://api.tumblr.com/v2/blog/${blog}/post`,
    method: 'POST',
    headers: { Authorization: oauthHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(postParams).toString(),
  });

  let parsed = {};
  try { parsed = JSON.parse(result.body); } catch {}
  if (parsed.meta?.status !== 201 && result.status_code !== 201)
    throw new Error(`Tumblr error: ${parsed.meta?.msg || result.status_code}`);

  const postId = parsed.response?.id;
  return { submitted_url: postId ? `https://${blog}/post/${postId}` : `https://${blog}`, item_id: String(postId || ''), message: `Posted to Tumblr blog: ${blog}` };
}

async function submitMix(req, { url, keyword, title, description, tags, credentials }) {
  const { api_key } = credentials || {};
  if (!api_key) return { manual: true, message: 'Mix requires api_key from mix.com/developers' };

  const result = await proxyFetch(req, {
    url: 'https://mix.com/api/v2/saves',
    method: 'POST',
    headers: { Authorization: `Bearer ${api_key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, title: title || keyword, description: description || keyword, tags: tags || [keyword] }),
  });

  let parsed = {};
  try { parsed = JSON.parse(result.body); } catch {}
  if (result.status_code !== 200 && result.status_code !== 201)
    throw new Error(`Mix API error: ${result.status_code} — ${parsed.message || String(result.body).substring(0, 100)}`);

  return { submitted_url: parsed.data?.url || 'https://mix.com', message: 'Saved to Mix' };
}

async function submitFlipboard(_req, { url, keyword, title }) {
  return {
    submitted_url: `https://flipboard.com/bookmarklet/open?v=2&url=${encodeURIComponent(url)}&title=${encodeURIComponent(title || keyword)}`,
    manual: true,
    message: 'Flipboard requires browser-based submission. Open the URL above while logged in.',
  };
}

async function submitInstapaper(req, { url, keyword, title, credentials }) {
  const { username, password } = credentials || {};
  if (!username || !password) return { manual: true, message: 'Instapaper requires username (email) + password' };

  const params = new URLSearchParams({ username, password, url, title: title || keyword, selection: keyword });
  const result = await proxyFetch(req, { url: `https://www.instapaper.com/api/add?${params}`, method: 'GET' });
  if (result.status_code !== 201 && result.status_code !== 200) throw new Error(`Instapaper error: ${result.status_code}`);
  return { submitted_url: 'https://www.instapaper.com/u', message: 'Saved to Instapaper' };
}

async function submitDiigo(req, { url, keyword, title, description, tags, credentials }) {
  const { api_key, username } = credentials || {};
  if (!api_key || !username) return { manual: true, message: 'Diigo requires api_key + username from developer.diigo.com' };

  const params = new URLSearchParams({ title: title || keyword, url, tags: (tags || [keyword]).join(','), desc: description || keyword, shared: 'yes', readLater: 'no' });
  const result = await proxyFetch(req, {
    url: `https://secure.diigo.com/api/v2/bookmarks?${params}`,
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${username}:${api_key}`).toString('base64') },
  });
  if (result.status_code !== 200 && result.status_code !== 201) throw new Error(`Diigo error: ${result.status_code} — ${String(result.body).substring(0, 100)}`);
  return { submitted_url: `https://www.diigo.com/user/${username}`, message: 'Bookmarked on Diigo' };
}

async function submitScoopIt(req, { url, keyword, title, description, credentials }) {
  const { access_token } = credentials || {};
  if (!access_token) return { manual: true, message: 'Scoop.it requires OAuth2 access_token from www.scoop.it/dev' };

  const profileRes = await proxyFetch(req, { url: `https://www.scoop.it/api/1/profile?access_token=${access_token}`, method: 'GET' });
  let profileData = {};
  try { profileData = JSON.parse(profileRes.body); } catch { throw new Error('Scoop.it profile parse failed'); }
  const topicId = profileData?.user?.curatedTopics?.[0]?.id;
  if (!topicId) return { manual: true, message: 'No Scoop.it topic found. Create a topic first at scoop.it' };

  const body = new URLSearchParams({ access_token, topicId, url, title: title || keyword, content: description || keyword });
  const result = await proxyFetch(req, { url: 'https://www.scoop.it/api/1/post', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  let parsed = {};
  try { parsed = JSON.parse(result.body); } catch {}
  if (parsed.error) throw new Error(`Scoop.it: ${parsed.error}`);
  return { submitted_url: 'https://www.scoop.it', message: 'Posted to Scoop.it' };
}

async function submitFolkd(req, { url, keyword, title, description, tags, credentials }) {
  const { username, password } = credentials || {};
  if (!username || !password) return { manual: true, message: 'Folkd requires username + password' };

  const loginRes = await proxyFetch(req, { url: 'https://www.folkd.com/user/login', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&submit=Login` });
  const sessionCookie = extractCookies(loginRes);
  if (!sessionCookie || loginRes.status_code === 401) throw new Error('Folkd login failed — check credentials');

  const submitBody = new URLSearchParams({ url, title: title || keyword, description: description || keyword, tags: (tags || [keyword]).join(' '), share: '1' });
  const submitRes = await proxyFetch(req, { url: 'https://www.folkd.com/submit/save', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: sessionCookie }, body: submitBody.toString() });
  if (submitRes.status_code >= 400) throw new Error(`Folkd submit error: ${submitRes.status_code}`);
  return { submitted_url: `https://www.folkd.com/user/${username}`, message: 'Bookmarked on Folkd' };
}

async function submitBizSugar(req, { url, keyword, title, description, credentials }) {
  const { username, password } = credentials || {};
  if (!username || !password) return { manual: true, message: 'BizSugar requires username + password' };

  const loginRes = await proxyFetch(req, { url: 'https://www.bizsugar.com/user/login', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}` });
  const sessionCookie = extractCookies(loginRes);
  if (!sessionCookie) throw new Error('BizSugar login failed');

  const body = new URLSearchParams({ url, title: title || keyword, description: description || keyword, category: '1' });
  await proxyFetch(req, { url: 'https://www.bizsugar.com/story/submit', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: sessionCookie }, body: body.toString() });
  return { submitted_url: 'https://www.bizsugar.com', message: 'Submitted to BizSugar' };
}

async function submitPearltrees(req, { url, keyword, title, credentials }) {
  const { access_token } = credentials || {};
  if (!access_token) return { manual: true, message: 'Pearltrees requires OAuth2 access_token' };

  const result = await proxyFetch(req, { url: 'https://www.pearltrees.com/api/v2/pearls', method: 'POST', headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ url, title: title || keyword }) });
  if (result.status_code >= 400) throw new Error(`Pearltrees error: ${result.status_code}`);
  return { submitted_url: 'https://www.pearltrees.com', message: 'Added to Pearltrees' };
}

async function submitNetvouz(req, { url, keyword, title, tags, credentials }) {
  const { username, password } = credentials || {};
  if (!username || !password) return { manual: true, message: 'Netvouz requires username + password' };

  const loginRes = await proxyFetch(req, { url: 'https://www.netvouz.com/action/submitLogin', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `login=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&rememberme=on` });
  const cookie = extractCookies(loginRes);
  if (!cookie) throw new Error('Netvouz login failed');

  const body = new URLSearchParams({ url, title: title || keyword, tags: (tags || [keyword]).join(' '), public: 'yes', source: 'api' });
  await proxyFetch(req, { url: 'https://www.netvouz.com/action/submitBookmark', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie }, body: body.toString() });
  return { submitted_url: `https://www.netvouz.com/user/${username}`, message: 'Bookmarked on Netvouz' };
}

async function submitSlashdot(_req, { url, keyword, title }) {
  return { submitted_url: `https://slashdot.org/submission?url=${encodeURIComponent(url)}&title=${encodeURIComponent(title || keyword)}`, manual: true, message: 'Slashdot has no API. Open the URL above while logged in.' };
}

async function submitDigg(_req, { url, keyword, title }) {
  return { submitted_url: `https://digg.com/submit?url=${encodeURIComponent(url)}&title=${encodeURIComponent(title || keyword)}`, manual: true, message: 'Digg has no API. Open the URL above while logged in.' };
}

async function submitYoolink(req, { url, keyword, title, description, tags, credentials }) {
  const { api_key, username } = credentials || {};
  if (!api_key || !username) return { manual: true, message: 'Yoolink requires api_key + username' };

  const params = new URLSearchParams({ user: username, apikey: api_key, url, title: title || keyword, comment: description || keyword, tags: (tags || [keyword]).join(','), shared: '1' });
  const result = await proxyFetch(req, { url: `https://yoolink.fr/api/posts/add?${params}`, method: 'GET' });
  if (result.status_code !== 200 && result.status_code !== 201) throw new Error(`Yoolink error: ${result.status_code}`);
  return { submitted_url: `https://yoolink.fr/u/${username}`, message: 'Bookmarked on Yoolink' };
}

async function submitGeneric(req, { url, keyword, title, description, tags, credentials }) {
  const { post_url, extra_fields } = credentials || {};
  if (!post_url) return { manual: true, message: 'Generic requires post_url in credentials' };

  const body = new URLSearchParams({ url, title: title || keyword, description: description || keyword, tags: (tags || [keyword]).join(','), ...(extra_fields || {}) });
  const result = await proxyFetch(req, { url: post_url, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  return { submitted_url: post_url, message: `Submitted to ${post_url} (status: ${result.status_code})` };
}

// ─── Platform Registry ────────────────────────────────────────────────────────

const PLATFORMS = {
  pocket:      { fn: submitPocket,      auth: 'oauth2',   da: 94 },
  reddit:      { fn: submitReddit,      auth: 'oauth1',   da: 98 },
  tumblr:      { fn: submitTumblr,      auth: 'oauth1',   da: 91 },
  mix:         { fn: submitMix,         auth: 'api_key',  da: 74 },
  flipboard:   { fn: submitFlipboard,   auth: 'manual',   da: 87 },
  instapaper:  { fn: submitInstapaper,  auth: 'password', da: 73 },
  diigo:       { fn: submitDiigo,       auth: 'api_key',  da: 68 },
  scoopIt:     { fn: submitScoopIt,     auth: 'oauth2',   da: 65 },
  'scoop.it':  { fn: submitScoopIt,     auth: 'oauth2',   da: 65 },
  folkd:       { fn: submitFolkd,       auth: 'password', da: 62 },
  bizsugar:    { fn: submitBizSugar,    auth: 'password', da: 60 },
  pearltrees:  { fn: submitPearltrees,  auth: 'oauth2',   da: 61 },
  netvouz:     { fn: submitNetvouz,     auth: 'password', da: 50 },
  slashdot:    { fn: submitSlashdot,    auth: 'manual',   da: 91 },
  digg:        { fn: submitDigg,        auth: 'manual',   da: 88 },
  yoolink:     { fn: submitYoolink,     auth: 'api_key',  da: 45 },
  generic:     { fn: submitGeneric,     auth: 'custom',   da: 0  },
};

function normalizePlatformKey(k) {
  return k.toLowerCase().replace(/\s/g, '');
}

// ─── Batch Submission ─────────────────────────────────────────────────────────

async function submitBatch(req, { platforms, url, keyword, title, description, tags, credentials_map, subreddit, tumblr_blog, drip_mode, drip_delay_ms = 5000 }) {
  const results = [];
  for (const platformKey of platforms) {
    const key = normalizePlatformKey(platformKey);
    const def = PLATFORMS[key];
    if (!def) { results.push({ platform: platformKey, ok: false, error: `Unknown platform: ${platformKey}` }); continue; }

    try {
      const creds = (credentials_map || {})[key] || (credentials_map || {})[platformKey] || {};
      const result = await def.fn(req, { url, keyword, title, description, tags, credentials: creds, subreddit, tumblr_blog });
      results.push({ platform: platformKey, ok: true, da: def.da, ...result });
    } catch (err) {
      results.push({ platform: platformKey, ok: false, error: err.message });
    }

    if (drip_mode && platforms.indexOf(platformKey) < platforms.length - 1) {
      await new Promise(r => setTimeout(r, drip_delay_ms));
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── ACCOUNTS MODULE ───────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const PRESET_PLATFORMS = new Set([
  'wordpress', 'medium', 'reddit', 'quora', 'tumblr', 'weebly',
  'blogger', 'wix', 'devto', 'hashnode', 'strikingly', 'site123',
  'livejournal', 'ghost', 'substack', 'linkedin', 'pinterest', 'mix',
]);

function randomProfile(overrides = {}) {
  const firstNames = ['Alex', 'Jordan', 'Casey', 'Morgan', 'Riley', 'Taylor', 'Jamie', 'Drew'];
  const lastNames  = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis'];
  const fn = firstNames[Math.floor(Math.random() * firstNames.length)];
  const ln = lastNames[Math.floor(Math.random() * lastNames.length)];
  const suffix = Math.floor(Math.random() * 9000) + 1000;
  return { firstName: fn, lastName: ln, fullName: `${fn} ${ln}`, username: `${fn.toLowerCase()}${ln.toLowerCase()}${suffix}`, password: `Secure${suffix}!x`, city: 'Austin', country: 'US', zipcode: '78701', bio: 'Digital marketing enthusiast and content creator.', birthYear: '1990', birthMonth: '06', birthDay: '15', ...overrides };
}

function guessPlatformRegisterUrl(platform) {
  const urlMap = { folkd: 'https://www.folkd.com/user/register', diigo: 'https://www.diigo.com/sign-up', instapaper: 'https://www.instapaper.com/account/create', bizsugar: 'https://www.bizsugar.com/user/register', netvouz: 'https://www.netvouz.com/register', pearltrees: 'https://www.pearltrees.com/signup' };
  return urlMap[platform.toLowerCase()] || `https://www.${platform.toLowerCase()}.com/signup`;
}

function guessProfileUrl(platform, username) {
  if (!username) return null;
  const map = { reddit: `https://www.reddit.com/user/${username}`, tumblr: `https://${username}.tumblr.com`, medium: `https://medium.com/@${username}`, mix: `https://mix.com/u/${username}`, diigo: `https://www.diigo.com/user/${username}`, folkd: `https://www.folkd.com/user/${username}`, bizsugar: `https://www.bizsugar.com/user/${username}`, devto: `https://dev.to/${username}`, hashnode: `https://hashnode.com/@${username}`, pinterest: `https://www.pinterest.com/${username}`, linkedin: `https://www.linkedin.com/in/${username}` };
  return map[platform] || null;
}

async function createAccounts({ platforms, profile_overrides = {}, captchaKey, auto_verify = true, save_to_db = true }) {
  const results = [];
  for (const platform of platforms) {
    const profile = randomProfile(profile_overrides);
    let result;
    try {
      if (PRESET_PLATFORMS.has(platform.toLowerCase())) {
        const res = await fetch(`${selfBase()}/api/register`, { method: 'POST', headers: internalHeaders(), body: JSON.stringify({ platform: platform.toLowerCase(), username: profile.username, password: profile.password, captchaKey: captchaKey || null, useMailTm: auto_verify, autoVerify: auto_verify }) });
        result = await res.json();
      } else {
        const res = await fetch(`${selfBase()}/api/universal-register`, { method: 'POST', headers: internalHeaders(), body: JSON.stringify({ url: guessPlatformRegisterUrl(platform), profile: { ...profile, email: `${profile.username}@placeholder.com` }, captchaKey: captchaKey || null, autoVerify: auto_verify }) });
        result = await res.json();
      }

      const accountRecord = { platform: platform.toLowerCase(), username: result.username || profile.username, email: result.email || null, password: profile.password, credentials: result.credentials || {}, status: result.ok ? 'active' : 'failed', notes: result.message || null };
      if (save_to_db && process.env.SUPABASE_URL) {
        const saved = await sbUpsert('spp_blast_accounts', accountRecord, 'platform,username');
        accountRecord.id = Array.isArray(saved) ? saved[0]?.id : saved?.id;
      }
      results.push({ platform, ok: !!result.ok, account: accountRecord, raw: result });
    } catch (err) {
      results.push({ platform, ok: false, error: err.message });
    }
  }
  return results;
}

async function listAccounts(platform, status) {
  const filters = {};
  if (platform) filters.platform = `eq.${platform}`;
  if (status) filters.status = `eq.${status}`;
  return sbSelect('spp_blast_accounts', filters, { order: 'created_at.desc', limit: 200 });
}

async function upsertCredentials({ platform, username, credentials, notes }) {
  if (!platform) throw new Error('platform required');
  if (!credentials) throw new Error('credentials object required');
  return sbUpsert('spp_blast_accounts', { platform: platform.toLowerCase(), username: username || null, credentials, status: 'active', notes: notes || null }, 'platform,username');
}

async function checkHealth(accounts) {
  const results = [];
  for (const account of accounts) {
    const profileUrl = guessProfileUrl(account.platform, account.username);
    if (!profileUrl) { results.push({ id: account.id, platform: account.platform, reachable: null, note: 'No profile URL pattern known' }); continue; }
    try {
      const res = await fetch(profileUrl, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
      const alive = res.status < 400;
      if (!alive) await sbPatch('spp_blast_accounts', account.id, { status: 'banned', notes: `HEAD ${profileUrl} → ${res.status}` });
      results.push({ id: account.id, platform: account.platform, reachable: alive, status_code: res.status, profile_url: profileUrl });
    } catch (err) {
      results.push({ id: account.id, platform: account.platform, reachable: false, error: err.message });
    }
  }
  return results;
}

async function handleAccounts(req, res) {
  const qp = req.query || {};
  const action = qp.action || 'list';

  // DELETE
  if (req.method === 'DELETE') {
    const id = qp.id;
    if (!id) return res.status(400).json(jsonError('id query param required'));
    const ok = await sbDelete('spp_blast_accounts', id);
    return res.status(200).json({ ok, id });
  }

  // GET
  if (req.method === 'GET') {
    if (action === 'health') {
      const filters = { status: 'eq.active' };
      if (qp.platform) filters.platform = `eq.${qp.platform}`;
      const accounts = await sbSelect('spp_blast_accounts', filters, { limit: parseInt(qp.limit || '20', 10) });
      const results = await checkHealth(Array.isArray(accounts) ? accounts : []);
      return res.status(200).json({ ok: true, results });
    }
    const accounts = await listAccounts(qp.platform, qp.status);
    return res.status(200).json({ ok: true, total: Array.isArray(accounts) ? accounts.length : 0, accounts });
  }

  if (req.method !== 'POST') return res.status(405).json(jsonError('Method not allowed'));

  const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');

  if (action === 'credentials') {
    const result = await upsertCredentials(body);
    return res.status(200).json({ ok: true, result });
  }

  // create
  const { platforms, profile_overrides, captchaKey, auto_verify, save_to_db } = body;
  if (!platforms || !platforms.length) return res.status(400).json(jsonError('platforms[] is required'));
  const results = await createAccounts({ platforms, profile_overrides, captchaKey, auto_verify, save_to_db });
  const succeeded = results.filter(r => r.ok).length;
  return res.status(200).json({ ok: true, total: results.length, succeeded, failed: results.length - succeeded, results });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── QUEUE MODULE ──────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function buildDripSchedule(platforms, { start_at, min_gap_minutes = 8, max_gap_minutes = 25 }) {
  const schedule = [];
  let cursor = start_at ? new Date(start_at) : new Date();
  for (const platform of platforms) {
    schedule.push({ platform, scheduled_at: new Date(cursor) });
    const gap = min_gap_minutes + Math.random() * (max_gap_minutes - min_gap_minutes);
    cursor = new Date(cursor.getTime() + gap * 60 * 1000);
  }
  return schedule;
}

async function processPending(limit = 5) {
  const now = new Date().toISOString();
  const jobs = await sbSelect('spp_blast_queue', { status: 'eq.pending', scheduled_at: `lte.${now}` }, { order: 'scheduled_at.asc', limit });
  if (!Array.isArray(jobs) || jobs.length === 0) return { processed: 0, results: [] };

  const results = [];
  for (const job of jobs) {
    await sbPatch('spp_blast_queue', job.id, { status: 'running' });
    try {
      const blastRes = await fetch(`${selfBase()}/api/social-blast`, {
        method: 'POST',
        headers: internalHeaders(),
        body: JSON.stringify({ platform: job.platform, url: job.url, keyword: job.keyword, title: job.title, description: job.description, tags: job.tags, credentials: job.credentials, subreddit: job.subreddit, tumblr_blog: job.tumblr_blog }),
      });
      const result = await blastRes.json();
      await sbPatch('spp_blast_queue', job.id, { status: result.ok ? 'done' : 'failed', result, error: result.ok ? null : (result.error || 'Unknown error'), executed_at: new Date().toISOString() });
      results.push({ id: job.id, platform: job.platform, ok: result.ok, result });
    } catch (err) {
      await sbPatch('spp_blast_queue', job.id, { status: 'failed', error: err.message, executed_at: new Date().toISOString() });
      results.push({ id: job.id, platform: job.platform, ok: false, error: err.message });
    }
  }
  return { processed: results.length, results };
}

async function handleQueue(req, res) {
  const qp = req.query || {};

  // DELETE
  if (req.method === 'DELETE') {
    const id = qp.id;
    if (!id) return res.status(400).json(jsonError('id query param required'));
    const ok = await sbDelete('spp_blast_queue', id);
    return res.status(200).json({ ok, id });
  }

  // GET
  if (req.method === 'GET') {
    if (qp.process === '1' || qp.process === 'true') {
      const result = await processPending(parseInt(qp.limit || '5', 10));
      return res.status(200).json({ ok: true, ...result });
    }
    const filter = qp.campaign_id ? { campaign_id: `eq.${qp.campaign_id}` } : {};
    const jobs = await sbSelect('spp_blast_queue', filter, { order: 'scheduled_at.asc', limit: 100 });
    const safeJobs = Array.isArray(jobs) ? jobs : [];
    return res.status(200).json({
      ok: true,
      total: safeJobs.length,
      counts: { pending: safeJobs.filter(j => j.status === 'pending').length, running: safeJobs.filter(j => j.status === 'running').length, done: safeJobs.filter(j => j.status === 'done').length, failed: safeJobs.filter(j => j.status === 'failed').length },
      jobs: safeJobs,
    });
  }

  if (req.method !== 'POST') return res.status(405).json(jsonError('Method not allowed'));

  const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
  const { campaign_id, platforms, url, keyword, title, description, tags, credentials_map, subreddit, tumblr_blog, drip, drip_options, fire_now } = body;

  if (!url)      return res.status(400).json(jsonError('url is required'));
  if (!keyword)  return res.status(400).json(jsonError('keyword is required'));
  if (!platforms || !platforms.length) return res.status(400).json(jsonError('platforms[] is required'));

  // Immediate fire — bypass queue, run blast inline
  if (fire_now) {
    const results = await submitBatch(req, { platforms, url, keyword, title, description, tags, credentials_map: credentials_map || {}, subreddit, tumblr_blog, drip_mode: false });
    const succeeded = results.filter(r => r.ok).length;
    return res.status(200).json({ ok: true, batch: true, total: results.length, succeeded, failed: results.length - succeeded, results });
  }

  const schedule = drip ? buildDripSchedule(platforms, drip_options || {}) : platforms.map(p => ({ platform: p, scheduled_at: new Date() }));
  const rows = schedule.map(({ platform, scheduled_at }) => ({ campaign_id: campaign_id || null, platform, url, keyword, title: title || null, description: description || null, tags: tags || null, credentials: (credentials_map || {})[platform.toLowerCase()] || null, subreddit: subreddit || null, tumblr_blog: tumblr_blog || null, status: 'pending', scheduled_at: scheduled_at.toISOString() }));

  const inserted = await sbInsert('spp_blast_queue', rows);
  return res.status(200).json({ ok: true, enqueued: rows.length, campaign_id: campaign_id || null, drip_mode: !!drip, first_fire: schedule[0]?.scheduled_at, last_fire: schedule[schedule.length - 1]?.scheduled_at, jobs: inserted });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── MAIN HANDLER + ROUTER ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

async function handler(req, res) {
  const qp = req.query || {};
  const mod = qp._module; // 'accounts' | 'queue' | undefined (= blast)

  // ── Accounts module ──
  if (mod === 'accounts') return handleAccounts(req, res);

  // ── Queue module ──
  if (mod === 'queue') return handleQueue(req, res);

  // ── Blast (default) ──
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'Social Bookmarking Blaster (Unified)',
      version: '2.0.0',
      platforms: Object.keys(PLATFORMS),
      modules: {
        blast:    'POST /api/social-blast',
        accounts: 'GET|POST|DELETE /api/social-blast?_module=accounts&action=create|list|credentials|health',
        queue:    'GET|POST|DELETE /api/social-blast?_module=queue',
      },
      usage: 'POST with { platform, url, keyword, credentials } or { platforms[], ... } for batch',
    });
  }

  if (req.method !== 'POST') return res.status(405).json(jsonError('Method not allowed'));

  const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
  const { platform, platforms, url, keyword, title, description, tags, credentials, credentials_map, subreddit, tumblr_blog, drip_mode, drip_delay_ms } = body;

  if (!url)     return res.status(400).json(jsonError('url is required'));
  if (!keyword) return res.status(400).json(jsonError('keyword is required'));

  // Batch
  if (platforms && Array.isArray(platforms)) {
    if (platforms.length === 0)  return res.status(400).json(jsonError('platforms array is empty'));
    if (platforms.length > 20)   return res.status(400).json(jsonError('max 20 platforms per batch'));
    const results = await submitBatch(req, { platforms, url, keyword, title, description, tags, credentials_map: credentials_map || (credentials ? Object.fromEntries(platforms.map(p => [p, credentials])) : {}), subreddit, tumblr_blog, drip_mode, drip_delay_ms });
    const succeeded = results.filter(r => r.ok).length;
    return res.status(200).json({ ok: true, batch: true, total: results.length, succeeded, failed: results.length - succeeded, results });
  }

  // Single
  if (!platform) return res.status(400).json(jsonError('platform or platforms[] is required'));
  const key = normalizePlatformKey(platform);
  const def = PLATFORMS[key];
  if (!def) return res.status(400).json(jsonError(`Unknown platform: "${platform}". Available: ${Object.keys(PLATFORMS).join(', ')}`));

  try {
    const result = await def.fn(req, { url, keyword, title, description, tags, credentials: credentials || {}, subreddit, tumblr_blog });
    return res.status(200).json({ ok: true, platform, da: def.da, manual: result.manual || false, submitted_url: result.submitted_url || null, item_id: result.item_id || null, message: result.message || 'Submitted' });
  } catch (err) {
    return res.status(500).json({ ok: false, platform, error: err.message });
  }
}

export default allowCors(authCheck(handler));
