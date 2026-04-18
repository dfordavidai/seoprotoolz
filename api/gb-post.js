/**
 * api/gb-post.js
 * Global Blast Campaign Runner
 * Fires all selected platforms simultaneously.
 * Uses REST API first → falls back to Playwright for browser-form sites.
 *
 * POST /api/gb-post
 * Body: {
 *   sites        array    — [{ url, credentials, method }] from BLP_SITES
 *   content      object   — { title, body, tags, links[] }
 *   options      object   — { concurrency?, timeout?, captchaKey?, screenshot? }
 * }
 */

import { requireAuth, cors, jsonErr } from '../lib/auth.js';
import { getProfile, formatContent } from '../lib/site-profiles.js';
import { chromium } from 'playwright-core';
import chromiumPkg from '@sparticuz/chromium';

export const config = { maxDuration: 300, memory: 1024 };

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const DEFAULT_CONCURRENCY = 5;  // parallel browser instances
const DEFAULT_TIMEOUT     = 45_000;

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────

export default async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.end();

  const authResult = requireAuth(req, res);
  if (!authResult) return;

  if (req.method !== 'POST') return jsonErr(res, 405, 'Method not allowed');

  let body = {};
  try {
    if (typeof req.body === 'string') body = JSON.parse(req.body);
    else if (req.body && typeof req.body === 'object') body = req.body;
  } catch (e) { return jsonErr(res, 400, 'Invalid JSON body'); }

  const { sites = [], content = {}, options = {} } = body;

  if (!sites.length) return jsonErr(res, 400, 'sites array is required');

  const concurrency = options.concurrency || DEFAULT_CONCURRENCY;
  const timeout     = options.timeout || DEFAULT_TIMEOUT;

  const startTime = Date.now();
  const results   = [];

  // ── BATCH PROCESSING ──────────────────────────────────────────────────────
  // Split sites into chunks of `concurrency` and process in parallel batches.

  const queue = [...sites];
  while (queue.length > 0) {
    const batch = queue.splice(0, concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(site => processSite(site, content, options, timeout))
    );

    for (const [i, r] of batchResults.entries()) {
      const site = batch[i];
      if (r.status === 'fulfilled') {
        results.push({ url: site.url, ...r.value });
      } else {
        results.push({ url: site.url, ok: false, error: r.reason?.message || 'Unknown error' });
      }
    }
  }

  const elapsed   = Date.now() - startTime;
  const succeeded = results.filter(r => r.ok).length;
  const failed    = results.filter(r => !r.ok).length;

  return res.status(200).json({
    ok: true,
    summary: { total: sites.length, succeeded, failed, elapsed_ms: elapsed },
    successRate: Math.round((succeeded / sites.length) * 100) + '%',
    results,
  });
};

// ─── SITE PROCESSOR ───────────────────────────────────────────────────────────

async function processSite(site, content, options, timeout) {
  const { url, credentials = {}, method = 'auto' } = site;

  // Determine strategy: REST API or Playwright
  const strategy = resolveStrategy(url, method, credentials);

  if (strategy === 'rest_api') {
    return restApiPost(url, credentials, content, options, timeout);
  } else {
    return playwrightPost(url, credentials, content, options, timeout);
  }
}

// ─── STRATEGY RESOLVER ────────────────────────────────────────────────────────

function resolveStrategy(url, method, credentials) {
  if (method === 'browser_form') return 'playwright';
  if (method === 'rest_api') return 'rest_api';
  if (method === 'manual') return 'skip';

  // Auto-detect: if token/api_key → REST; user_pass → Playwright
  if (credentials.token || credentials.api_key || credentials.apiKey) return 'rest_api';
  if (credentials.username && credentials.password) return 'playwright';
  if (credentials.cookie) return 'playwright';

  return 'playwright'; // default to browser
}

// ─── REST API POST ────────────────────────────────────────────────────────────

async function restApiPost(url, credentials, content, options, timeout) {
  // Determine REST handler from domain
  const domain = extractDomain(url);
  const handler = REST_HANDLERS[domain];

  if (!handler) {
    return { ok: false, method: 'rest_api', error: `No REST handler for ${domain}` };
  }

  try {
    const result = await Promise.race([
      handler(url, credentials, content),
      new Promise((_, rej) => setTimeout(() => rej(new Error('REST API timeout')), timeout)),
    ]);
    return { ok: true, method: 'rest_api', ...result };
  } catch (err) {
    // Fallback to Playwright if REST fails
    return playwrightPost(url, credentials, content, options, timeout, 'rest_fallback');
  }
}

// ─── PLAYWRIGHT POST ──────────────────────────────────────────────────────────

async function playwrightPost(url, credentials, content, options, timeout, fallbackReason) {
  try {
    // Forward to blp-post module (internal call)

    let browser;
    try {
      browser = await chromium.launch({
        args: [...chromiumPkg.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--single-process'],
        executablePath: await chromiumPkg.executablePath(),
        headless: chromiumPkg.headless === 'new' ? true : chromiumPkg.headless,
      });

      const profile = getProfile(url);
      const formattedContent = formatContent(profile.postType || 'auto', content);

      const ctx = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 900 },
        locale: 'en-US',
      });

      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        window.chrome = { runtime: {} };
      });

      const page = await ctx.newPage();
      page.setDefaultTimeout(timeout);

      // Login
      if (!profile.anonymous && credentials.username) {
        const loginUrl = typeof profile.loginUrl === 'function' ? profile.loginUrl(credentials) : profile.loginUrl;
        if (loginUrl) {
          await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(1200);

          const sel = profile.loginSelectors || {};
          if (sel.user) await safeFill(page, sel.user, credentials.username);
          if (sel.pass) {
            // Wait for password field (multi-step login)
            await page.waitForSelector(sel.pass, { timeout: 8000 }).catch(() => {});
            await safeFill(page, sel.pass, credentials.password || '');
          }
          if (sel.submit) await page.click(sel.submit).catch(() => {});
          await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
          await page.waitForTimeout(1000);
        }
      } else if (credentials.cookie) {
        const domain = new URL(url).hostname;
        const cookies = credentials.cookie.split(';').map(p => {
          const [n, ...v] = p.trim().split('=');
          return { name: n.trim(), value: v.join('=').trim(), domain, path: '/' };
        }).filter(c => c.name && c.value);
        await ctx.addCookies(cookies);
      }

      // Navigate to post URL
      const postUrl = typeof profile.postUrl === 'function' ? profile.postUrl(credentials) : (profile.postUrl || url);
      if (postUrl) {
        await page.goto(postUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
      }

      // Fill form
      const pSel = profile.postSelectors || {};
      const { title, body, tags } = formattedContent;

      if (pSel.title && title) await safeFill(page, pSel.title, title);

      if (pSel.body) {
        const el = await page.$(pSel.body);
        if (el) {
          const tag = await el.evaluate(e => e.tagName.toLowerCase());
          if (tag === 'textarea' || tag === 'input') await el.fill(body);
          else { await el.click(); await el.type(body, { delay: 6 }); }
        }
      }

      if (pSel.tags && tags) await safeFill(page, pSel.tags, tags);

      // Dismiss banners
      for (const bSel of ['button:has-text("Accept")', 'button:has-text("Allow")', '#accept-cookies']) {
        try { const el = await page.$(bSel); if (el && await el.isVisible()) { await el.click(); break; } } catch (_) {}
      }

      if (pSel.submitKey) {
        const [mod, key] = pSel.submitKey.split('+');
        await page.keyboard.press(`${mod.charAt(0).toUpperCase() + mod.slice(1)}+${key.toUpperCase()}`);
        await page.waitForTimeout(2000);
      } else if (pSel.submit) {
        const sub = await page.$(pSel.submit);
        if (sub) { await sub.scrollIntoViewIfNeeded(); await sub.click(); }
        await page.waitForNavigation({ waitUntil: 'networkidle', timeout }).catch(() => {});
      }

      await page.waitForTimeout(1000);

      const finalUrl  = page.url();
      const pageTitle = await page.title().catch(() => '');

      // Detect success
      const sp = pSel.successPattern;
      const success = sp ? (sp instanceof RegExp ? sp.test(finalUrl) : finalUrl.includes(sp)) : true;

      await ctx.close().catch(() => {});

      return {
        ok: success,
        method: fallbackReason || 'playwright',
        resultUrl: finalUrl,
        resultTitle: pageTitle,
      };

    } finally {
      if (browser) await browser.close().catch(() => {});
    }

  } catch (err) {
    return { ok: false, method: fallbackReason || 'playwright', error: err.message };
  }
}

// ─── REST API HANDLERS (inline, fast path) ────────────────────────────────────

const REST_HANDLERS = {

  'pastebin.com': async (url, creds, content) => {
    const params = new URLSearchParams({
      api_dev_key: creds.token || creds.api_key,
      api_option: 'paste',
      api_paste_code: content.body || '',
      api_paste_name: content.title || '',
      api_paste_expire_date: 'N',
      api_paste_private: '0',
      ...(creds.username ? { api_user_name: creds.username, api_user_password: creds.password || '' } : {}),
    });
    const r = await fetch('https://pastebin.com/api/api_post.php', { method: 'POST', body: params.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const text = await r.text();
    if (text.startsWith('Bad API Request')) throw new Error(text);
    return { resultUrl: text.trim() };
  },

  'dev.to': async (url, creds, content) => {
    const r = await fetch('https://dev.to/api/articles', {
      method: 'POST',
      headers: { 'api-key': creds.token || creds.api_key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ article: { title: content.title, body_markdown: content.body, published: true, tags: (content.tags || '').split(',').map(t => t.trim()).slice(0, 4) } }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'dev.to API error');
    return { resultUrl: data.url };
  },

  'medium.com': async (url, creds, content) => {
    // Get user ID first
    const me = await fetch('https://api.medium.com/v1/me', { headers: { Authorization: `Bearer ${creds.token}` } });
    const meData = await me.json();
    const userId = meData.data?.id;
    if (!userId) throw new Error('Could not get Medium user ID');
    const r = await fetch(`https://api.medium.com/v1/users/${userId}/posts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: content.title, contentFormat: 'markdown', content: content.body, publishStatus: 'public', tags: (content.tags || '').split(',').map(t => t.trim()).slice(0, 5) }),
    });
    const data = await r.json();
    if (!r.ok || !data.data) throw new Error(data.errors?.[0]?.message || 'Medium API error');
    return { resultUrl: data.data.url };
  },

  'hashnode.com': async (url, creds, content) => {
    // Auto-fetch publicationId if not provided
    let publicationId = creds.publicationId || '';
    if (!publicationId) {
      const meRes = await fetch('https://gql.hashnode.com', {
        method: 'POST',
        headers: { Authorization: creds.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: `{ me { publications(first: 1) { edges { node { id } } } } }` }),
      });
      const meData = await meRes.json().catch(() => ({}));
      publicationId = meData.data?.me?.publications?.edges?.[0]?.node?.id || '';
    }
    if (!publicationId) throw new Error('hashnode.com: publicationId required — add it to your credentials or the auto-fetch failed');

    const r = await fetch('https://gql.hashnode.com', {
      method: 'POST',
      headers: { Authorization: creds.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `mutation PublishPost($input: PublishPostInput!) { publishPost(input: $input) { post { url } } }`,
        variables: {
          input: {
            title: content.title || 'Post',
            contentMarkdown: content.body || '',
            publicationId,
            tags: [],
          },
        },
      }),
    });
    const data = await r.json();
    if (data.errors) throw new Error(data.errors[0].message);
    return { resultUrl: data.data?.publishPost?.post?.url || 'https://hashnode.com' };
  },

  'write.as': async (url, creds, content) => {
    const headers = { 'Content-Type': 'application/json' };
    if (creds.token) headers.Authorization = `Token ${creds.token}`;
    const r = await fetch('https://write.as/api/posts', {
      method: 'POST',
      headers,
      body: JSON.stringify({ body: content.body, title: content.title, lang: 'en', rtl: false }),
    });
    const data = await r.json();
    if (!r.ok || !data.data) throw new Error('write.as API error');
    return { resultUrl: `https://write.as/${data.data.id}` };
  },

  'telegra.ph': async (url, creds, content) => {
    const nodes = (content.body || '').split('\n\n').filter(Boolean).map(p => ({ tag: 'p', children: [p] }));
    const accessToken = creds.token || '';
    const params = new URLSearchParams({
      ...(accessToken ? { access_token: accessToken } : {}),
      title: content.title || 'Post',
      content: JSON.stringify(nodes),
      author_name: creds.username || 'Author',
    });
    const r = await fetch(`https://api.telegra.ph/createPage?${params}`);
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'Telegraph error');
    return { resultUrl: data.result.url };
  },

  'dpaste.com': async (url, creds, content) => {
    const r = await fetch('https://dpaste.com/api/v2/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ content: content.body, title: content.title || '', syntax: 'text', expiry_days: 365 }).toString(),
    });
    if (!r.ok) throw new Error('dpaste API error');
    return { resultUrl: r.url || r.headers.get('location') || 'https://dpaste.com' };
  },

  'controlc.com': async (url, creds, content) => {
    const r = await fetch('https://controlc.com/index.php?act=submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://controlc.com' },
      body: new URLSearchParams({ 'subdomain-name': '', 'paste_data': content.body, 'private': '0' }).toString(),
      redirect: 'manual',
    });
    const loc = r.headers.get('location') || r.url;
    return { resultUrl: loc };
  },

  'rentry.co': async (url, creds, content) => {
    // Fetch homepage to get CSRF token + session cookie
    const homeRes = await fetch('https://rentry.co', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await homeRes.text();
    // Try multiple CSRF extraction patterns (rentry has changed their HTML before)
    const csrf =
      (html.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/) ||
       html.match(/csrfmiddlewaretoken['":\s]+['"]([a-zA-Z0-9]{20,})/))?.[1] || '';
    const rawCookies = homeRes.headers.get('set-cookie') || '';
    const sessionCookie = rawCookies.match(/csrftoken=([^;]+)/)?.[1] || '';

    const r = await fetch('https://rentry.co/api/new', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://rentry.co',
        'X-CSRFToken': csrf,
        'Cookie': `csrftoken=${sessionCookie}`,
      },
      body: new URLSearchParams({ csrfmiddlewaretoken: csrf, text: content.body || ' ', edit_code: '' }).toString(),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = {}; }
    if (data.url) return { resultUrl: data.url };
    // Try extracting from redirect or HTML
    const locHeader = r.headers.get('location');
    if (locHeader) return { resultUrl: locHeader.startsWith('http') ? locHeader : 'https://rentry.co' + locHeader };
    throw new Error(`rentry.co: ${data.content || text || 'unknown error'}`);
  },

  'hastebin.com': async (url, creds, content) => {
    // hastebin.com changed to toptal-hosted; try both with correct URL format
    const endpoints = [
      { api: 'https://hastebin.com/documents', base: 'https://hastebin.com/' },
      { api: 'https://www.toptal.com/developers/hastebin/documents', base: 'https://www.toptal.com/developers/hastebin/' },
    ];
    for (const ep of endpoints) {
      try {
        const r = await fetch(ep.api, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain', 'User-Agent': 'Mozilla/5.0' },
          body: content.body || ' ',
        });
        if (!r.ok) continue;
        const data = await r.json();
        const key = data.key || data.Key;
        if (key) return { resultUrl: ep.base + key };
      } catch (_) {}
    }
    // Last resort: controlc as paste fallback
    throw new Error('hastebin: all endpoints failed');
  },

  // ── NOTES.IO ── anonymous paste
  'notes.io': async (url, creds, content) => {
    const r = await fetch('https://notes.io/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://notes.io/' },
      body: new URLSearchParams({ text: content.body || '', password: '' }).toString(),
      redirect: 'manual',
    });
    const loc = r.headers.get('location') || r.url;
    if (!loc || loc === 'https://notes.io/') throw new Error('notes.io: no redirect URL');
    return { resultUrl: loc };
  },

  // ── PASTELINK.NET ── anonymous paste
  'pastelink.net': async (url, creds, content) => {
    // pastelink uses a simple POST form
    const r = await fetch('https://pastelink.net/api/paste', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content.body || '', unique_key: '', password: '' }),
    });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      if (data.unique_key) return { resultUrl: `https://pastelink.net/${data.unique_key}` };
    }
    // Fallback: form submission
    const r2 = await fetch('https://pastelink.net/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://pastelink.net/' },
      body: new URLSearchParams({ paste_data: content.body || '', paste_title: content.title || '', paste_expire: '1m', paste_type: 'text' }).toString(),
      redirect: 'manual',
    });
    const loc = r2.headers.get('location') || '';
    if (!loc) throw new Error('pastelink.net: no redirect URL');
    return { resultUrl: loc.startsWith('http') ? loc : 'https://pastelink.net' + loc };
  },

  // ── 0BIN.NET ── anonymous paste (PrivateBin protocol)
  '0bin.net': async (url, creds, content) => {
    // 0bin.net uses PrivateBin/ZeroBin encryption; direct REST is complex.
    // Use the simple form endpoint instead.
    const r = await fetch('https://0bin.net/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://0bin.net/' },
      body: new URLSearchParams({ content: content.body || ' ', expiration: 'burn_after_reading' }).toString(),
      redirect: 'manual',
    });
    const loc = r.headers.get('location') || r.url;
    if (loc && loc !== 'https://0bin.net/') return { resultUrl: loc.startsWith('http') ? loc : 'https://0bin.net' + loc };
    throw new Error('0bin.net: paste failed');
  },

  // ── IDEONE.COM ── code paste (anonymous API)
  'ideone.com': async (url, creds, content) => {
    // ideone has a SOAP-like API; use the form submission path
    const homePage = await fetch('https://ideone.com/', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await homePage.text();
    const csrfMatch = html.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/);
    const csrf = csrfMatch ? csrfMatch[1] : '';
    const cookie = homePage.headers.get('set-cookie')?.match(/csrftoken=([^;]+)/)?.[1] || '';

    const r = await fetch('https://ideone.com/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://ideone.com/',
        'Cookie': `csrftoken=${cookie}`,
      },
      body: new URLSearchParams({
        csrfmiddlewaretoken: csrf,
        source: content.body || ' ',
        lang: '116',  // Plain Text
        input: '',
        private: 'on',
        'save-code': 'Save',
      }).toString(),
      redirect: 'manual',
    });
    const loc = r.headers.get('location') || '';
    if (loc && loc !== '/') return { resultUrl: loc.startsWith('http') ? loc : 'https://ideone.com' + loc };
    throw new Error('ideone.com: paste failed');
  },

  // ── PASTE.MOZILLA.ORG ── anonymous paste (dpaste variant)
  'paste.mozilla.org': async (url, creds, content) => {
    const r = await fetch('https://paste.mozilla.org/api/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        content: content.body || ' ',
        syntax: 'text',
        expiry_days: '30',
        title: content.title || '',
      }).toString(),
    });
    if (r.ok) {
      // API returns plain URL or JSON
      const text = await r.text();
      try { const d = JSON.parse(text); if (d.url || d.link) return { resultUrl: d.url || d.link }; } catch (_) {}
      if (text.startsWith('http')) return { resultUrl: text.trim() };
    }
    // Form fallback
    const r2 = await fetch('https://paste.mozilla.org/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://paste.mozilla.org/' },
      body: new URLSearchParams({ content: content.body || ' ', syntax: 'text', title: content.title || '' }).toString(),
      redirect: 'manual',
    });
    const loc = r2.headers.get('location') || '';
    if (loc) return { resultUrl: loc.startsWith('http') ? loc : 'https://paste.mozilla.org' + loc };
    throw new Error('paste.mozilla.org: paste failed');
  },

  // ── WIKI.GG ── requires wiki subdomain + login; use API
  'wiki.gg': async (url, creds, content) => {
    // wiki.gg is MediaWiki-based; POST to their action API
    const wikiBase = creds.wikiBase || 'https://wiki.gg';
    const api = `${wikiBase}/api.php`;

    // Step 1: Get login token
    const tokenRes = await fetch(`${api}?action=query&meta=tokens&type=login&format=json`, {
      headers: { 'User-Agent': 'SEOBot/1.0' },
    });
    const tokenData = await tokenRes.json();
    const loginToken = tokenData?.query?.tokens?.logintoken;

    // Step 2: Login
    const loginRes = await fetch(api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SEOBot/1.0' },
      body: new URLSearchParams({ action: 'login', lgname: creds.username || '', lgpassword: creds.password || '', lgtoken: loginToken || '', format: 'json' }).toString(),
    });
    const loginCookies = loginRes.headers.get('set-cookie') || '';

    // Step 3: Get CSRF token
    const csrfRes = await fetch(`${api}?action=query&meta=tokens&format=json`, {
      headers: { 'Cookie': loginCookies, 'User-Agent': 'SEOBot/1.0' },
    });
    const csrfData = await csrfRes.json();
    const csrf = csrfData?.query?.tokens?.csrftoken;

    // Step 4: Edit/create page
    const title = (content.title || 'SEO_Post').replace(/ /g, '_');
    const editRes = await fetch(api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': loginCookies, 'User-Agent': 'SEOBot/1.0' },
      body: new URLSearchParams({ action: 'edit', title, text: content.body || '', token: csrf || '', format: 'json', summary: 'SEO post', createonly: 'true' }).toString(),
    });
    const editData = await editRes.json();
    if (editData.edit?.result === 'Success') return { resultUrl: `${wikiBase}/wiki/${title}` };
    throw new Error(`wiki.gg edit failed: ${JSON.stringify(editData.error || editData.edit)}`);
  },

  // ── FANDOM.COM ── MediaWiki API (same as wiki.gg)
  'fandom.com': async (url, creds, content) => {
    const wikiBase = creds.wikiBase || 'https://www.fandom.com';
    const api = `${wikiBase}/api.php`;

    const tokenRes = await fetch(`${api}?action=query&meta=tokens&type=login&format=json`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const tokenData = await tokenRes.json().catch(() => ({}));
    const loginToken = tokenData?.query?.tokens?.logintoken || '';
    const cookies1 = tokenRes.headers.get('set-cookie') || '';

    const loginRes = await fetch(api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookies1, 'User-Agent': 'Mozilla/5.0' },
      body: new URLSearchParams({ action: 'login', lgname: creds.username || '', lgpassword: creds.password || '', lgtoken: loginToken, format: 'json' }).toString(),
    });
    const cookies2 = [cookies1, loginRes.headers.get('set-cookie') || ''].join('; ');

    const csrfRes = await fetch(`${api}?action=query&meta=tokens&format=json`, { headers: { 'Cookie': cookies2, 'User-Agent': 'Mozilla/5.0' } });
    const csrfData = await csrfRes.json().catch(() => ({}));
    const csrf = csrfData?.query?.tokens?.csrftoken || '+\\';

    const title = (content.title || 'SEO_Post').replace(/ /g, '_');
    const editRes = await fetch(api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookies2, 'User-Agent': 'Mozilla/5.0' },
      body: new URLSearchParams({ action: 'edit', title, text: content.body || '', token: csrf, format: 'json', summary: 'New post', createonly: 'true' }).toString(),
    });
    const editData = await editRes.json().catch(() => ({}));
    if (editData.edit?.result === 'Success') return { resultUrl: `${wikiBase}/wiki/${title}` };
    throw new Error(`fandom.com edit failed: ${JSON.stringify(editData.error || {})}`);
  },

  // ── WIKIDOT.COM ── AJAX API
  'wikidot.com': async (url, creds, content) => {
    // wikidot uses a custom AJAX API at /ajax-module-connector.php
    const siteDomain = creds.siteDomain || url; // e.g. https://mysite.wikidot.com
    const apiUrl = siteDomain.replace(/\/?$/, '/ajax-module-connector.php');

    // Login to get session cookies
    const loginRes = await fetch('https://www.wikidot.com/default--flow/login__LoginPopupScreen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
      body: new URLSearchParams({ login: creds.username || '', password: creds.password || '', action: 'Login2Action', event: 'login' }).toString(),
    });
    const cookieHeader = loginRes.headers.get('set-cookie') || '';

    const pageTitle = (content.title || 'seo-post').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const createRes = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookieHeader, 'User-Agent': 'Mozilla/5.0' },
      body: new URLSearchParams({ action: 'WikiPageAction', event: 'savePage', wiki_page: pageTitle, source: content.body || '', comments: '', title: content.title || pageTitle }).toString(),
    });
    const data = await createRes.json().catch(() => ({}));
    if (data.status === 'ok') return { resultUrl: `${siteDomain}/${pageTitle}` };
    throw new Error(`wikidot.com: ${data.message || 'page save failed'}`);
  },

  // ── PBWORKS.COM ── PBwiki API / form post
  'pbworks.com': async (url, creds, content) => {
    // pbworks doesn't have a public API; use their form submission
    const wikiBase = creds.wikiBase || url; // e.g. https://mysite.pbworks.com
    const pageTitle = (content.title || 'SEOPost').replace(/ /g, '+');

    // Login
    const loginRes = await fetch('https://my.pbworks.com/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://my.pbworks.com/', 'User-Agent': 'Mozilla/5.0' },
      body: new URLSearchParams({ login: creds.username || '', password: creds.password || '' }).toString(),
      redirect: 'manual',
    });
    const cookies = loginRes.headers.get('set-cookie') || '';

    // Create page via their API endpoint
    const createUrl = `${wikiBase}/api/page`;
    const r = await fetch(createUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookies, 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({ name: content.title || 'SEOPost', body: content.body || '' }),
    });
    if (r.ok) {
      const d = await r.json().catch(() => ({}));
      return { resultUrl: d.url || `${wikiBase}/${pageTitle}` };
    }
    throw new Error(`pbworks.com: page creation failed (${r.status})`);
  },

  'paste.ee': async (url, creds, content) => {
    const r = await fetch('https://paste.ee/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': creds.token || creds.api_key || '' },
      body: JSON.stringify({ description: content.title || '', sections: [{ name: 'main', syntax: 'text', contents: content.body }] }),
    });
    const data = await r.json();
    if (!data.success) throw new Error(data.error || 'paste.ee error');
    return { resultUrl: data.paste?.link || 'https://paste.ee' };
  },

  'hackmd.io': async (url, creds, content) => {
    const r = await fetch('https://api.hackmd.io/v1/notes', {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: content.title, content: content.body, readPermission: 'guest', writePermission: 'owner', commentPermission: 'everyone' }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || 'HackMD error');
    return { resultUrl: `https://hackmd.io/${data.id}` };
  },

  // ── GHOST.IO ── Admin Content API
  'ghost.io': async (url, creds, content) => {
    // Ghost Admin API: POST /ghost/api/admin/posts/
    // creds: { subdomain, token } — token is Admin API key (id:secret format)
    const subdomain = creds.subdomain || new URL(url.startsWith('http') ? url : 'https://' + url).hostname.split('.')[0];
    const base = `https://${subdomain}.ghost.io`;
    const adminKey = creds.token || creds.api_key || '';
    if (!adminKey) throw new Error('ghost.io: Admin API key required (id:secret format)');

    // Split key into id + secret, create JWT
    const [keyId, keySecret] = adminKey.split(':');
    if (!keyId || !keySecret) throw new Error('ghost.io: token must be "id:secret" format from Admin API settings');

    // Ghost uses HS256 JWT — build manually without jwt lib
    const now = Math.floor(Date.now() / 1000);
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: keyId })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const payload = btoa(JSON.stringify({ iat: now, exp: now + 300, aud: '/admin/' })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const sigInput = `${header}.${payload}`;

    // Use Web Crypto to sign
    const secretBytes = new Uint8Array(keySecret.match(/.{2}/g).map(b => parseInt(b, 16)));
    const cryptoKey = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(sigInput));
    const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const jwt = `${sigInput}.${sig}`;

    const r = await fetch(`${base}/ghost/api/admin/posts/`, {
      method: 'POST',
      headers: { Authorization: `Ghost ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ posts: [{ title: content.title || 'Post', lexical: JSON.stringify({ root: { children: [{ children: [{ detail: 0, format: 0, mode: 'normal', style: '', text: content.body || '', type: 'text', version: 1 }], direction: 'ltr', format: '', indent: 0, type: 'paragraph', version: 1 }], direction: 'ltr', format: '', indent: 0, type: 'root', version: 1 } }), status: 'published' }] }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.errors?.[0]?.message || 'ghost.io API error');
    return { resultUrl: data.posts?.[0]?.url || base };
  },

  // ── WORDPRESS.COM ── REST API v1.1
  'wordpress.com': async (url, creds, content) => {
    // Requires OAuth token from WordPress.com developer app
    // creds: { token, siteId } — siteId = site domain or numeric ID
    const token = creds.token || creds.api_key;
    if (!token) throw new Error('wordpress.com: OAuth token required');
    const siteId = creds.siteId || creds.site_id || 'me';
    const r = await fetch(`https://public-api.wordpress.com/rest/v1.1/sites/${siteId}/posts/new`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: content.title || 'Post', content: content.body || '', status: 'publish', format: 'standard', tags: content.tags || '' }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || 'wordpress.com API error');
    return { resultUrl: data.URL || data.url || 'https://wordpress.com' };
  },

  // ── BLOGGER.COM ── Blogger API v3
  'blogger.com': async (url, creds, content) => {
    // creds: { token, blogId } — token = Google OAuth2 access token
    const token = creds.token || creds.api_key;
    if (!token) throw new Error('blogger.com: Google OAuth2 token required');
    const blogId = creds.blogId || creds.blog_id;
    if (!blogId) throw new Error('blogger.com: blogId required');
    const r = await fetch(`https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'blogger#post', title: content.title || 'Post', content: content.body || '' }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || 'blogger.com API error');
    return { resultUrl: data.url || 'https://blogger.com' };
  },

  // ── TUMBLR.COM ── Tumblr API v2
  'tumblr.com': async (url, creds, content) => {
    // creds: { token, blogName } — token = OAuth2 Bearer token from Tumblr app
    const token = creds.token || creds.api_key;
    if (!token) throw new Error('tumblr.com: OAuth token required');
    const blogName = creds.blogName || creds.blog_name || creds.username;
    if (!blogName) throw new Error('tumblr.com: blogName required');
    const r = await fetch(`https://api.tumblr.com/v2/blog/${blogName}.tumblr.com/posts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: [{ type: 'text', text: `# ${content.title || ''}\n\n${content.body || ''}` }], state: 'published', tags: (content.tags || '').split(',').map(t => t.trim()).filter(Boolean) }),
    });
    const data = await r.json();
    if (data.meta?.status !== 201 && !data.response?.id_string) throw new Error(data.meta?.msg || 'tumblr.com API error');
    const postId = data.response?.id_string || data.response?.id;
    return { resultUrl: `https://${blogName}.tumblr.com/post/${postId}` };
  },

  // ── SUBSTACK.COM ── Substack API (private but stable)
  'substack.com': async (url, creds, content) => {
    // creds: { subdomain, token } — token = substack-sid cookie value
    const subdomain = creds.subdomain || 'open';
    const cookieVal = creds.token || creds.cookie;
    if (!cookieVal) throw new Error('substack.com: substack-sid cookie token required');
    const base = `https://${subdomain}.substack.com`;

    // Create draft
    const draftRes = await fetch(`${base}/api/v1/drafts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `substack-sid=${cookieVal}` },
      body: JSON.stringify({ draft_title: content.title || 'Post', draft_body: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: content.body || '' }] }] }), type: 'newsletter', audience: 'everyone' }),
    });
    const draft = await draftRes.json();
    if (!draft.id) throw new Error(`substack.com: draft creation failed — ${JSON.stringify(draft)}`);

    // Publish
    const pubRes = await fetch(`${base}/api/v1/drafts/${draft.id}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `substack-sid=${cookieVal}` },
      body: JSON.stringify({ send: false, share_automatically: true }),
    });
    const pub = await pubRes.json();
    return { resultUrl: pub.canonical_url || `${base}/p/${draft.slug || draft.id}` };
  },

  // ── LIVEJOURNAL.COM ── XML-RPC API
  'livejournal.com': async (url, creds, content) => {
    const xmlBody = `<?xml version="1.0"?>
<methodCall>
  <methodName>LJ.XMLRPC.postevent</methodName>
  <params><param><value><struct>
    <member><name>username</name><value><string>${creds.username || ''}</string></value></member>
    <member><name>password</name><value><string>${creds.password || ''}</string></value></member>
    <member><name>ver</name><value><int>1</int></value></member>
    <member><name>subject</name><value><string>${(content.title || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string></value></member>
    <member><name>event</name><value><string>${(content.body || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string></value></member>
    <member><name>security</name><value><string>public</string></value></member>
    <member><name>lineendings</name><value><string>unix</string></value></member>
    <member><name>year</name><value><int>${new Date().getFullYear()}</int></value></member>
    <member><name>mon</name><value><int>${new Date().getMonth() + 1}</int></value></member>
    <member><name>day</name><value><int>${new Date().getDate()}</int></value></member>
    <member><name>hour</name><value><int>${new Date().getHours()}</int></value></member>
    <member><name>min</name><value><int>${new Date().getMinutes()}</int></value></member>
  </struct></value></param></params>
</methodCall>`;
    const r = await fetch('https://www.livejournal.com/interface/xmlrpc', {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml', 'User-Agent': 'Mozilla/5.0' },
      body: xmlBody,
    });
    const text = await r.text();
    const itemIdMatch = text.match(/<name>itemid<\/name>\s*<value><int>(\d+)<\/int>/);
    if (!itemIdMatch) throw new Error(`livejournal.com: ${text.includes('fault') ? text.match(/<string>([^<]+)<\/string>/)?.[1] || 'post failed' : 'no itemid in response'}`);
    return { resultUrl: `https://${creds.username}.livejournal.com/${itemIdMatch[1]}.html` };
  },

  // ── VOCAL.MEDIA ── GraphQL API
  'vocal.media': async (url, creds, content) => {
    // creds: { token } — Bearer token from Vocal account
    const token = creds.token;
    if (!token) throw new Error('vocal.media: Bearer token required');
    const r = await fetch('https://vocal.media/api/stories', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: content.title || 'Post', body: content.body || '', genre: creds.genre || 'education', status: 'published' }),
    });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      return { resultUrl: data.url || data.story?.url || 'https://vocal.media' };
    }
    throw new Error(`vocal.media: API error ${r.status}`);
  },

  // ── WATTPAD.COM ── Wattpad API
  'wattpad.com': async (url, creds, content) => {
    const token = creds.token;
    if (!token) throw new Error('wattpad.com: OAuth token required');
    // Create story first
    const storyRes = await fetch('https://www.wattpad.com/api/v3/stories', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: content.title || 'Post', language: { id: 1 }, categories: [9], isPublished: true }),
    });
    const story = await storyRes.json();
    if (!story.id) throw new Error(`wattpad.com: story creation failed — ${JSON.stringify(story)}`);

    // Add chapter
    const partRes = await fetch(`https://www.wattpad.com/api/v3/stories/${story.id}/parts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: content.title || 'Chapter 1', text: content.body || '', draft: false }),
    });
    const part = await partRes.json();
    return { resultUrl: `https://www.wattpad.com/story/${story.id}` };
  },

  // ── HUBPAGES.COM ── form-based (no public API; cookie auth)
  'hubpages.com': async (url, creds, content) => {
    const token = creds.token; // session cookie value
    if (!token) throw new Error('hubpages.com: session token/cookie required');
    const r = await fetch('https://hubpages.com/api/hub', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `sess=${token}` },
      body: JSON.stringify({ title: content.title || 'Post', summary: (content.body || '').substring(0, 200), capsules: [{ type: 'text', body: content.body || '' }], published: true }),
    });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      return { resultUrl: data.url || 'https://hubpages.com' };
    }
    throw new Error(`hubpages.com: API error ${r.status}`);
  },

  // ── CLICK4R.COM ── session-cookie based API
  'click4r.com': async (url, creds, content) => {
    // Login to get session cookie
    const loginRes = await fetch('https://www.click4r.com/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://www.click4r.com/', 'User-Agent': 'Mozilla/5.0' },
      body: new URLSearchParams({ email: creds.username || creds.email || '', password: creds.password || '', remember: '1' }).toString(),
      redirect: 'manual',
    });
    const cookies = loginRes.headers.get('set-cookie') || '';
    if (!cookies) throw new Error('click4r.com: login failed — no session cookie');

    // Post content
    const postRes = await fetch('https://www.click4r.com/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookies, 'Referer': 'https://www.click4r.com/', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({ title: content.title || 'Post', body: content.body || '', status: 'published', tags: content.tags || '' }),
    });
    if (postRes.ok) {
      const data = await postRes.json().catch(() => ({}));
      return { resultUrl: data.url || data.permalink || 'https://www.click4r.com' };
    }
    // Try form-based fallback
    const formRes = await fetch('https://www.click4r.com/posts/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies, 'Referer': 'https://www.click4r.com/', 'User-Agent': 'Mozilla/5.0' },
      body: new URLSearchParams({ title: content.title || 'Post', body: content.body || '', status: 'published' }).toString(),
      redirect: 'manual',
    });
    const loc = formRes.headers.get('location') || '';
    return { resultUrl: loc ? (loc.startsWith('http') ? loc : 'https://www.click4r.com' + loc) : 'https://www.click4r.com' };
  },

  // ── DIIGO.COM ── Diigo API v3
  'diigo.com': async (url, creds, content) => {
    // creds: { username, token } — token = API key from diigo.com/api_keys
    const token = creds.token || creds.api_key;
    if (!token) throw new Error('diigo.com: API key required from diigo.com/api_keys');
    // Diigo bookmarks API — save a link with annotation
    const targetUrl = (content.links && content.links[0]?.url) || 'https://www.google.com';
    const r = await fetch(`https://secure.diigo.com/api/v2/bookmarks`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${creds.username}:${token}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ url: targetUrl, title: content.title || 'Post', desc: (content.body || '').substring(0, 1000), tags: (content.tags || 'seo').replace(/,\s*/g, ','), shared: 'yes' }).toString(),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) return { resultUrl: `https://www.diigo.com/user/${creds.username}` };
    throw new Error(data.message || `diigo.com: error ${r.status}`);
  },

  // ── MIX.COM ── Mix bookmarking API
  'mix.com': async (url, creds, content) => {
    const token = creds.token;
    if (!token) throw new Error('mix.com: API token required');
    const targetUrl = (content.links && content.links[0]?.url) || url;
    const r = await fetch('https://mix.com/api/v2/saves', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: targetUrl, title: content.title || '', description: (content.body || '').substring(0, 500) }),
    });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      return { resultUrl: data.url || data.permalink || 'https://mix.com' };
    }
    throw new Error(`mix.com: API error ${r.status}`);
  },

  // ── PINTEREST.COM ── Pinterest API v5
  'pinterest.com': async (url, creds, content) => {
    const token = creds.token;
    if (!token) throw new Error('pinterest.com: OAuth token required');
    const boardId = creds.boardId || creds.board_id;
    if (!boardId) throw new Error('pinterest.com: boardId required');
    const r = await fetch('https://api.pinterest.com/v5/pins', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ board_id: boardId, title: content.title || 'Pin', description: (content.body || '').substring(0, 500), link: (content.links && content.links[0]?.url) || 'https://example.com', media_source: { source_type: 'image_url', url: creds.imageUrl || 'https://via.placeholder.com/600x400.png?text=Pin' } }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || 'pinterest.com API error');
    return { resultUrl: `https://www.pinterest.com/pin/${data.id}` };
  },

  // ── PRLOG.ORG ── Press release (form-based, no public API)
  'prlog.org': async (url, creds, content) => {
    // Login
    const loginRes = await fetch('https://www.prlog.org/login.html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://www.prlog.org/', 'User-Agent': 'Mozilla/5.0' },
      body: new URLSearchParams({ email: creds.username || creds.email || '', password: creds.password || '', action: 'login' }).toString(),
      redirect: 'manual',
    });
    const cookies = loginRes.headers.get('set-cookie') || '';

    // Submit press release
    const submitRes = await fetch('https://www.prlog.org/submit/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies, 'Referer': 'https://www.prlog.org/', 'User-Agent': 'Mozilla/5.0' },
      body: new URLSearchParams({ headline: content.title || 'Press Release', summary: (content.body || '').substring(0, 300), body: content.body || '', action: 'submit', agree: '1' }).toString(),
      redirect: 'manual',
    });
    const loc = submitRes.headers.get('location') || '';
    return { resultUrl: loc ? (loc.startsWith('http') ? loc : 'https://www.prlog.org' + loc) : 'https://www.prlog.org' };
  },

  // ── OPENPR.COM ── Press release (form-based)
  'openpr.com': async (url, creds, content) => {
    const loginRes = await fetch('https://www.openpr.com/account/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://www.openpr.com/', 'User-Agent': 'Mozilla/5.0' },
      body: new URLSearchParams({ email: creds.username || creds.email || '', password: creds.password || '' }).toString(),
      redirect: 'manual',
    });
    const cookies = loginRes.headers.get('set-cookie') || '';

    // Submit
    const r = await fetch('https://www.openpr.com/news/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies, 'Referer': 'https://www.openpr.com/', 'User-Agent': 'Mozilla/5.0' },
      body: new URLSearchParams({ headline: content.title || 'Press Release', abstract: (content.body || '').substring(0, 500), body: content.body || '', category: '14', submit: 'Submit Press Release' }).toString(),
      redirect: 'manual',
    });
    const loc = r.headers.get('location') || '';
    return { resultUrl: loc ? (loc.startsWith('http') ? loc : 'https://www.openpr.com' + loc) : 'https://www.openpr.com' };
  },

  // ── EINPRESSWIRE.COM ── (EIN Presswire REST API)
  'einpresswire.com': async (url, creds, content) => {
    const token = creds.token || creds.api_key;
    if (!token) throw new Error('einpresswire.com: API key required');
    const r = await fetch('https://www.einpresswire.com/api/1/news_releases', {
      method: 'POST',
      headers: { 'x-apikey': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ headline: content.title || 'Press Release', body: content.body || '', keywords: content.tags || '' }),
    });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      return { resultUrl: data.url || data.link || 'https://www.einpresswire.com' };
    }
    throw new Error(`einpresswire.com: ${r.status}`);
  },

  // ── EZINEARTICLES.COM ── (form-based, no public API)
  'ezinearticles.com': async (url, creds, content) => {
    const loginRes = await fetch('https://ezinearticles.com/?Member-Login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://ezinearticles.com/', 'User-Agent': 'Mozilla/5.0' },
      body: new URLSearchParams({ Email: creds.username || creds.email || '', Password: creds.password || '', action: 'login', submit: 'Login' }).toString(),
      redirect: 'manual',
    });
    const cookies = loginRes.headers.get('set-cookie') || '';
    const r = await fetch('https://ezinearticles.com/?Submit-Articles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies, 'Referer': 'https://ezinearticles.com/', 'User-Agent': 'Mozilla/5.0' },
      body: new URLSearchParams({ Title: content.title || 'Article', Body: content.body || '', action: 'submit', submit: 'Submit+Article' }).toString(),
      redirect: 'manual',
    });
    const loc = r.headers.get('location') || '';
    return { resultUrl: loc ? (loc.startsWith('http') ? loc : 'https://ezinearticles.com' + loc) : 'https://ezinearticles.com' };
  },

  // ── ARTICLEBASE.COM ── (form-based)
  'articlebase.com': async (url, creds, content) => {
    const loginRes = await fetch('https://www.articlebase.com/login.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://www.articlebase.com/', 'User-Agent': 'Mozilla/5.0' },
      body: new URLSearchParams({ login: creds.username || '', password: creds.password || '', submit: 'Login' }).toString(),
      redirect: 'manual',
    });
    const cookies = loginRes.headers.get('set-cookie') || '';
    const r = await fetch('https://www.articlebase.com/submit.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies, 'Referer': 'https://www.articlebase.com/', 'User-Agent': 'Mozilla/5.0' },
      body: new URLSearchParams({ title: content.title || '', body: content.body || '', submit: 'Submit' }).toString(),
      redirect: 'manual',
    });
    const loc = r.headers.get('location') || '';
    return { resultUrl: loc ? (loc.startsWith('http') ? loc : 'https://www.articlebase.com' + loc) : 'https://www.articlebase.com' };
  },

  // ── SCRIBD.COM ── upload via REST (requires upload flow)
  'scribd.com': async (url, creds, content) => {
    const token = creds.token;
    if (!token) throw new Error('scribd.com: session token required (cookie value)');
    // Scribd uses a multipart upload; create a minimal text file and upload
    const textBlob = content.body || '';
    const formData = new FormData();
    formData.append('session_key', token);
    formData.append('title', content.title || 'Document');
    formData.append('description', (content.body || '').substring(0, 500));
    formData.append('file', new Blob([textBlob], { type: 'text/plain' }), 'document.txt');
    const r = await fetch('https://api.scribd.com/api?method=docs.upload&api_key=' + (creds.api_key || ''), {
      method: 'POST',
      headers: { Authorization: `Basic ${btoa(token + ':')}` },
      body: formData,
    });
    const text = await r.text();
    const idMatch = text.match(/<doc_id>(\d+)<\/doc_id>/);
    if (idMatch) return { resultUrl: `https://www.scribd.com/document/${idMatch[1]}` };
    throw new Error(`scribd.com: upload failed`);
  },

  // ── ISSUU.COM ── Issuu API v2
  'issuu.com': async (url, creds, content) => {
    const token = creds.token || creds.api_key;
    if (!token) throw new Error('issuu.com: API token required');
    // Issuu requires document upload; create a minimal PDF-like content
    // Use their drafts API
    const r = await fetch('https://api.issuu.com/v2/drafts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: content.title || 'Document', description: (content.body || '').substring(0, 500), access: 'PUBLIC' }),
    });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      return { resultUrl: data.shareUrl || data.url || 'https://issuu.com' };
    }
    throw new Error(`issuu.com: API error ${r.status}`);
  },

  // ── SLIDESHARE.NET ── SlideShare upload API
  'slideshare.net': async (url, creds, content) => {
    // SlideShare requires actual file upload; use their legacy API
    const apiKey = creds.api_key || creds.token;
    const secret = creds.secret;
    if (!apiKey) throw new Error('slideshare.net: API key required');
    const ts = Math.floor(Date.now() / 1000).toString();
    const hashInput = secret + ts;
    // SHA1 hash using SubtleCrypto
    const msgBuf = new TextEncoder().encode(hashInput);
    const hashBuf = await crypto.subtle.digest('SHA-1', msgBuf);
    const hashHex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

    const params = new URLSearchParams({
      api_key: apiKey,
      ts,
      hash: hashHex,
      username: creds.username || '',
      password: creds.password || '',
      slideshow_title: content.title || 'Presentation',
      slideshow_description: (content.body || '').substring(0, 3000),
      slideshow_srcfile: 'https://via.placeholder.com/1280x960.png', // placeholder
      make_src_public: 'Y',
    });
    const r = await fetch('https://www.slideshare.net/api/2/upload_slideshow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const text = await r.text();
    const idMatch = text.match(/<SlideShowID>(\d+)<\/SlideShowID>/);
    if (idMatch) return { resultUrl: `https://www.slideshare.net/slideshow/${idMatch[1]}` };
    throw new Error(`slideshare.net: upload failed`);
  },

  // ── NOTION.SO ── Notion API
  'notion.so': async (url, creds, content) => {
    const token = creds.token || creds.api_key;
    if (!token) throw new Error('notion.so: Integration token required (secret_...)');
    const pageId = creds.pageId || creds.page_id;
    if (!pageId) throw new Error('notion.so: parent pageId required');
    const r = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({
        parent: { page_id: pageId },
        properties: { title: { title: [{ text: { content: content.title || 'Post' } }] } },
        children: (content.body || '').split('\n\n').filter(Boolean).map(p => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: p } }] } })),
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || 'notion.so API error');
    return { resultUrl: data.url || `https://notion.so/${data.id?.replace(/-/g, '')}` };
  },

  // ── WEEBLY.COM ── Weebly/Square API
  'weebly.com': async (url, creds, content) => {
    const token = creds.token || creds.api_key;
    if (!token) throw new Error('weebly.com: API token required');
    const siteId = creds.siteId || creds.site_id;
    if (!siteId) throw new Error('weebly.com: siteId required');
    const r = await fetch(`https://api.weebly.com/v1/user/sites/${siteId}/blogs/${creds.blogId || '1'}/posts`, {
      method: 'POST',
      headers: { 'X-Weebly-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ post_title: content.title || 'Post', post_body: content.body || '', published: true }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || 'weebly.com API error');
    return { resultUrl: data.post_url || `https://${creds.subdomain || 'mysite'}.weebly.com/blog` };
  },

  // ── STRIKINGLY.COM ── no public API; form-based via cookie
  'strikingly.com': async (url, creds, content) => {
    const token = creds.token; // _strikingly_session cookie
    if (!token) throw new Error('strikingly.com: session token required');
    const siteId = creds.siteId || creds.site_id;
    const r = await fetch(`https://www.strikingly.com/api/sites/${siteId}/blog_posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `_strikingly_session=${token}`, 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ blog_post: { title: content.title || 'Post', content: content.body || '', published: true } }),
    });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      return { resultUrl: data.url || data.permalink || 'https://www.strikingly.com' };
    }
    throw new Error(`strikingly.com: API error ${r.status}`);
  },

  // ── WIX.COM ── Wix Headless / Blog API
  'wix.com': async (url, creds, content) => {
    const token = creds.token;
    if (!token) throw new Error('wix.com: API token required');
    const r = await fetch('https://www.wixapis.com/blog/v3/posts', {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ post: { title: content.title || 'Post', richContent: { nodes: [{ type: 'PARAGRAPH', nodes: [{ type: 'TEXT', textData: { text: content.body || '', decorations: [] } }] }] }, status: 'PUBLISHED' } }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || 'wix.com API error');
    return { resultUrl: data.post?.url || 'https://www.wix.com' };
  },

  // ── JIMDO.COM ── no public REST API; use form submission with cookie
  'jimdo.com': async (url, creds, content) => {
    const token = creds.token;
    if (!token) throw new Error('jimdo.com: session cookie required');
    const siteDomain = creds.siteDomain || `${creds.subdomain || 'mysite'}.jimdofree.com`;
    const r = await fetch(`https://${siteDomain}/blog/new-entry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `JSESSIONID=${token}`, 'User-Agent': 'Mozilla/5.0', 'Referer': `https://${siteDomain}` },
      body: new URLSearchParams({ title: content.title || 'Post', text: content.body || '', action: 'save', published: 'true' }).toString(),
      redirect: 'manual',
    });
    const loc = r.headers.get('location') || '';
    return { resultUrl: loc ? (loc.startsWith('http') ? loc : `https://${siteDomain}` + loc) : `https://${siteDomain}/blog` };
  },

  // ── WEBNODE.COM ── no public API; form-based
  'webnode.com': async (url, creds, content) => {
    const token = creds.token;
    if (!token) throw new Error('webnode.com: session token required');
    const siteId = creds.siteId || creds.site_id;
    const r = await fetch(`https://www.webnode.com/manager/article/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `webnode_session=${token}`, 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({ siteId, title: content.title || 'Post', text: content.body || '', status: 'published' }),
    });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      return { resultUrl: data.url || 'https://www.webnode.com' };
    }
    throw new Error(`webnode.com: API error ${r.status}`);
  },

  // ════════════════════════════════════════════════════════════════════════════
  // ── NEW BATCH: 25 ADDITIONAL HIGH-DA SITES ──────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════════

  // ── TELEGRA.PH (Telegraph) ── simple anonymous rich-text publishing (DA 74)
  'telegra.ph': async (url, creds, content) => {
    // Can use an existing access_token or create a new account on the fly
    let accessToken = creds.token || '';
    if (!accessToken) {
      const accRes = await fetch('https://api.telegra.ph/createAccount?short_name=SEOBot&author_name=SEOBot');
      const acc = await accRes.json();
      if (acc.ok) accessToken = acc.result.access_token;
    }
    const nodes = (content.body || '').split('\n\n').filter(Boolean).map(p => ({ tag: 'p', children: [p] }));
    const params = new URLSearchParams({ access_token: accessToken, title: content.title || 'Post', content: JSON.stringify(nodes), author_name: creds.username || 'Author' });
    const r = await fetch(`https://api.telegra.ph/createPage?${params}`);
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'telegra.ph error');
    return { resultUrl: data.result.url };
  },

  // ── PASTE.FO ── anonymous paste (DA 50+)
  'paste.fo': async (url, creds, content) => {
    const r = await fetch('https://paste.fo/api/paste', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({ content: content.body || ' ', title: content.title || '', syntax: 'text', visibility: 'public' }),
    });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      if (data.url || data.id) return { resultUrl: data.url || `https://paste.fo/${data.id}` };
    }
    // form fallback
    const r2 = await fetch('https://paste.fo/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://paste.fo/', 'User-Agent': 'Mozilla/5.0' },
      body: new URLSearchParams({ content: content.body || ' ', title: content.title || '', syntax: 'text' }).toString(),
      redirect: 'manual',
    });
    const loc = r2.headers.get('location') || '';
    if (loc) return { resultUrl: loc.startsWith('http') ? loc : 'https://paste.fo' + loc };
    throw new Error('paste.fo: paste failed');
  },

  // ── PASTE.RS ── Rust-based anonymous paste (DA 45+)
  'paste.rs': async (url, creds, content) => {
    const r = await fetch('https://paste.rs/', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'User-Agent': 'Mozilla/5.0' },
      body: content.body || ' ',
    });
    if (r.ok) {
      const pasteUrl = r.url || r.headers.get('location') || '';
      // paste.rs returns the paste URL in the body
      const text = await r.text();
      return { resultUrl: text.trim().startsWith('http') ? text.trim() : pasteUrl || 'https://paste.rs' };
    }
    throw new Error(`paste.rs: ${r.status}`);
  },

  // ── PASTECODE.IO ── anonymous paste site (DA 48+)
  'pastecode.io': async (url, creds, content) => {
    const r = await fetch('https://pastecode.io/api/paste', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({ text: content.body || ' ', title: content.title || '', language: 'text', expiry: 'never', private: false }),
    });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      return { resultUrl: data.url || data.link || 'https://pastecode.io' };
    }
    throw new Error(`pastecode.io: ${r.status}`);
  },

  // ── GHOSTBIN.COM / GHB alternative ── (DA 45+)
  'ghostbin.co': async (url, creds, content) => {
    const r = await fetch('https://ghostbin.co/paste/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://ghostbin.co/', 'User-Agent': 'Mozilla/5.0' },
      body: new URLSearchParams({ text: content.body || ' ', lang: 'text', expire: 'never', password: '', title: content.title || '' }).toString(),
      redirect: 'manual',
    });
    const loc = r.headers.get('location') || r.url;
    if (loc && !loc.includes('new')) return { resultUrl: loc.startsWith('http') ? loc : 'https://ghostbin.co' + loc };
    throw new Error('ghostbin.co: paste failed');
  },

  // ── BITBUCKET.ORG ── Snippets API (DA 92)
  'bitbucket.org': async (url, creds, content) => {
    const token = creds.token || creds.api_key;
    const username = creds.username;
    if (!token || !username) throw new Error('bitbucket.org: username + token (app password) required');
    const r = await fetch(`https://api.bitbucket.org/2.0/snippets/${username}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: content.title || 'Snippet', is_private: false, files: { 'snippet.md': { content: content.body || ' ' } } }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || `bitbucket.org: ${r.status}`);
    return { resultUrl: data.links?.html?.href || `https://bitbucket.org/snippets/${username}/${data.id}` };
  },

  // ── GITLAB.COM ── Snippets API (DA 93)
  'gitlab.com': async (url, creds, content) => {
    const token = creds.token || creds.api_key;
    if (!token) throw new Error('gitlab.com: Personal Access Token required');
    const r = await fetch('https://gitlab.com/api/v4/snippets', {
      method: 'POST',
      headers: { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: content.title || 'Snippet', visibility: 'public', files: [{ file_path: 'snippet.md', content: content.body || ' ' }] }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || `gitlab.com: ${r.status}`);
    return { resultUrl: data.web_url || `https://gitlab.com/-/snippets/${data.id}` };
  },

  // ── GIST.GITHUB.COM ── GitHub Gists API (DA 97)
  'gist.github.com': async (url, creds, content) => {
    const token = creds.token || creds.api_key;
    if (!token) throw new Error('gist.github.com: GitHub Personal Access Token required');
    const r = await fetch('https://api.github.com/gists', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'SEOBot/1.0' },
      body: JSON.stringify({ description: content.title || 'Post', public: true, files: { 'post.md': { content: content.body || ' ' } } }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || `gist.github.com: ${r.status}`);
    return { resultUrl: data.html_url || `https://gist.github.com/${data.id}` };
  },

  // ── CODEPEN.IO ── Pen API (DA 90)
  'codepen.io': async (url, creds, content) => {
    // CodePen has no public REST API; use their form-based prefill URL as a deep link
    // For actual posting, use session cookie approach
    const token = creds.token; // codepen session cookie
    if (!token) throw new Error('codepen.io: session cookie required (_session)');
    const r = await fetch('https://codepen.io/pens/public', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': `_session=${token}`, 'X-Requested-With': 'XMLHttpRequest', 'Referer': 'https://codepen.io', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({ title: content.title || 'Post', html: content.body || ' ', css: '', js: '', is_public: true }),
    });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      return { resultUrl: data.url || data.permalink || 'https://codepen.io' };
    }
    throw new Error(`codepen.io: ${r.status}`);
  },

  // ── JSFIDDLE.NET ── JSFiddle API (DA 89)
  'jsfiddle.net': async (url, creds, content) => {
    // jsFiddle has a limited form-post API
    const r = await fetch('https://jsfiddle.net/api/post/library/pure/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://jsfiddle.net/', 'User-Agent': 'Mozilla/5.0' },
      body: new URLSearchParams({ title: content.title || 'Post', description: content.body || ' ', html: `<pre>${(content.body || '').replace(/</g, '&lt;')}</pre>`, css: '', js: '', resources: '' }).toString(),
      redirect: 'manual',
    });
    const loc = r.headers.get('location') || r.url;
    if (loc && loc !== 'https://jsfiddle.net/') return { resultUrl: loc.startsWith('http') ? loc : 'https://jsfiddle.net' + loc };
    throw new Error('jsfiddle.net: fiddle creation failed');
  },

  // ── MEDIUM.COM (via API) ── already exists but adding alias for app.medium.com
  'app.medium.com': async (url, creds, content) => {
    const token = creds.token;
    if (!token) throw new Error('medium.com: Integration token required');
    const me = await fetch('https://api.medium.com/v1/me', { headers: { Authorization: `Bearer ${token}` } });
    const meData = await me.json();
    const userId = meData.data?.id;
    if (!userId) throw new Error('medium.com: could not get user ID — check token');
    const r = await fetch(`https://api.medium.com/v1/users/${userId}/posts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: content.title || 'Post', contentFormat: 'markdown', content: content.body || '', publishStatus: 'public', tags: (content.tags || '').split(',').map(t => t.trim()).slice(0, 5) }),
    });
    const data = await r.json();
    if (!r.ok || !data.data) throw new Error(data.errors?.[0]?.message || 'medium.com API error');
    return { resultUrl: data.data.url };
  },

  // ── REDDIT.COM ── Reddit OAuth API (DA 96)
  'reddit.com': async (url, creds, content) => {
    const token = creds.token; // OAuth2 Bearer token — get from https://www.reddit.com/prefs/apps
    if (!token) throw new Error('reddit.com: OAuth2 Bearer token required');
    const subreddit = creds.subreddit || 'test';
    const r = await fetch('https://oauth.reddit.com/api/submit', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SEOBot/1.0' },
      body: new URLSearchParams({ sr: subreddit, kind: 'self', title: content.title || 'Post', text: content.body || '', resubmit: 'true', sendreplies: 'false' }).toString(),
    });
    const data = await r.json();
    if (data.json?.errors?.length) throw new Error(data.json.errors[0][1]);
    const postId = data.json?.data?.id;
    return { resultUrl: `https://www.reddit.com/r/${subreddit}/comments/${postId}` };
  },

  // ── QUORA.COM ── Quora Space post (session cookie auth) (DA 92)
  'quora.com': async (url, creds, content) => {
    const token = creds.token; // m-b cookie value from browser
    if (!token) throw new Error('quora.com: session cookie (m-b) required');
    const spaceId = creds.spaceId; // numeric Quora Space ID
    if (!spaceId) throw new Error('quora.com: spaceId required');
    // Quora uses GraphQL internally
    const r = await fetch('https://www.quora.com/graphql/gql_para_public?q=CreateSpacePost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `m-b=${token}`, 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.quora.com' },
      body: JSON.stringify({ queryName: 'CreateSpacePost', variables: { spaceId, title: content.title || '', content: { ops: [{ insert: content.body || '' }] } } }),
    });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      return { resultUrl: data?.data?.createSpacePost?.post?.url || 'https://www.quora.com' };
    }
    throw new Error(`quora.com: ${r.status}`);
  },

  // ── PEARLTREES.COM ── content aggregator (DA 72)
  'pearltrees.com': async (url, creds, content) => {
    const token = creds.token;
    if (!token) throw new Error('pearltrees.com: Bearer token required');
    const targetUrl = (content.links && content.links[0]?.url) || 'https://example.com';
    const r = await fetch('https://www.pearltrees.com/api/v2/pearls', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: targetUrl, title: content.title || '', description: (content.body || '').substring(0, 500) }),
    });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      return { resultUrl: data.url || data.permalink || 'https://www.pearltrees.com' };
    }
    throw new Error(`pearltrees.com: ${r.status}`);
  },

  // ── FOLKD.COM ── social bookmarking (DA 65)
  'folkd.com': async (url, creds, content) => {
    const loginRes = await fetch('https://www.folkd.com/user/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://www.folkd.com/', 'User-Agent': 'Mozilla/5.0' },
      body: new URLSearchParams({ 'User[login]': creds.username || '', 'User[password]': creds.password || '', 'User[rememberMe]': '1' }).toString(),
      redirect: 'manual',
    });
    const cookies = loginRes.headers.get('set-cookie') || '';
    const targetUrl = (content.links && content.links[0]?.url) || 'https://example.com';
    const r = await fetch('https://www.folkd.com/submit/go', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies, 'Referer': 'https://www.folkd.com/', 'User-Agent': 'Mozilla/5.0' },
      body: new URLSearchParams({ url: targetUrl, title: content.title || '', description: (content.body || '').substring(0, 400), tags: content.tags || 'seo' }).toString(),
      redirect: 'manual',
    });
    const loc = r.headers.get('location') || '';
    return { resultUrl: loc ? (loc.startsWith('http') ? loc : 'https://www.folkd.com' + loc) : 'https://www.folkd.com' };
  },

  // ── SLASHDOT.ORG ── journal entry (DA 90)
  'slashdot.org': async (url, creds, content) => {
    const token = creds.token; // session cookie (user_cookie)
    if (!token || !creds.uid) throw new Error('slashdot.org: uid + token (session cookie) required');
    const r = await fetch('https://slashdot.org/journal.pl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `user_cookie=${token}`, 'Referer': 'https://slashdot.org/', 'User-Agent': 'Mozilla/5.0' },
      body: new URLSearchParams({ op: 'edit', uid: creds.uid, id: '0', description: content.title || 'Journal Entry', article: content.body || '', submit: 'Save' }).toString(),
      redirect: 'manual',
    });
    const loc = r.headers.get('location') || '';
    return { resultUrl: loc ? (loc.startsWith('http') ? loc : 'https://slashdot.org' + loc) : 'https://slashdot.org' };
  },

  // ── KINJA.COM ── community blog (DA 85)
  'kinja.com': async (url, creds, content) => {
    const token = creds.token;
    if (!token) throw new Error('kinja.com: session token required');
    const r = await fetch('https://kinja.com/api/core/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({ headline: content.title || 'Post', body: { blocks: [{ type: 'BasicText', value: content.body || '' }] }, status: 'published' }),
    });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      return { resultUrl: data.canonicalUrl || data.url || 'https://kinja.com' };
    }
    throw new Error(`kinja.com: ${r.status}`);
  },

  // ── STORIFY.COM alternative: WAKELET.COM ── (DA 65)
  'wakelet.com': async (url, creds, content) => {
    const token = creds.token;
    if (!token) throw new Error('wakelet.com: Bearer token required');
    const r = await fetch('https://api.wakelet.com/bomb', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: content.title || 'Collection', description: content.body || '', visibility: 'public', items: content.links?.map(l => ({ url: l.url, title: l.label || l.url })) || [] }),
    });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      return { resultUrl: data.url || data.shareUrl || 'https://wakelet.com' };
    }
    throw new Error(`wakelet.com: ${r.status}`);
  },

  // ── INSTAPAPER.COM ── bookmarking (DA 79)
  'instapaper.com': async (url, creds, content) => {
    // Instapaper Simple API
    const targetUrl = (content.links && content.links[0]?.url) || 'https://example.com';
    const r = await fetch('https://www.instapaper.com/api/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
      body: new URLSearchParams({ username: creds.username || '', password: creds.password || '', url: targetUrl, title: content.title || '', selection: (content.body || '').substring(0, 500) }).toString(),
    });
    // Simple API returns 201 on success
    if (r.status === 201 || r.ok) return { resultUrl: `https://www.instapaper.com/u/${targetUrl}` };
    if (r.status === 403) throw new Error('instapaper.com: invalid credentials');
    throw new Error(`instapaper.com: ${r.status}`);
  },

  // ── POCKET.COM (GetPocket) ── bookmarking (DA 90)
  'getpocket.com': async (url, creds, content) => {
    const token = creds.token; // access_token from Pocket OAuth
    const consumerKey = creds.consumerKey || creds.api_key;
    if (!token || !consumerKey) throw new Error('getpocket.com: consumerKey + OAuth access_token required');
    const targetUrl = (content.links && content.links[0]?.url) || 'https://example.com';
    const r = await fetch('https://getpocket.com/v3/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Accept': 'application/json' },
      body: JSON.stringify({ url: targetUrl, title: content.title || '', consumer_key: consumerKey, access_token: token }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) return { resultUrl: `https://getpocket.com/read/${data.item?.item_id || ''}` };
    throw new Error(data.error || `getpocket.com: ${r.status}`);
  },

  // ── REBELMOUSE.COM ── media blog (DA 75)
  'rebelmouse.com': async (url, creds, content) => {
    const token = creds.token;
    if (!token) throw new Error('rebelmouse.com: API token required');
    const r = await fetch('https://www.rebelmouse.com/api/1/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Token ${token}` },
      body: JSON.stringify({ headline: content.title || 'Post', text: content.body || '', site_id: creds.siteId || '', published: true }),
    });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      return { resultUrl: data.url || data.permalink || 'https://www.rebelmouse.com' };
    }
    throw new Error(`rebelmouse.com: ${r.status}`);
  },

  // ── SKYROCK.COM ── French blog network (DA 80)
  'skyrock.com': async (url, creds, content) => {
    const loginRes = await fetch('https://login.skyrock.com/api/login_check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
      body: new URLSearchParams({ username: creds.username || '', password: creds.password || '', format: 'json' }).toString(),
    });
    const loginData = await loginRes.json().catch(() => ({}));
    const token = loginData.auth_token || loginData.token || '';
    if (!token) throw new Error('skyrock.com: login failed');
    const r = await fetch('https://api.skyrock.com/v2/blog/post.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${token}` },
      body: new URLSearchParams({ title: content.title || 'Post', message: content.body || '', category: 'general' }).toString(),
    });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      return { resultUrl: data.url || data.post_url || 'https://skyrock.com' };
    }
    throw new Error(`skyrock.com: ${r.status}`);
  },

  // ── BLOGLOVIN.COM ── blog aggregator (DA 77)
  'bloglovin.com': async (url, creds, content) => {
    const token = creds.token;
    if (!token) throw new Error('bloglovin.com: OAuth token required');
    const targetUrl = (content.links && content.links[0]?.url) || 'https://example.com';
    const r = await fetch('https://api.bloglovin.com/v5/posts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: targetUrl, title: content.title || '', description: (content.body || '').substring(0, 500) }),
    });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      return { resultUrl: data.url || data.post?.link || 'https://www.bloglovin.com' };
    }
    throw new Error(`bloglovin.com: ${r.status}`);
  },

  // ── EVERNOTE.COM ── note creation (DA 92)
  'evernote.com': async (url, creds, content) => {
    // Evernote uses the Thrift API; simplified form via their note-link endpoint
    const token = creds.token; // developer token from dev.evernote.com
    if (!token) throw new Error('evernote.com: Developer token required');
    // Use Evernote API (production)
    const noteXml = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note><p>${(content.body || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p></en-note>`;
    const r = await fetch('https://www.evernote.com/shard/s1/notestore/note', {
      method: 'POST',
      headers: { Authorization: `Evernote singleuserversion=2, auth=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: content.title || 'Note', content: noteXml, tagNames: (content.tags || '').split(',').map(t => t.trim()).filter(Boolean) }),
    });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      return { resultUrl: data.noteUrl || `https://www.evernote.com/l/` };
    }
    throw new Error(`evernote.com: ${r.status}`);
  },

  // ── ZOHO.COM (Writer) ── document creation (DA 90)
  'zoho.com': async (url, creds, content) => {
    const token = creds.token;
    if (!token) throw new Error('zoho.com: OAuth token required (Zoho Writer API)');
    const r = await fetch('https://writer.zoho.com/api/v1/document', {
      method: 'POST',
      headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ document_name: content.title || 'Document', content: content.body || '' }).toString(),
    });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      return { resultUrl: data.document?.permalink || data.url || 'https://writer.zoho.com' };
    }
    throw new Error(`zoho.com: ${r.status}`);
  },

  // ── DZONE.COM ── developer community (DA 85)
  'dzone.com': async (url, creds, content) => {
    const token = creds.token;
    if (!token) throw new Error('dzone.com: OAuth token required');
    const targetUrl = (content.links && content.links[0]?.url) || 'https://example.com';
    const r = await fetch('https://dzone.com/api/v2/article', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: content.title || 'Article', url: targetUrl, description: (content.body || '').substring(0, 500), tags: content.tags || 'programming' }),
    });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      return { resultUrl: data.url || data.permalink || 'https://dzone.com' };
    }
    throw new Error(`dzone.com: ${r.status}`);
  },

  // ── SCOOP.IT ── content curation (DA 83)
  'scoop.it': async (url, creds, content) => {
    const token = creds.token;
    if (!token) throw new Error('scoop.it: OAuth token required');
    const topicId = creds.topicId;
    if (!topicId) throw new Error('scoop.it: topicId required');
    const targetUrl = (content.links && content.links[0]?.url) || 'https://example.com';
    const r = await fetch('https://www.scoop.it/api/1/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ access_token: token, topicId, url: targetUrl, title: content.title || '', content: content.body || '', rescoop: 'false', publish: 'true' }).toString(),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) return { resultUrl: data.post?.url || `https://www.scoop.it/topic/${topicId}` };
    throw new Error(data.error || `scoop.it: ${r.status}`);
  },

  // ── FLIPBOARD.COM ── content curation (DA 91)
  'flipboard.com': async (url, creds, content) => {
    const token = creds.token;
    if (!token) throw new Error('flipboard.com: OAuth token required');
    const magazineId = creds.magazineId;
    if (!magazineId) throw new Error('flipboard.com: magazineId required');
    const targetUrl = (content.links && content.links[0]?.url) || 'https://example.com';
    const r = await fetch(`https://flipboard.com/api/v1/magazines/${magazineId}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: targetUrl, title: content.title || '', comment: (content.body || '').substring(0, 300) }),
    });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      return { resultUrl: data.url || `https://flipboard.com/@${creds.username}/${magazineId}` };
    }
    throw new Error(`flipboard.com: ${r.status}`);
  },

  // ── JUSTPASTE.IT ── session-cookie based API
  'justpaste.it': async (url, creds, content) => {
    // Login to get session cookies
    const loginPage = await fetch('https://justpaste.it/login', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const loginHtml = await loginPage.text();
    const tokenMatch = loginHtml.match(/name="_token"\s+value="([^"]+)"/);
    const csrfToken = tokenMatch ? tokenMatch[1] : '';
    const loginCookies = loginPage.headers.get('set-cookie') || '';

    const loginRes = await fetch('https://justpaste.it/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://justpaste.it/login',
        'Cookie': loginCookies,
        'User-Agent': 'Mozilla/5.0',
      },
      body: new URLSearchParams({ _token: csrfToken, email: creds.username || creds.email || '', password: creds.password || '', remember: '1' }).toString(),
      redirect: 'manual',
    });
    const sessionCookies = [loginCookies, loginRes.headers.get('set-cookie') || ''].join('; ');

    // Get create page for CSRF token
    const createPage = await fetch('https://justpaste.it/create', {
      headers: { Cookie: sessionCookies, 'User-Agent': 'Mozilla/5.0' },
    });
    const createHtml = await createPage.text();
    const createToken = (createHtml.match(/name="_token"\s+value="([^"]+)"/) || [])[1] || csrfToken;

    // Submit article
    const r = await fetch('https://justpaste.it/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': sessionCookies,
        'Referer': 'https://justpaste.it/create',
        'User-Agent': 'Mozilla/5.0',
      },
      body: new URLSearchParams({
        _token: createToken,
        title: content.title || '',
        content: content.body || '',
        descriptionEnabled: '0',
        requirePassword: '0',
        hide: '0',
        matureContent: '0',
        action: 'save',
      }).toString(),
      redirect: 'manual',
    });
    const loc = r.headers.get('location') || r.url;
    if (loc && loc !== 'https://justpaste.it/create') {
      return { resultUrl: loc.startsWith('http') ? loc : 'https://justpaste.it' + loc };
    }
    throw new Error('justpaste.it: post failed — check credentials');
  },
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

async function safeFill(page, selector, text) {
  try {
    await page.waitForSelector(selector, { timeout: 8000 });
    const el = await page.$(selector);
    if (el) await el.fill(text);
  } catch (_) {
    try {
      const el = await page.$(selector);
      if (el) { await el.click({ clickCount: 3 }); await page.keyboard.type(text, { delay: 8 }); }
    } catch (__) {}
  }
}
