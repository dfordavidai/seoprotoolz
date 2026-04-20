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
import { getProfile, formatContent, isPdfPlatform } from '../lib/site-profiles.js';
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

  // Per-site content override from frontend (routing engine sends per-site content)
  const effectiveContent = site.content || content;

  // PDF platforms cannot receive content via API — return manual signal immediately
  if (isPdfPlatform(url)) {
    const uploadPage = {
      'scribd.com': 'https://www.scribd.com/upload-document',
      'issuu.com': 'https://issuu.com/home/publish',
      'slideshare.net': 'https://www.slideshare.net/upload',
      'academia.edu': 'https://www.academia.edu/upload',
      'archive.org': 'https://archive.org/upload/',
    }[new URL(url).hostname.replace(/^www\./, '')] || url;
    return {
      ok: true,
      method: 'manual_pdf',
      resultUrl: uploadPage,
      manual: true,
      note: 'PDF platform — download the PDF from the frontend and upload manually to ' + uploadPage,
    };
  }

  // Determine strategy: REST API or Playwright
  const strategy = resolveStrategy(url, method, credentials);

  if (strategy === 'rest_api') {
    return restApiPost(url, credentials, effectiveContent, options, timeout);
  } else {
    return playwrightPost(url, credentials, effectiveContent, options, timeout);
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

// Strip markdown/HTML to pure plain text for paste site REST calls
function _plainText(body) {
  return (body || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '')
    .replace(/^#{1,6}\s+/gm, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^[-*+]\s+/gm, '').replace(/^\d+\.\s+/gm, '').replace(/^>\s+/gm, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n').trim();
}

const REST_HANDLERS = {

  'pastebin.com': async (url, creds, content) => {
    const params = new URLSearchParams({
      api_dev_key: creds.token || creds.api_key,
      api_option: 'paste',
      api_paste_code: _plainText(content.body) || '',
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
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
      body: new URLSearchParams({ content: _plainText(content.body) || ' ', title: content.title || '', syntax: 'text', expiry_days: '365' }).toString(),
      redirect: 'manual',
    });
    // dpaste returns 302 to the new paste URL
    const loc = r.headers.get('location') || '';
    if (loc) return { resultUrl: loc.startsWith('http') ? loc : 'https://dpaste.com' + loc };
    // Fallback: try parsing body
    const body = await r.text().catch(() => '');
    const match = body.match(/https?:\/\/dpaste\.com\/[A-Z0-9]+/i);
    if (match) return { resultUrl: match[0] };
    throw new Error('dpaste.com: no URL in response');
  },

  'controlc.com': async (url, creds, content) => {
    const r = await fetch('https://controlc.com/index.php?act=submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://controlc.com', 'User-Agent': 'Mozilla/5.0' },
      body: new URLSearchParams({ 'subdomain-name': '', 'paste_data': _plainText(content.body) || ' ', 'private': '0' }).toString(),
    });
    const html = await r.text().catch(() => '');
    // After successful submit, the response contains the paste URL
    const match = html.match(/https?:\/\/controlc\.com\/[a-f0-9]+/i);
    if (match) return { resultUrl: match[0] };
    const loc = r.headers.get('location') || '';
    if (loc && loc !== 'https://controlc.com/') return { resultUrl: loc.startsWith('http') ? loc : 'https://controlc.com' + loc };
    throw new Error('controlc.com: could not extract paste URL from response');
  },

  'rentry.co': async (url, creds, content) => {
    // Fetch homepage to get CSRF token + session cookie
    const homeRes = await fetch('https://rentry.co', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await homeRes.text();
    // Try multiple CSRF extraction patterns (rentry has changed their HTML before)
    const csrf =
      (html.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/) ||
       html.match(/csrfmiddlewaretoken['":\s]+['"]([a-zA-Z0-9]{20,})/))?.[1] || '';

    // getAllSetCookies handles Node 18/20 multi-value Set-Cookie correctly
    const setCookieValues = getAllSetCookies(homeRes.headers);
    const allCookieStr = setCookieValues.join('; ');
    const sessionCookie = allCookieStr.match(/csrftoken=([^;,\s]+)/)?.[1] || '';
    const cookieHeader = sessionCookie
      ? `csrftoken=${sessionCookie}`
      : allCookieStr;

    const r = await fetch('https://rentry.co/api/new', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://rentry.co/',
        'X-CSRFToken': csrf,
        'Cookie': cookieHeader,
      },
      body: new URLSearchParams({ csrfmiddlewaretoken: csrf, text: _plainText(content.body) || ' ', edit_code: '' }).toString(),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = {}; }
    if (data.url) return { resultUrl: data.url.startsWith('http') ? data.url : 'https://rentry.co' + data.url };
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
          body: _plainText(content.body) || ' ',
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
      body: JSON.stringify({ content: _plainText(content.body) || '', unique_key: '', password: '' }),
    });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      if (data.unique_key) return { resultUrl: `https://pastelink.net/${data.unique_key}` };
    }
    // Fallback: form submission
    const r2 = await fetch('https://pastelink.net/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://pastelink.net/' },
      body: new URLSearchParams({ paste_data: _plainText(content.body) || '', paste_title: content.title || '', paste_expire: '1m', paste_type: 'text' }).toString(),
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
    // Proper multi-value cookie extraction
    const setCookieVals = getAllSetCookies(homePage.headers);
    const allCookies = setCookieVals.join('; ');
    const csrfToken = allCookies.match(/csrftoken=([^;,\s]+)/)?.[1] || '';

    const r = await fetch('https://ideone.com/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://ideone.com/',
        'Cookie': csrfToken ? `csrftoken=${csrfToken}` : allCookies,
      },
      body: new URLSearchParams({
        csrfmiddlewaretoken: csrf,
        source: _plainText(content.body) || ' ',
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
    const loginCookies = getAllSetCookies(loginRes.headers).join('; ');

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
    const cookies1 = getAllSetCookies(tokenRes.headers).join('; ');

    const loginRes = await fetch(api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookies1, 'User-Agent': 'Mozilla/5.0' },
      body: new URLSearchParams({ action: 'login', lgname: creds.username || '', lgpassword: creds.password || '', lgtoken: loginToken, format: 'json' }).toString(),
    });
    const cookies2 = mergeCookieStrings(cookies1, getAllSetCookies(loginRes.headers).join('; '));

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
    const cookieHeader = getAllSetCookies(loginRes.headers).join('; ');

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
    const cookies = getAllSetCookies(loginRes.headers).join('; ');

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
    const cookies = getAllSetCookies(loginRes.headers).join('; ');
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
    const cookies = getAllSetCookies(loginRes.headers).join('; ');

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
    const cookies = getAllSetCookies(loginRes.headers).join('; ');

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
    const cookies = getAllSetCookies(loginRes.headers).join('; ');
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
    const cookies = getAllSetCookies(loginRes.headers).join('; ');
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
    // Scribd requires a real PDF file upload — cannot be done via REST without a file blob.
    // The frontend generates a PDF and shows a download panel for manual upload.
    return { resultUrl: 'https://www.scribd.com/upload-document', manual: true,
      note: 'Scribd requires PDF file upload. Download from the frontend PDF panel and upload at scribd.com/upload-document' };
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
      body: JSON.stringify({ title: content.title || 'Document', description: _plainText(content.body).substring(0, 500), access: 'PUBLIC' }),
    });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      return { resultUrl: data.shareUrl || data.url || 'https://issuu.com' };
    }
    throw new Error(`issuu.com: API error ${r.status}`);
  },

  // ── SLIDESHARE.NET ── SlideShare upload API
  'slideshare.net': async (url, creds, content) => {
    // SlideShare requires a real file upload (PDF/PPT) — cannot be done via REST without a file blob.
    return { resultUrl: 'https://www.slideshare.net/upload', manual: true,
      note: 'SlideShare requires PDF/PPT file upload. Download from the frontend PDF panel and upload at slideshare.net/upload' };
    // Legacy API kept below for reference but unreachable:
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

  // ── JUSTPASTE.IT ── session-cookie based API
  'justpaste.it': async (url, creds, content) => {
    // Login to get session cookies
    const loginPage = await fetch('https://justpaste.it/login', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const loginHtml = await loginPage.text();
    const tokenMatch = loginHtml.match(/name="_token"\s+value="([^"]+)"/);
    const csrfToken = tokenMatch ? tokenMatch[1] : '';
    const loginPageCookies = getAllSetCookies(loginPage.headers).join('; ');

    const loginRes = await fetch('https://justpaste.it/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://justpaste.it/login',
        'Cookie': loginPageCookies,
        'User-Agent': 'Mozilla/5.0',
      },
      body: new URLSearchParams({ _token: csrfToken, email: creds.username || creds.email || '', password: creds.password || '', remember: '1' }).toString(),
      redirect: 'manual',
    });
    const loginResCookies = getAllSetCookies(loginRes.headers).join('; ');
    const sessionCookies = mergeCookieStrings(loginPageCookies, loginResCookies);

    // Get create page for CSRF token
    const createPage = await fetch('https://justpaste.it/create', {
      headers: { Cookie: sessionCookies, 'User-Agent': 'Mozilla/5.0' },
    });
    const createHtml = await createPage.text();
    const createToken = (createHtml.match(/name="_token"\s+value="([^"]+)"/) || [])[1] || csrfToken;
    // Merge any new cookies from create page
    const createCookies = mergeCookieStrings(sessionCookies, getAllSetCookies(createPage.headers).join('; '));

    // Submit article
    const r = await fetch('https://justpaste.it/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': createCookies,
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
    const loc = r.headers.get('location') || '';
    if (loc && loc !== 'https://justpaste.it/create' && loc !== '/create') {
      return { resultUrl: loc.startsWith('http') ? loc : 'https://justpaste.it' + loc };
    }
    throw new Error('justpaste.it: post failed — check credentials');
  },

  // ══════════════════════════════════════════════════════════════════════════
  //  NEW SITES (+30) — added for BLP 313→343 expansion
  // ══════════════════════════════════════════════════════════════════════════

  // ── DEV / CODE HOSTING ────────────────────────────────────────────────────

  'replit.com': async (url, creds, content) => {
    const r = await fetch('https://replit.com/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': `connect.sid=${creds.token || creds.api_key}`,
      },
      body: JSON.stringify({
        operationName: 'CreateRepl',
        query: `mutation CreateRepl($input: CreateReplInput!) { createRepl(input: $input) { ... on Repl { id url } } }`,
        variables: { input: { title: content.title || 'MyRepl', language: 'html', isPrivate: false } },
      }),
    });
    const data = await r.json();
    const replUrl = data?.data?.createRepl?.url;
    if (!replUrl) throw new Error('replit.com: could not create repl — check session token');
    return { resultUrl: `https://replit.com${replUrl}` };
  },

  'glitch.com': async (url, creds, content) => {
    const r = await fetch('https://api.glitch.com/v1/projects', {
      method: 'POST',
      headers: { 'Authorization': creds.token || creds.api_key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: (content.title || 'my-project').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30),
        description: (content.body || '').slice(0, 200),
        private: false,
      }),
    });
    const data = await r.json();
    if (!data?.id) throw new Error('glitch.com: project creation failed');
    return { resultUrl: `https://${data.domain || data.name}.glitch.me` };
  },

  'codesandbox.io': async (url, creds, content) => {
    const htmlBody = content.body?.includes('<') ? content.body : `<h1>${content.title || 'Page'}</h1><p>${content.body || ''}</p>`;
    const r = await fetch('https://codesandbox.io/api/v1/sandboxes/define?json=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${creds.token || creds.api_key}` },
      body: JSON.stringify({ files: { 'index.html': { content: htmlBody } } }),
    });
    const data = await r.json();
    if (!data?.sandbox_id) throw new Error('codesandbox.io: sandbox creation failed');
    return { resultUrl: `https://codesandbox.io/s/${data.sandbox_id}` };
  },

  'codeberg.org': async (url, creds, content) => {
    const repoSlug = (content.title || 'seo-post').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
    const r = await fetch('https://codeberg.org/api/v1/user/repos', {
      method: 'POST',
      headers: { 'Authorization': `token ${creds.token || creds.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: repoSlug,
        description: (content.body || '').slice(0, 255),
        private: false,
        auto_init: true,
        default_branch: 'main',
      }),
    });
    const data = await r.json();
    if (!data?.html_url) throw new Error(`codeberg.org: repo creation failed — ${data?.message || ''}`);
    return { resultUrl: data.html_url };
  },

  'neocities.org': async (url, creds, content) => {
    const htmlBody = content.body?.includes('<') ? content.body : `<h1>${content.title || 'Page'}</h1><p>${content.body || ''}</p>`;
    const formData = new FormData();
    formData.append('index.html', new Blob([htmlBody], { type: 'text/html' }), 'index.html');
    const r = await fetch('https://neocities.org/api/upload', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${creds.token || creds.api_key}` },
      body: formData,
    });
    const data = await r.json();
    if (data.result !== 'success') throw new Error(`neocities.org: ${data.message || 'upload failed'}`);
    const me = await fetch('https://neocities.org/api/info', { headers: { 'Authorization': `Bearer ${creds.token || creds.api_key}` } });
    const meData = await me.json();
    const sitename = meData?.info?.sitename || 'mysite';
    return { resultUrl: `https://${sitename}.neocities.org` };
  },

  // ── HIGH-DA CONTENT PLATFORMS ─────────────────────────────────────────────

  'producthunt.com': async (url, creds, content) => {
    const r = await fetch('https://api.producthunt.com/v2/api/graphql', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${creds.token || creds.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `mutation CreatePost($input: CreatePostInput!) { createPost(input: $input) { post { id url } } }`,
        variables: {
          input: {
            name: (content.title || 'My Product').slice(0, 60),
            tagline: (content.body || '').slice(0, 100),
            website: content.links?.[0]?.url || content.links?.[0] || 'https://example.com',
          },
        },
      }),
    });
    const data = await r.json();
    if (data.errors) throw new Error(`producthunt.com: ${data.errors[0].message}`);
    return { resultUrl: data.data?.createPost?.post?.url || 'https://producthunt.com' };
  },

  'sourceforge.net': async (url, creds, content) => {
    const projSlug = (content.title || 'seo-project').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30);
    const r = await fetch('https://sourceforge.net/rest/p', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${creds.token || creds.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shortname: projSlug,
        name: content.title || projSlug,
        short_description: (content.body || '').slice(0, 255),
        external_homepage: content.links?.[0]?.url || content.links?.[0] || '',
      }),
    });
    const data = await r.json();
    if (!data?.shortname) throw new Error(`sourceforge.net: ${data?.error || 'project creation failed'}`);
    return { resultUrl: `https://sourceforge.net/projects/${data.shortname}/` };
  },

  'kaggle.com': async (url, creds, content) => {
    const basic = Buffer.from(`${creds.username}:${creds.token || creds.api_key}`).toString('base64');
    const nbSlug = (content.title || 'notebook').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
    const r = await fetch('https://www.kaggle.com/api/v1/kernels/push', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: `${creds.username}/${nbSlug}`,
        title: content.title || nbSlug,
        code_file: `# ${content.title || 'Post'}\n${content.body || ''}`,
        language: 'python',
        kernel_type: 'script',
        is_private: false,
        enable_gpu: false,
        enable_internet: false,
        dataset_data_sources: [],
        competition_data_sources: [],
        kernel_data_sources: [],
      }),
    });
    const data = await r.json();
    if (!data?.ref) throw new Error(`kaggle.com: ${data?.message || 'notebook push failed'}`);
    return { resultUrl: `https://www.kaggle.com/code/${creds.username}/${nbSlug}` };
  },

  'paperswithcode.com': async (url, creds, content) => {
    const r = await fetch('https://paperswithcode.com/api/v1/papers/', {
      method: 'POST',
      headers: { 'Authorization': `Token ${creds.token || creds.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: content.title || 'Paper',
        abstract: (content.body || '').slice(0, 1000),
        url_abs: content.links?.[0]?.url || content.links?.[0] || '',
        url_pdf: content.links?.[1]?.url || content.links?.[1] || content.links?.[0]?.url || content.links?.[0] || '',
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`paperswithcode.com: ${JSON.stringify(data)}`);
    return { resultUrl: data?.url || 'https://paperswithcode.com' };
  },

  // ── BLOG / NEWSLETTER PLATFORMS ───────────────────────────────────────────

  'micro.blog': async (url, creds, content) => {
    const r = await fetch('https://micro.blog/micropub', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${creds.token || creds.api_key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ h: 'entry', name: content.title || '', content: content.body || '' }).toString(),
    });
    if (r.status === 201 || r.ok) {
      const loc = r.headers.get('location') || 'https://micro.blog';
      return { resultUrl: loc };
    }
    throw new Error(`micro.blog: HTTP ${r.status}`);
  },

  'bearblog.dev': async (url, creds, content) => {
    const r = await fetch('https://bearblog.dev/api/posts/', {
      method: 'POST',
      headers: { 'Authorization': `Token ${creds.token || creds.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: content.title || 'Post',
        content: content.body || '',
        published: true,
        make_discoverable: true,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`bearblog.dev: ${data?.detail || 'post failed'}`);
    return { resultUrl: data?.canonical_url || 'https://bearblog.dev' };
  },

  'mataroa.blog': async (url, creds, content) => {
    const r = await fetch('https://mataroa.blog/api/posts/', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${creds.token || creds.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: content.title || 'Post', body: content.body || '' }),
    });
    const data = await r.json();
    if (!r.ok || !data?.url) throw new Error(`mataroa.blog: ${data?.error || 'post failed'}`);
    return { resultUrl: data.url };
  },

  'buttondown.email': async (url, creds, content) => {
    const r = await fetch('https://api.buttondown.email/v1/emails', {
      method: 'POST',
      headers: { 'Authorization': `Token ${creds.token || creds.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: content.title || 'Newsletter', body: content.body || '', status: 'sent' }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`buttondown.email: ${JSON.stringify(data)}`);
    return { resultUrl: `https://buttondown.email/emails/${data.id || ''}` };
  },

  'typefully.com': async (url, creds, content) => {
    const r = await fetch('https://api.typefully.com/v1/drafts/', {
      method: 'POST',
      headers: { 'X-API-KEY': `Bearer ${creds.token || creds.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `${content.title ? content.title + '\n\n' : ''}${content.body || ''}`,
        schedule_date: 'next-free-slot',
        share: true,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`typefully.com: ${data?.detail || 'draft creation failed'}`);
    return { resultUrl: data?.share_url || 'https://typefully.com' };
  },

  'plume.social': async (url, creds, content) => {
    const instance = creds.instance || 'https://plume.social';
    const r = await fetch(`${instance}/api/v1/posts`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${creds.token || creds.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: content.title || 'Post',
        subtitle: '',
        content: content.body || '',
        source: content.body || '',
        cover_id: null,
        tags: (content.tags || '').split(',').map(t => t.trim()).filter(Boolean),
        license: '',
        creation_date: new Date().toISOString(),
        published: true,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`plume.social: ${data?.error || 'post failed'}`);
    return { resultUrl: data?.url || instance };
  },

  // ── LINK AGGREGATORS ──────────────────────────────────────────────────────

  'lobste.rs': async (url, creds, content) => {
    const r = await fetch('https://lobste.rs/stories', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${creds.token || creds.api_key}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        story: {
          title: content.title || 'Link',
          url: content.links?.[0]?.url || content.links?.[0] || url,
          description: (content.body || '').slice(0, 500),
          tags: (content.tags || 'programming').split(',').map(t => t.trim()).slice(0, 3),
        },
      }),
    });
    const data = await r.json();
    if (!data?.short_id) throw new Error(`lobste.rs: ${data?.error || 'submission failed'}`);
    return { resultUrl: `https://lobste.rs/s/${data.short_id}` };
  },

  'lemmy.world': async (url, creds, content) => {
    const instance = creds.instance || 'https://lemmy.world';
    // Login for JWT (or use token directly)
    let jwt = creds.token || creds.api_key;
    if (!jwt && creds.username && creds.password) {
      const loginRes = await fetch(`${instance}/api/v3/user/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username_or_email: creds.username, password: creds.password }),
      });
      const loginData = await loginRes.json();
      jwt = loginData?.jwt;
    }
    if (!jwt) throw new Error('lemmy.world: login failed — provide token or username+password');

    // Resolve community id
    const communityRes = await fetch(`${instance}/api/v3/community?name=${encodeURIComponent(creds.community || 'main')}`, {
      headers: { 'Authorization': `Bearer ${jwt}` },
    });
    const communityData = await communityRes.json();
    const communityId = communityData?.community_view?.community?.id || 2;

    const r = await fetch(`${instance}/api/v3/post`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: content.title || 'Post',
        body: content.body || '',
        url: content.links?.[0]?.url || content.links?.[0] || undefined,
        community_id: communityId,
        nsfw: false,
      }),
    });
    const data = await r.json();
    if (!data?.post_view?.post?.ap_id) throw new Error(`lemmy.world: ${JSON.stringify(data.error || data)}`);
    return { resultUrl: data.post_view.post.ap_id };
  },

  'kbin.social': async (url, creds, content) => {
    // kbin uses Mastodon-compatible API
    const instance = creds.instance || 'https://kbin.social';
    const r = await fetch(`${instance}/api/v1/statuses`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${creds.token || creds.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: `${content.title ? content.title + '\n\n' : ''}${content.body || ''}\n\n${content.links?.[0]?.url || content.links?.[0] || ''}`.trim(),
        visibility: 'public',
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`kbin.social: ${data?.error || 'post failed'}`);
    return { resultUrl: data?.url || instance };
  },

  'stacker.news': async (url, creds, content) => {
    const r = await fetch('https://stacker.news/api/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `session=${creds.token || creds.api_key}`,
      },
      body: JSON.stringify({
        query: `mutation UpsertLink($url: String!, $title: String!) { upsertLink(url: $url, title: $title) { id } }`,
        variables: {
          url: content.links?.[0]?.url || content.links?.[0] || 'https://example.com',
          title: content.title || 'Link',
        },
      }),
    });
    const data = await r.json();
    const id = data?.data?.upsertLink?.id;
    if (!id) throw new Error(`stacker.news: ${data?.errors?.[0]?.message || 'submission failed'}`);
    return { resultUrl: `https://stacker.news/items/${id}` };
  },

  // ── SOCIAL / BOOKMARKING ──────────────────────────────────────────────────

  'raindrop.io': async (url, creds, content) => {
    const r = await fetch('https://api.raindrop.io/rest/v1/raindrop', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${creds.token || creds.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        link: content.links?.[0]?.url || content.links?.[0] || url,
        title: content.title || 'Bookmark',
        excerpt: (content.body || '').slice(0, 500),
        tags: (content.tags || '').split(',').map(t => t.trim()).filter(Boolean),
        collection: { $id: creds.collectionId ? Number(creds.collectionId) : 0 },
      }),
    });
    const data = await r.json();
    if (!r.ok || !data?.item?._id) throw new Error(`raindrop.io: ${data?.errorMessage || 'bookmark failed'}`);
    return { resultUrl: `https://raindrop.io/my/links` };
  },

  'lu.ma': async (url, creds, content) => {
    const r = await fetch('https://api.lu.ma/public/v1/event/create', {
      method: 'POST',
      headers: { 'x-luma-api-key': creds.token || creds.api_key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: content.title || 'Event',
        description: content.body || '',
        start_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        end_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000).toISOString(),
        timezone: 'America/New_York',
        geo_address_visibility: 'none',
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`lu.ma: ${data?.error || 'event creation failed'}`);
    return { resultUrl: data?.event?.url || 'https://lu.ma' };
  },

  'lottiefiles.com': async (url, creds, content) => {
    const r = await fetch('https://graphql.lottiefiles.com/2022-08/', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${creds.token || creds.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `mutation CreatePost($input: CreateCommunityPostInput!) { createCommunityPost(input: $input) { id url } }`,
        variables: {
          input: {
            title: content.title || 'Animation',
            description: content.body || '',
            url: content.links?.[0]?.url || content.links?.[0] || '',
          },
        },
      }),
    });
    const data = await r.json();
    if (data.errors) throw new Error(`lottiefiles.com: ${data.errors[0].message}`);
    return { resultUrl: data?.data?.createCommunityPost?.url || 'https://lottiefiles.com' };
  },

  'launchpad.net': async (url, creds, content) => {
    // Launchpad uses OAuth 1.0a — requires pre-authorized access token + secret
    const projSlug = (content.title || 'seo-project').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 32);
    const r = await fetch('https://api.launchpad.net/1.0/projects', {
      method: 'POST',
      headers: {
        'Authorization': `OAuth realm="https://api.launchpad.net/",oauth_token="${creds.token}",oauth_consumer_key="${creds.consumer_key || 'seobot'}",oauth_signature_method="PLAINTEXT",oauth_signature="&${creds.token_secret || ''}"`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        'ws.op': 'new_project',
        name: projSlug,
        display_name: content.title || projSlug,
        title: content.title || projSlug,
        summary: (content.body || '').slice(0, 255),
        description: content.body || '',
      }).toString(),
    });
    if (!r.ok) throw new Error(`launchpad.net: HTTP ${r.status} — verify OAuth token, token_secret, and consumer_key in credentials`);
    const loc = r.headers.get('location') || 'https://launchpad.net';
    return { resultUrl: loc };
  },

  'sr.ht': async (url, creds, content) => {
    const repoSlug = (content.title || 'repo').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30);
    const r = await fetch('https://git.sr.ht/api/v1/repos', {
      method: 'POST',
      headers: { 'Authorization': `token ${creds.token || creds.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: repoSlug,
        description: (content.body || '').slice(0, 255),
        visibility: 'public',
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`sr.ht: ${data?.errors?.[0]?.reason || data?.reason || 'repo creation failed'}`);
    return { resultUrl: `https://git.sr.ht/~${creds.username}/${repoSlug}` };
  },

  // ── OTHER ─────────────────────────────────────────────────────────────────

  'pastery.net': async (url, creds, content) => {
    const apiKey = creds.token || creds.api_key;
    if (!apiKey) throw new Error('pastery.net: API key required');
    const r = await fetch(`https://www.pastery.net/api/paste/?api_key=${apiKey}&title=${encodeURIComponent(content.title || '')}&duration=525600`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: content.body || ' ',
    });
    const data = await r.json();
    if (!data?.id) throw new Error(`pastery.net: ${data?.error || 'paste failed'}`);
    return { resultUrl: `https://www.pastery.net/${data.id}/` };
  },

  'outline.com': async (url, creds, content) => {
    // outline = getoutline.com — self-hostable wiki; creds.host overrides base URL
    const host = (creds.host || 'https://app.getoutline.com').replace(/\/$/, '');
    const r = await fetch(`${host}/api/documents.create`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${creds.token || creds.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: content.title || 'Document',
        text: content.body || '',
        publish: true,
        ...(creds.collectionId ? { collectionId: creds.collectionId } : {}),
      }),
    });
    const data = await r.json();
    if (!data?.data?.url) throw new Error(`outline: ${data?.error || 'document creation failed'}`);
    return { resultUrl: `${host}${data.data.url}` };
  },
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

/**
 * Extracts ALL Set-Cookie values from a fetch Response.
 * fetch's headers.get('set-cookie') only returns the FIRST value on Node 18+.
 * Node 20+ exposes headers.getSetCookie(); Node 18 requires iterating entries().
 */
function getAllSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const cookies = [];
  for (const [key, value] of headers.entries()) {
    if (key.toLowerCase() === 'set-cookie') cookies.push(value);
  }
  return cookies;
}

/**
 * Merges multiple cookie strings (each may be "name=value; Path=/; ..." or "name=value; name2=value2")
 * Returns a single "name1=value1; name2=value2" string suitable for use as a Cookie header.
 */
function mergeCookieStrings(...cookieStrings) {
  const map = new Map();
  for (const str of cookieStrings) {
    if (!str) continue;
    // Split on commas that separate distinct Set-Cookie entries (but not commas within values)
    const entries = str.split(/;\s*(?=[^;=]+=[^;])/);
    for (const entry of entries) {
      // Take only the name=value part (before first semicolon)
      const nameVal = entry.split(';')[0].trim();
      const eqIdx = nameVal.indexOf('=');
      if (eqIdx < 1) continue;
      const k = nameVal.slice(0, eqIdx).trim();
      const v = nameVal.slice(eqIdx + 1).trim();
      if (k) map.set(k, v);
    }
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
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
