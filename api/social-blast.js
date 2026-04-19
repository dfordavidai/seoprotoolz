/**
 * /api/social-blast.js
 * Social Bookmarking Blaster — server-side submission engine
 * Supports: Mix, Pocket, Tumblr, Reddit, Flipboard, Instapaper,
 *           Diigo, Scoop.it, Folkd, BizSugar, SlashDot, Digg,
 *           Pearltrees, Fark, Netvouz, Yoolink, Bookmarkify,
 *           and generic form-post platforms via proxy
 *
 * POST /api/social-blast
 * {
 *   "platform": "pocket",
 *   "url": "https://your-parasite-page.com",
 *   "keyword": "best seo tools 2026",
 *   "title": "optional override title",
 *   "description": "optional override description",
 *   "tags": ["seo", "marketing"],
 *   "credentials": {
 *     "api_key": "...",
 *     "consumer_key": "...",
 *     "access_token": "...",
 *     "username": "...",
 *     "password": "...",
 *     "oauth_token": "..."
 *   },
 *   "subreddit": "entrepreneur",   // reddit only
 *   "tumblr_blog": "myblog"        // tumblr only
 * }
 *
 * Returns:
 * {
 *   "ok": true,
 *   "platform": "pocket",
 *   "submitted_url": "https://getpocket.com/...",
 *   "item_id": "...",
 *   "manual": false,
 *   "message": "Submitted successfully"
 * }
 */

import { allowCors, authCheck, jsonError } from '../lib/auth.js';

// ─── Internal CORS proxy helper ───────────────────────────────────────────────
// Calls our own /api/proxy endpoint so all outbound traffic is server-side
async function proxyFetch(req, { url, method = 'GET', headers = {}, body, timeout = 20000 }) {
  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';

  const res = await fetch(`${base}/api/proxy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': process.env.API_SECRET_KEY || '',
      'X-Internal': '1',
    },
    body: JSON.stringify({ url, method, headers, body, timeout }),
    signal: AbortSignal.timeout(timeout + 2000),
  });

  const data = await res.json();
  return data; // { ok, status_code, body, content_type, ... }
}

// ─── Platform handlers ────────────────────────────────────────────────────────

/** Pocket API — consumer_key + access_token required */
async function submitPocket(req, { url, keyword, title, tags, credentials }) {
  const { consumer_key, access_token } = credentials || {};
  if (!consumer_key || !access_token) {
    return { manual: true, message: 'Pocket requires consumer_key + access_token in credentials' };
  }

  const payload = {
    url,
    title: title || keyword,
    tags: (tags || [keyword]).join(','),
    consumer_key,
    access_token,
  };

  const result = await proxyFetch(req, {
    url: 'https://getpocket.com/v3/add',
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Accept': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!result.ok || result.status_code !== 200) {
    throw new Error(`Pocket API error: ${result.status_code} — ${result.body?.substring(0, 200)}`);
  }

  let parsed;
  try { parsed = JSON.parse(result.body); } catch { parsed = {}; }

  return {
    submitted_url: `https://getpocket.com/read/${parsed.item?.item_id || ''}`,
    item_id: parsed.item?.item_id,
    message: 'Added to Pocket',
  };
}

/** Reddit — username + password + app client_id + client_secret (script app) */
async function submitReddit(req, { url, keyword, title, subreddit, credentials }) {
  const { username, password, client_id, client_secret } = credentials || {};
  if (!username || !password || !client_id || !client_secret) {
    return { manual: true, message: 'Reddit requires username, password, client_id, client_secret. Use a "script" type app at reddit.com/prefs/apps' };
  }

  const sub = subreddit || 'u_' + username;

  // Step 1: Get OAuth token
  const tokenRes = await proxyFetch(req, {
    url: 'https://www.reddit.com/api/v1/access_token',
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${client_id}:${client_secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'SEOParasitePro/1.0',
    },
    body: `grant_type=password&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
  });

  let tokenData;
  try { tokenData = JSON.parse(tokenRes.body); } catch { throw new Error('Reddit OAuth token parse failed'); }
  if (!tokenData.access_token) throw new Error(`Reddit OAuth failed: ${tokenData.error || 'unknown'}`);

  // Step 2: Submit link
  const submitBody = new URLSearchParams({
    kind: 'link',
    sr: sub,
    title: title || keyword,
    url,
    resubmit: 'true',
    nsfw: 'false',
    spoiler: 'false',
  });

  const submitRes = await proxyFetch(req, {
    url: 'https://oauth.reddit.com/api/submit',
    method: 'POST',
    headers: {
      'Authorization': `bearer ${tokenData.access_token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'SEOParasitePro/1.0',
    },
    body: submitBody.toString(),
  });

  let submitData;
  try { submitData = JSON.parse(submitRes.body); } catch { throw new Error('Reddit submit parse failed'); }

  const postUrl = submitData?.jquery?.find?.(x => Array.isArray(x) && x[3] === 'call' && Array.isArray(x[4]) && typeof x[4][0] === 'string' && x[4][0].includes('reddit.com/r/'))?.[4]?.[0];

  return {
    submitted_url: postUrl || `https://www.reddit.com/r/${sub}/`,
    message: `Submitted to r/${sub}`,
  };
}

/** Tumblr — api_key (OAuth1 consumer key) + oauth_token + oauth_secret + blog name */
async function submitTumblr(req, { url, keyword, title, description, tags, credentials, tumblr_blog }) {
  const { consumer_key, consumer_secret, oauth_token, oauth_token_secret } = credentials || {};
  const blog = tumblr_blog || credentials?.blog;

  if (!consumer_key || !consumer_secret || !oauth_token || !oauth_token_secret || !blog) {
    return {
      manual: true,
      message: 'Tumblr requires consumer_key, consumer_secret, oauth_token, oauth_token_secret, and blog name (e.g. "myblog.tumblr.com")',
    };
  }

  // Build OAuth1 header
  const oauthHeader = buildOAuth1Header({
    method: 'POST',
    url: `https://api.tumblr.com/v2/blog/${blog}/post`,
    consumerKey: consumer_key,
    consumerSecret: consumer_secret,
    token: oauth_token,
    tokenSecret: oauth_token_secret,
    params: {
      type: 'link',
      url,
      title: title || keyword,
      description: description || keyword,
      tags: (tags || [keyword]).join(','),
      native_inline_images: 'false',
    },
  });

  const body = new URLSearchParams({
    type: 'link',
    url,
    title: title || keyword,
    description: description || keyword,
    tags: (tags || [keyword]).join(','),
    native_inline_images: 'false',
  });

  const result = await proxyFetch(req, {
    url: `https://api.tumblr.com/v2/blog/${blog}/post`,
    method: 'POST',
    headers: {
      'Authorization': oauthHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  let parsed;
  try { parsed = JSON.parse(result.body); } catch { parsed = {}; }

  if (parsed.meta?.status !== 201 && result.status_code !== 201) {
    throw new Error(`Tumblr error: ${parsed.meta?.msg || result.status_code}`);
  }

  const postId = parsed.response?.id;
  return {
    submitted_url: postId ? `https://${blog}/post/${postId}` : `https://${blog}`,
    item_id: String(postId || ''),
    message: `Posted to Tumblr blog: ${blog}`,
  };
}

/** Mix (formerly StumbleUpon) — api_key required */
async function submitMix(req, { url, keyword, title, description, tags, credentials }) {
  const { api_key } = credentials || {};
  if (!api_key) {
    return { manual: true, message: 'Mix requires api_key from mix.com/developers' };
  }

  const result = await proxyFetch(req, {
    url: 'https://mix.com/api/v2/saves',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${api_key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url,
      title: title || keyword,
      description: description || keyword,
      tags: tags || [keyword],
    }),
  });

  let parsed;
  try { parsed = JSON.parse(result.body); } catch { parsed = {}; }

  if (result.status_code !== 200 && result.status_code !== 201) {
    throw new Error(`Mix API error: ${result.status_code} — ${parsed.message || result.body?.substring(0, 100)}`);
  }

  return {
    submitted_url: parsed.data?.url || `https://mix.com`,
    message: 'Saved to Mix',
  };
}

/** Flipboard — username + password (form-based session) */
async function submitFlipboard(req, { url, keyword, title, credentials }) {
  const { username, password } = credentials || {};
  if (!username || !password) {
    return { manual: true, message: 'Flipboard requires username + password' };
  }

  // Flipboard has no public API — construct a manual submission link
  const flipUrl = `https://flipboard.com/bookmarklet/open?v=2&url=${encodeURIComponent(url)}&title=${encodeURIComponent(title || keyword)}`;
  return {
    submitted_url: flipUrl,
    manual: true,
    message: 'Flipboard requires browser-based submission. Open the URL above while logged in.',
  };
}

/** Instapaper — username (email) + password */
async function submitInstapaper(req, { url, keyword, title, credentials }) {
  const { username, password } = credentials || {};
  if (!username || !password) {
    return { manual: true, message: 'Instapaper requires username (email) + password' };
  }

  // Instapaper Simple API
  const params = new URLSearchParams({
    username,
    password,
    url,
    title: title || keyword,
    selection: keyword,
  });

  const result = await proxyFetch(req, {
    url: `https://www.instapaper.com/api/add?${params.toString()}`,
    method: 'GET',
  });

  // Returns 201 on success
  if (result.status_code !== 201 && result.status_code !== 200) {
    throw new Error(`Instapaper error: ${result.status_code}`);
  }

  return {
    submitted_url: `https://www.instapaper.com/u`,
    message: 'Saved to Instapaper',
  };
}

/** Diigo — api_key + username required */
async function submitDiigo(req, { url, keyword, title, description, tags, credentials }) {
  const { api_key, username } = credentials || {};
  if (!api_key || !username) {
    return { manual: true, message: 'Diigo requires api_key + username from developer.diigo.com' };
  }

  const params = new URLSearchParams({
    title: title || keyword,
    url,
    tags: (tags || [keyword]).join(','),
    desc: description || keyword,
    shared: 'yes',
    readLater: 'no',
  });

  const result = await proxyFetch(req, {
    url: `https://secure.diigo.com/api/v2/bookmarks?${params.toString()}`,
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${username}:${api_key}`).toString('base64'),
    },
  });

  if (result.status_code !== 200 && result.status_code !== 201) {
    throw new Error(`Diigo error: ${result.status_code} — ${result.body?.substring(0, 100)}`);
  }

  return {
    submitted_url: `https://www.diigo.com/user/${username}`,
    message: 'Bookmarked on Diigo',
  };
}

/** Scoop.it — requires access_token (OAuth2) */
async function submitScoopIt(req, { url, keyword, title, description, credentials }) {
  const { access_token } = credentials || {};
  if (!access_token) {
    return { manual: true, message: 'Scoop.it requires OAuth2 access_token from www.scoop.it/dev' };
  }

  // Get user's topic ID first
  const profileRes = await proxyFetch(req, {
    url: `https://www.scoop.it/api/1/profile?access_token=${access_token}`,
    method: 'GET',
  });

  let profileData;
  try { profileData = JSON.parse(profileRes.body); } catch { throw new Error('Scoop.it profile parse failed'); }

  const topicId = profileData?.user?.curatedTopics?.[0]?.id;
  if (!topicId) {
    return { manual: true, message: 'No Scoop.it topic found. Create a topic first at scoop.it' };
  }

  const body = new URLSearchParams({
    access_token,
    topicId,
    url,
    title: title || keyword,
    content: description || keyword,
  });

  const result = await proxyFetch(req, {
    url: 'https://www.scoop.it/api/1/post',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  let parsed;
  try { parsed = JSON.parse(result.body); } catch { parsed = {}; }

  if (parsed.error) throw new Error(`Scoop.it: ${parsed.error}`);

  return {
    submitted_url: `https://www.scoop.it`,
    message: 'Posted to Scoop.it',
  };
}

/** Folkd — username + password (form-based) */
async function submitFolkd(req, { url, keyword, title, description, tags, credentials }) {
  const { username, password } = credentials || {};
  if (!username || !password) {
    return { manual: true, message: 'Folkd requires username + password' };
  }

  // Step 1: Login
  const loginRes = await proxyFetch(req, {
    url: 'https://www.folkd.com/user/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&submit=Login`,
  });

  const sessionCookie = extractCookies(loginRes);
  if (!sessionCookie || loginRes.status_code === 401) {
    throw new Error('Folkd login failed — check credentials');
  }

  // Step 2: Submit bookmark
  const submitBody = new URLSearchParams({
    url,
    title: title || keyword,
    description: description || keyword,
    tags: (tags || [keyword]).join(' '),
    share: '1',
  });

  const submitRes = await proxyFetch(req, {
    url: 'https://www.folkd.com/submit/save',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': sessionCookie,
    },
    body: submitBody.toString(),
  });

  if (submitRes.status_code >= 400) {
    throw new Error(`Folkd submit error: ${submitRes.status_code}`);
  }

  return {
    submitted_url: `https://www.folkd.com/user/${username}`,
    message: 'Bookmarked on Folkd',
  };
}

/** BizSugar — username + password (form-based) */
async function submitBizSugar(req, { url, keyword, title, description, credentials }) {
  const { username, password } = credentials || {};
  if (!username || !password) {
    return { manual: true, message: 'BizSugar requires username + password' };
  }

  // Login
  const loginRes = await proxyFetch(req, {
    url: 'https://www.bizsugar.com/user/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
  });

  const sessionCookie = extractCookies(loginRes);
  if (!sessionCookie) throw new Error('BizSugar login failed');

  // Submit story
  const body = new URLSearchParams({
    url,
    title: title || keyword,
    description: description || keyword,
    category: '1',
  });

  const result = await proxyFetch(req, {
    url: 'https://www.bizsugar.com/story/submit',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': sessionCookie,
    },
    body: body.toString(),
  });

  return {
    submitted_url: `https://www.bizsugar.com`,
    message: 'Submitted to BizSugar',
  };
}

/** Pearltrees — access_token (OAuth2) */
async function submitPearltrees(req, { url, keyword, title, credentials }) {
  const { access_token } = credentials || {};
  if (!access_token) {
    return { manual: true, message: 'Pearltrees requires OAuth2 access_token' };
  }

  const result = await proxyFetch(req, {
    url: 'https://www.pearltrees.com/api/v2/pearls',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url, title: title || keyword }),
  });

  if (result.status_code >= 400) {
    throw new Error(`Pearltrees error: ${result.status_code}`);
  }

  return {
    submitted_url: `https://www.pearltrees.com`,
    message: 'Added to Pearltrees',
  };
}

/** Netvouz — username + password (form-based) */
async function submitNetvouz(req, { url, keyword, title, tags, credentials }) {
  const { username, password } = credentials || {};
  if (!username || !password) {
    return { manual: true, message: 'Netvouz requires username + password' };
  }

  const loginRes = await proxyFetch(req, {
    url: 'https://www.netvouz.com/action/submitLogin',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `login=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&rememberme=on`,
  });

  const cookie = extractCookies(loginRes);
  if (!cookie) throw new Error('Netvouz login failed');

  const body = new URLSearchParams({
    url,
    title: title || keyword,
    tags: (tags || [keyword]).join(' '),
    public: 'yes',
    source: 'api',
  });

  const result = await proxyFetch(req, {
    url: 'https://www.netvouz.com/action/submitBookmark',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookie,
    },
    body: body.toString(),
  });

  return {
    submitted_url: `https://www.netvouz.com/user/${username}`,
    message: 'Bookmarked on Netvouz',
  };
}

/** Slashdot — manual (no public API, bookmarklet only) */
async function submitSlashdot(req, { url, keyword, title }) {
  return {
    submitted_url: `https://slashdot.org/submission?url=${encodeURIComponent(url)}&title=${encodeURIComponent(title || keyword)}`,
    manual: true,
    message: 'Slashdot has no API. Open the URL above while logged in to submit.',
  };
}

/** Digg — manual (no public write API) */
async function submitDigg(req, { url, keyword, title }) {
  return {
    submitted_url: `https://digg.com/submit?url=${encodeURIComponent(url)}&title=${encodeURIComponent(title || keyword)}`,
    manual: true,
    message: 'Digg has no API. Open the URL above while logged in to submit.',
  };
}

/** Yoolink — api_key required */
async function submitYoolink(req, { url, keyword, title, description, tags, credentials }) {
  const { api_key, username } = credentials || {};
  if (!api_key || !username) {
    return { manual: true, message: 'Yoolink requires api_key + username' };
  }

  const params = new URLSearchParams({
    user: username,
    apikey: api_key,
    url,
    title: title || keyword,
    comment: description || keyword,
    tags: (tags || [keyword]).join(','),
    shared: '1',
  });

  const result = await proxyFetch(req, {
    url: `https://yoolink.fr/api/posts/add?${params.toString()}`,
    method: 'GET',
  });

  if (result.status_code !== 200 && result.status_code !== 201) {
    throw new Error(`Yoolink error: ${result.status_code}`);
  }

  return {
    submitted_url: `https://yoolink.fr/u/${username}`,
    message: 'Bookmarked on Yoolink',
  };
}

/** Generic form-post — for platforms the frontend already handles via proxy */
async function submitGeneric(req, { url, keyword, title, description, tags, credentials }) {
  const { post_url, extra_fields } = credentials || {};
  if (!post_url) {
    return { manual: true, message: 'Generic requires post_url in credentials' };
  }

  const body = new URLSearchParams({
    url,
    title: title || keyword,
    description: description || keyword,
    tags: (tags || [keyword]).join(','),
    ...(extra_fields || {}),
  });

  const result = await proxyFetch(req, {
    url: post_url,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  return {
    submitted_url: post_url,
    message: `Submitted to ${post_url} (status: ${result.status_code})`,
  };
}

// ─── Platform registry ────────────────────────────────────────────────────────

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

// ─── Batch submission ─────────────────────────────────────────────────────────

async function submitBatch(req, { platforms, url, keyword, title, description, tags, credentials_map, subreddit, tumblr_blog, drip_mode, drip_delay_ms = 5000 }) {
  const results = [];

  for (const platformKey of platforms) {
    const key = platformKey.toLowerCase().replace(/\s/g, '');
    const platformDef = PLATFORMS[key];

    if (!platformDef) {
      results.push({ platform: platformKey, ok: false, error: `Unknown platform: ${platformKey}` });
      continue;
    }

    try {
      const creds = (credentials_map || {})[key] || (credentials_map || {})[platformKey] || {};
      const result = await platformDef.fn(req, {
        url, keyword, title, description, tags,
        credentials: creds,
        subreddit, tumblr_blog,
      });

      results.push({
        platform: platformKey,
        ok: true,
        da: platformDef.da,
        ...result,
      });
    } catch (err) {
      results.push({
        platform: platformKey,
        ok: false,
        error: err.message,
      });
    }

    // Drip mode: space out submissions to avoid spam detection
    if (drip_mode && platforms.indexOf(platformKey) < platforms.length - 1) {
      await new Promise(r => setTimeout(r, drip_delay_ms));
    }
  }

  return results;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function extractCookies(proxyResult) {
  // The proxy passes back response headers in body for cookie extraction
  try {
    const parsed = typeof proxyResult.body === 'string' ? JSON.parse(proxyResult.body) : proxyResult.body;
    if (parsed?.set_cookie) return parsed.set_cookie;
  } catch { /* ignore */ }

  // Attempt to extract from redirect headers if proxy exposes them
  if (proxyResult.response_headers?.['set-cookie']) {
    const cookies = proxyResult.response_headers['set-cookie'];
    if (Array.isArray(cookies)) return cookies.map(c => c.split(';')[0]).join('; ');
    return String(cookies).split(';')[0];
  }

  return null;
}

/**
 * Minimal OAuth1 header builder (HMAC-SHA1).
 * Does not require external deps — uses Node's built-in crypto.
 */
function buildOAuth1Header({ method, url, consumerKey, consumerSecret, token, tokenSecret, params }) {
  const { createHmac } = await import('node:crypto').catch(() => require('crypto'));

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);

  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: token,
    oauth_version: '1.0',
  };

  const allParams = { ...params, ...oauthParams };
  const sortedParams = Object.keys(allParams)
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`)
    .join('&');

  const baseString = [
    method.toUpperCase(),
    encodeURIComponent(url),
    encodeURIComponent(sortedParams),
  ].join('&');

  const signingKey = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(tokenSecret)}`;
  const signature = createHmac('sha1', signingKey).update(baseString).digest('base64');

  oauthParams.oauth_signature = signature;

  const headerParts = Object.keys(oauthParams)
    .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
    .join(', ');

  return `OAuth ${headerParts}`;
}

// ─── Request handler ──────────────────────────────────────────────────────────

async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'Social Bookmarking Blaster',
      version: '1.0.0',
      platforms: Object.keys(PLATFORMS),
      usage: 'POST with { platform, url, keyword, credentials } or { platforms[], ... } for batch',
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json(jsonError('Method not allowed'));
  }

  const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');

  const {
    platform,
    platforms,
    url,
    keyword,
    title,
    description,
    tags,
    credentials,
    credentials_map,
    subreddit,
    tumblr_blog,
    drip_mode,
    drip_delay_ms,
  } = body;

  if (!url) return res.status(400).json(jsonError('url is required'));
  if (!keyword) return res.status(400).json(jsonError('keyword is required'));

  // ── Batch mode ──
  if (platforms && Array.isArray(platforms)) {
    if (platforms.length === 0) return res.status(400).json(jsonError('platforms array is empty'));
    if (platforms.length > 20) return res.status(400).json(jsonError('max 20 platforms per batch'));

    const results = await submitBatch(req, {
      platforms, url, keyword, title, description, tags,
      credentials_map: credentials_map || (credentials ? Object.fromEntries(platforms.map(p => [p, credentials])) : {}),
      subreddit, tumblr_blog, drip_mode, drip_delay_ms,
    });

    const succeeded = results.filter(r => r.ok).length;
    return res.status(200).json({
      ok: true,
      batch: true,
      total: results.length,
      succeeded,
      failed: results.length - succeeded,
      results,
    });
  }

  // ── Single platform mode ──
  if (!platform) return res.status(400).json(jsonError('platform or platforms[] is required'));

  const key = platform.toLowerCase().replace(/\s/g, '');
  const platformDef = PLATFORMS[key];
  if (!platformDef) {
    return res.status(400).json(jsonError(`Unknown platform: "${platform}". Available: ${Object.keys(PLATFORMS).join(', ')}`));
  }

  try {
    const result = await platformDef.fn(req, {
      url, keyword, title, description, tags, credentials: credentials || {},
      subreddit, tumblr_blog,
    });

    return res.status(200).json({
      ok: true,
      platform,
      da: platformDef.da,
      manual: result.manual || false,
      submitted_url: result.submitted_url || null,
      item_id: result.item_id || null,
      message: result.message || 'Submitted',
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      platform,
      error: err.message,
    });
  }
}

export default allowCors(authCheck(handler));
