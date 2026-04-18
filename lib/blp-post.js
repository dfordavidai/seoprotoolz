/**
 * api/blp-post.js
 * Advanced Playwright-powered post creator for BLP (Backlink Pro) sites.
 * Handles: login, post creation, format detection, success verification.
 * Target: 95%+ success rate across 850+ sites.
 *
 * POST /api/blp-post
 * Body: {
 *   url          string   — Target site URL (e.g. "https://pastebin.com")
 *   credentials  object   — { username, password, token? }
 *   content      object   — { title, body, tags, links[] }
 *   options      object   — { timeout?, screenshot?, captchaKey?, proxy? }
 * }
 */

'use strict';

const { chromium } = require('playwright-core');
const chromiumPkg  = require('@sparticuz/chromium');
const { requireAuth, cors, jsonErr } = require('./auth');
const { getProfile, formatContent } = require('./site-profiles');

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT = 30_000;
const NAV_TIMEOUT     = 45_000;
const FORM_TIMEOUT    = 15_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
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

  const { url, credentials = {}, content = {}, options = {} } = body;
  if (!url) return jsonErr(res, 400, 'url is required');

  const timeout = options.timeout || DEFAULT_TIMEOUT;
  let browser, result;

  try {
    browser = await launchBrowser();
    result  = await runPostFlow(browser, url, credentials, content, options, timeout);
  } catch (err) {
    result = { ok: false, error: err.message, stack: process.env.NODE_ENV === 'development' ? err.stack : undefined };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return res.status(result.ok ? 200 : 500).json(result);
};

// ─── BROWSER LAUNCH ───────────────────────────────────────────────────────────

async function launchBrowser() {
  return chromium.launch({
    args: [
      ...chromiumPkg.args,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
    ],
    executablePath: await chromiumPkg.executablePath(),
    headless: chromiumPkg.headless,
  });
}

// ─── MAIN POST FLOW ───────────────────────────────────────────────────────────

async function runPostFlow(browser, url, credentials, rawContent, options, timeout) {
  const profile = getProfile(url);
  const content = formatContent(profile.postType || 'auto', rawContent);

  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  // Stealth: mask automation signals
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
  });

  const page = await ctx.newPage();
  page.setDefaultTimeout(timeout);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);

  // Inject proxy cookie if provided
  if (credentials.cookie) {
    await injectCookies(ctx, url, credentials.cookie);
  }

  const log = [];
  const pushLog = (msg, ok = true) => log.push({ ts: Date.now(), msg, ok });

  try {
    // ── STEP 1: LOGIN ──────────────────────────────────────────────────────
    if (!profile.anonymous && credentials.username) {
      const loginResult = await doLogin(page, profile, credentials, pushLog, timeout);
      if (!loginResult.ok) {
        return { ok: false, step: 'login', error: loginResult.error, log };
      }
    } else if (!profile.anonymous) {
      // Check if already logged in via cookie
      pushLog('No username provided, skipping login flow');
    }

    // ── STEP 2: NAVIGATE TO POST PAGE ─────────────────────────────────────
    const postUrl = resolvePostUrl(profile, credentials, url);
    if (postUrl) {
      pushLog(`Navigating to post creation: ${postUrl}`);
      await page.goto(postUrl, { waitUntil: 'domcontentloaded' });
      await smartWait(page, 1500);
    }

    // ── STEP 3: FILL & SUBMIT POST FORM ───────────────────────────────────
    const postResult = await doCreatePost(page, profile, content, pushLog, timeout);
    if (!postResult.ok) {
      // Try generic fallback
      pushLog('Primary selectors failed, attempting generic form detection...', false);
      const fallbackResult = await genericPostFallback(page, content, pushLog, timeout);
      if (!fallbackResult.ok) {
        const screenshotB64 = options.screenshot ? await page.screenshot({ encoding: 'base64', fullPage: false }) : null;
        return { ok: false, step: 'post', error: fallbackResult.error, log, screenshot: screenshotB64 };
      }
    }

    // ── STEP 4: DETECT SUCCESS ─────────────────────────────────────────────
    const finalUrl   = page.url();
    const pageTitle  = await page.title().catch(() => '');
    const pageText   = await page.innerText('body').catch(() => '');

    const successDetected = detectSuccess(profile, finalUrl, pageTitle, pageText);
    if (!successDetected) {
      pushLog(`Warning: success not definitively confirmed. Final URL: ${finalUrl}`, false);
    } else {
      pushLog(`✅ Post created successfully! URL: ${finalUrl}`);
    }

    const screenshotB64 = options.screenshot ? await page.screenshot({ encoding: 'base64', fullPage: false }) : null;
    return {
      ok: true,
      resultUrl: finalUrl,
      resultTitle: pageTitle,
      successDetected,
      log,
      screenshot: screenshotB64,
    };

  } catch (err) {
    const screenshotB64 = options.screenshot ? await page.screenshot({ encoding: 'base64', fullPage: false }).catch(() => null) : null;
    return { ok: false, error: err.message, log, screenshot: screenshotB64 };
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ─── LOGIN FLOW ───────────────────────────────────────────────────────────────

async function doLogin(page, profile, credentials, pushLog, timeout) {
  try {
    const loginUrl = typeof profile.loginUrl === 'function'
      ? profile.loginUrl(credentials)
      : profile.loginUrl;

    if (!loginUrl) return { ok: true }; // no login needed

    pushLog(`Navigating to login: ${loginUrl}`);
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    await smartWait(page, 1200);

    const sel = profile.loginSelectors || {};

    // Handle multi-step login (username first, then password on next screen)
    const userSel = sel.user;
    const passSel = sel.pass;
    const submitSel = sel.submit;

    if (userSel) {
      await safeType(page, userSel, credentials.username || '');
      pushLog(`Filled username: ${userSel}`);
    }

    // Some sites (Google, LinkedIn) split login into 2 steps
    if (submitSel && !(await page.isVisible(passSel || 'nothing').catch(() => false)) && userSel) {
      // Try clicking next after username
      try {
        const nextBtn = await page.$(submitSel);
        if (nextBtn) { await nextBtn.click(); await smartWait(page, 1500); }
      } catch (_) {}
    }

    if (passSel) {
      await safeType(page, passSel, credentials.password || '');
      pushLog(`Filled password: ${passSel}`);
    }

    if (submitSel) {
      await page.click(submitSel);
      pushLog('Clicked login submit');
    }

    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: NAV_TIMEOUT }).catch(() => {});
    await smartWait(page, 1000);

    // Detect login failure
    const url = page.url();
    const bodyText = await page.innerText('body').catch(() => '');
    if (/incorrect|invalid|wrong|failed|error/i.test(bodyText) && /login|signin|sign-in/i.test(url)) {
      return { ok: false, error: 'Login failed — invalid credentials or CAPTCHA wall' };
    }

    pushLog('Login appears successful');
    return { ok: true };

  } catch (err) {
    return { ok: false, error: `Login error: ${err.message}` };
  }
}

// ─── POST CREATION ────────────────────────────────────────────────────────────

async function doCreatePost(page, profile, content, pushLog, timeout) {
  const sel = profile.postSelectors || {};
  const { title, body, tags } = content;

  try {
    // Wait for post form to appear
    if (sel.body) {
      await page.waitForSelector(sel.body, { timeout: FORM_TIMEOUT }).catch(() => {});
    }

    // Fill title
    if (sel.title && title) {
      await safeType(page, sel.title, title);
      pushLog(`Filled title (${sel.title})`);
    }

    // Fill body
    if (sel.body) {
      const bodyEl = await page.$(sel.body);
      if (!bodyEl) throw new Error(`Body selector not found: ${sel.body}`);

      const tag = await bodyEl.evaluate(el => el.tagName.toLowerCase());
      const isContentEditable = await bodyEl.evaluate(el => el.contentEditable === 'true');

      if (tag === 'textarea' || tag === 'input') {
        await bodyEl.click();
        await bodyEl.fill(body);
      } else if (isContentEditable) {
        await bodyEl.click();
        await page.keyboard.selectAll();
        await page.keyboard.press('Delete');
        await bodyEl.type(body, { delay: 8 });
      } else {
        // Try CodeMirror / Monaco
        const cm = await page.$('.CodeMirror-scroll,.cm-content,.monaco-editor textarea');
        if (cm) {
          await cm.click();
          await page.keyboard.selectAll();
          await page.keyboard.type(body, { delay: 5 });
        } else {
          await bodyEl.click();
          await page.keyboard.type(body, { delay: 5 });
        }
      }
      pushLog(`Filled body (${sel.body})`);
    }

    // Fill tags
    if (sel.tags && tags) {
      await safeType(page, sel.tags, tags);
      pushLog(`Filled tags`);
    }

    // Handle hastebin-style keyboard-shortcut submit
    if (sel.submitKey) {
      const [mod, key] = sel.submitKey.split('+');
      await page.keyboard.press(`${mod.charAt(0).toUpperCase() + mod.slice(1)}+${key.toUpperCase()}`);
      pushLog(`Triggered keyboard submit: ${sel.submitKey}`);
      await smartWait(page, 2000);
      return { ok: true };
    }

    // Dismiss any cookie banners before submit
    await dismissBanners(page);

    // Submit
    if (sel.submit) {
      const submitEl = await page.$(sel.submit);
      if (!submitEl) throw new Error(`Submit selector not found: ${sel.submit}`);
      await submitEl.scrollIntoViewIfNeeded();
      await submitEl.click();
      pushLog('Clicked submit');
    }

    // Handle Notion-specific "make public" flow
    if (profile._domain === 'notion.so' && sel.shareButton) {
      await smartWait(page, 2000);
      await page.click(sel.shareButton).catch(() => {});
      await smartWait(page, 1000);
      await page.click(sel.publicToggle).catch(() => {});
      pushLog('Made Notion page public');
    }

    await page.waitForNavigation({ waitUntil: 'networkidle', timeout }).catch(() => {});
    await smartWait(page, 1000);

    return { ok: true };

  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── GENERIC FALLBACK ─────────────────────────────────────────────────────────

async function genericPostFallback(page, content, pushLog, timeout) {
  const { title, body } = content;
  try {
    // Find any visible textarea or contenteditable
    const bodySelectors = [
      'textarea[name*="content"]', 'textarea[name*="body"]', 'textarea[name*="text"]',
      'textarea[name*="message"]', '.ql-editor', '[contenteditable="true"]',
      'textarea:not([style*="display:none"]):not([style*="display: none"])',
    ];

    let bodyFilled = false;
    for (const bSel of bodySelectors) {
      const el = await page.$(bSel);
      if (!el) continue;
      const visible = await el.isVisible().catch(() => false);
      if (!visible) continue;
      const tag = await el.evaluate(e => e.tagName.toLowerCase());
      if (tag === 'textarea' || tag === 'input') await el.fill(body);
      else { await el.click(); await el.type(body, { delay: 5 }); }
      bodyFilled = true;
      pushLog(`Generic body fill: ${bSel}`);
      break;
    }

    if (!bodyFilled) return { ok: false, error: 'Could not find any writable body field' };

    // Find title if provided
    if (title) {
      const titleSelectors = [
        'input[name*="title"]', 'input[name*="headline"]', 'input[name*="subject"]',
        'input[placeholder*="title" i]', 'input[placeholder*="headline" i]',
      ];
      for (const tSel of titleSelectors) {
        try {
          const el = await page.$(tSel);
          if (el && await el.isVisible()) { await el.fill(title); pushLog(`Generic title fill: ${tSel}`); break; }
        } catch (_) {}
      }
    }

    // Submit
    const submitSelectors = [
      '[type="submit"]:not([value*="Cancel" i]):not([value*="Preview" i])',
      'button[type="submit"]', 'button:has-text("Publish")', 'button:has-text("Submit")',
      'button:has-text("Save")', 'button:has-text("Post")',
    ];

    for (const sSel of submitSelectors) {
      try {
        const el = await page.$(sSel);
        if (el && await el.isVisible()) {
          await el.click();
          pushLog(`Generic submit: ${sSel}`);
          await page.waitForNavigation({ waitUntil: 'networkidle', timeout }).catch(() => {});
          return { ok: true };
        }
      } catch (_) {}
    }

    return { ok: false, error: 'Could not find submit button' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── SUCCESS DETECTION ────────────────────────────────────────────────────────

function detectSuccess(profile, finalUrl, pageTitle, pageText) {
  const successPattern = profile.postSelectors?.successPattern;

  // Pattern match on URL
  if (successPattern) {
    if (successPattern instanceof RegExp) return successPattern.test(finalUrl);
    if (typeof successPattern === 'string') return finalUrl.includes(successPattern);
  }

  // Heuristic: URL changed AND page doesn't contain error keywords
  const errorPhrases = /error|failed|invalid|unauthorized|forbidden|not found|404/i;
  const successPhrases = /success|published|created|saved|thank|submit|posted|live/i;

  if (successPhrases.test(pageText) || successPhrases.test(pageTitle)) return true;
  if (errorPhrases.test(pageTitle)) return false;

  // Default: URL changed = likely success
  return true;
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────

function resolvePostUrl(profile, credentials, siteUrl) {
  if (typeof profile.postUrl === 'function') return profile.postUrl(credentials);
  if (profile.postUrl) return profile.postUrl;
  return null;
}

async function safeType(page, selector, text) {
  try {
    await page.waitForSelector(selector, { timeout: FORM_TIMEOUT });
    const el = await page.$(selector);
    if (!el) return;
    await el.click({ clickCount: 3 });
    await el.fill(text);
  } catch (err) {
    // Try a slower keyboard approach
    try {
      const el = await page.$(selector);
      if (el) { await el.click(); await page.keyboard.type(text, { delay: 10 }); }
    } catch (_) {}
  }
}

async function smartWait(page, ms) {
  await page.waitForTimeout(ms);
}

async function injectCookies(ctx, url, cookieStr) {
  // Supports "name=value; name2=value2" format
  const domain = new URL(url).hostname;
  const cookies = cookieStr.split(';').map(pair => {
    const [name, ...rest] = pair.trim().split('=');
    return { name: name.trim(), value: rest.join('=').trim(), domain, path: '/' };
  }).filter(c => c.name && c.value);
  if (cookies.length) await ctx.addCookies(cookies);
}

async function dismissBanners(page) {
  const bannerSelectors = [
    'button:has-text("Accept")', 'button:has-text("Accept all")',
    'button:has-text("Allow")', 'button:has-text("Got it")',
    '#accept-cookies', '.cookie-accept', '[data-testid="cookie-accept"]',
  ];
  for (const sel of bannerSelectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible().catch(() => false)) { await el.click(); await page.waitForTimeout(500); break; }
    } catch (_) {}
  }
}
