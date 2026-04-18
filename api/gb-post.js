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
        headless: chromiumPkg.headless,
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
    const r = await fetch('https://gql.hashnode.com', {
      method: 'POST',
      headers: { Authorization: creds.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `mutation PublishPost($input: PublishPostInput!) { publishPost(input: $input) { post { url } } }`,
        variables: {
          input: {
            title: content.title,
            contentMarkdown: content.body,
            publicationId: creds.publicationId || '',
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
    // rentry needs CSRF token
    const page1 = await fetch('https://rentry.co', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html  = await page1.text();
    const csrfMatch = html.match(/csrfmiddlewaretoken.*?value="([^"]+)"/);
    const csrf = csrfMatch ? csrfMatch[1] : '';
    const cookies = page1.headers.get('set-cookie') || '';
    const sessionCookie = (cookies.match(/csrftoken=([^;]+)/) || [])[1] || '';

    const r = await fetch('https://rentry.co/api/new', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://rentry.co',
        'Cookie': `csrftoken=${sessionCookie}`,
      },
      body: new URLSearchParams({ csrfmiddlewaretoken: csrf, text: content.body, edit_code: '' }).toString(),
    });
    const data = await r.json().catch(() => ({}));
    if (!data.url && !r.ok) throw new Error('rentry.co error');
    return { resultUrl: data.url || 'https://rentry.co' };
  },

  'hastebin.com': async (url, creds, content) => {
    // Try toptal/hastebin primary endpoint
    const endpoints = [
      'https://www.toptal.com/developers/hastebin/documents',
      'https://hastebin.com/documents',
    ];
    for (const ep of endpoints) {
      try {
        const r = await fetch(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: content.body,
        });
        if (!r.ok) continue;
        const data = await r.json();
        const key = data.key || data.Key;
        if (key) {
          const base = ep.includes('toptal') ? 'https://www.toptal.com/developers/hastebin/' : 'https://hastebin.com/';
          return { resultUrl: base + key };
        }
      } catch (_) {}
    }
    throw new Error('hastebin: all endpoints failed');
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
