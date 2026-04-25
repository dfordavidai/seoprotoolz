/**
 * click-link.js — Vercel serverless (ESM)
 *
 * FIX: Switched from @sparticuz/chromium  →  @sparticuz/chromium-min
 *
 * Why: @sparticuz/chromium bundles a Chromium binary that links against libns3.so,
 * which does not exist in Vercel's Amazon Linux 2 Lambda runtime.
 * chromium-min downloads the binary at cold-start from a GitHub release URL,
 * which ships its own bundled libs — no host dependency issues.
 *
 * Actions:
 *   visit    — CTR simulator (scroll, dwell, click internal links)
 *   autopost — Login + smart field fill + captcha + submit
 *
 * Auth: X-API-Key header must match VERCEL_API_KEY env var
 */

import chromium from '@sparticuz/chromium-min';
import { chromium as playwrightChromium } from 'playwright-core';

// chromium-min does NOT bundle Chromium. It downloads at cold-start from this URL.
// Pin to a specific release so it is stable and reproducible.
const CHROMIUM_URL =
  'https://github.com/Sparticuz/chromium/releases/download/v131.0.1/chromium-v131.0.1-pack.tar';

// ── Auth ──────────────────────────────────────────────────────────────────────
function checkAuth(req) {
  const key      = (req.headers['x-api-key'] || '').trim();
  const expected = (process.env.VERCEL_API_KEY || process.env.API_KEY || '').trim();
  if (!expected) return true;
  return key === expected;
}

// ── Browser factory ───────────────────────────────────────────────────────────
async function launchBrowser() {
  // executablePath() is async in chromium-min — must be awaited, not read as property
  const executablePath = await chromium.executablePath(CHROMIUM_URL);

  return playwrightChromium.launch({
    args:           chromium.args,
    executablePath,
    headless:       true,
  });
}

const sleep = (ms)       => new Promise((r) => setTimeout(r, ms));
const rnd   = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: visit — CTR simulator
// ─────────────────────────────────────────────────────────────────────────────
async function actionVisit(body) {
  const {
    url,
    dwellTime   = rnd(45, 120),
    scrollDepth = rnd(40, 90),
    clickLinks  = true,
    maxClicks   = rnd(1, 3),
    referer     = 'https://www.google.com/',
  } = body;

  if (!url) return { ok: false, error: 'url is required' };

  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      extraHTTPHeaders: { Referer: referer },
    });
    const page = await context.newPage();

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    // Smooth scroll
    await page.evaluate(async (depth) => {
      const total  = document.body.scrollHeight;
      const target = total * (depth / 100);
      let current  = 0;
      while (current < target) {
        const step = Math.floor(Math.random() * 120) + 60;
        window.scrollBy(0, step);
        current += step;
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 300) + 100));
      }
    }, scrollDepth);

    const finalUrl = page.url();

    // Click internal links
    let clicked = 0;
    if (clickLinks && maxClicks > 0) {
      const links = await page.evaluate((base) => {
        const origin = new URL(base).origin;
        return Array.from(document.querySelectorAll('a[href]'))
          .map((a) => a.href)
          .filter((h) => { try { return new URL(h).origin === origin; } catch { return false; } })
          .slice(0, 10);
      }, url);

      for (const link of links.slice(0, maxClicks)) {
        try {
          await page.goto(link, { waitUntil: 'networkidle', timeout: 20000 });
          await sleep(rnd(3000, 8000));
          clicked++;
        } catch (_) {}
      }
    }

    await sleep(dwellTime * 1000);
    return { ok: true, url: finalUrl, dwellTime, scrollDepth, clickedLinks: clicked };
  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION: autopost — login + smart form fill + submit
// ─────────────────────────────────────────────────────────────────────────────
async function actionAutopost(body) {
  const {
    url,
    loginUrl,
    credentials      = {},
    fields           = {},
    captchaKey,
    screenshotOnFail = true,
    waitAfterSubmit  = 5000,
  } = body;

  if (!url) return { ok: false, error: 'url is required' };

  const browser = await launchBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport:  { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  let screenshot = null;
  const fail = async (reason) => {
    if (screenshotOnFail) {
      try {
        screenshot = (await page.screenshot({ type: 'jpeg', quality: 60 })).toString('base64');
      } catch (_) {}
    }
    await browser.close();
    return { ok: false, error: reason, screenshot };
  };

  try {
    // ── Step 1: Login ─────────────────────────────────────────────────────────
    if (loginUrl && credentials.username && credentials.password) {
      await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 30000 });

      const userField = await page.$(
        'input[type="text"], input[type="email"], input[name*="user"], input[name*="login"], input[id*="user"], input[id*="login"], input[name*="name"]'
      );
      if (!userField) return await fail('No username field found on login page');
      await userField.fill(credentials.username);

      const passField = await page.$('input[type="password"]');
      if (!passField) return await fail('No password field found on login page');
      await passField.fill(credentials.password);

      const submitBtn = await page.$('button[type="submit"], input[type="submit"], button:not([type="button"])');
      if (submitBtn) {
        await submitBtn.click();
      } else {
        await passField.press('Enter');
      }

      await page.waitForLoadState('networkidle').catch(() => {});
      await sleep(1500);

      const postLoginUrl = page.url().toLowerCase();
      if (postLoginUrl.includes('login') || postLoginUrl.includes('signin')) {
        const errEl   = await page.$('.error, .alert-danger, [class*="error"], [class*="alert"]');
        const errText = errEl ? (await errEl.innerText().catch(() => '')).slice(0, 120) : '';
        return await fail('Login failed' + (errText ? ': ' + errText : ''));
      }
    }

    // ── Step 2: Navigate to post page ────────────────────────────────────────
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(1000);

    // ── Step 3: Smart field fill ──────────────────────────────────────────────
    const fieldDefs = [
      { value: fields.subject || '', keys: ['subject', 'title', 'headline', 'topic', 'heading'],                     preferTextarea: false },
      { value: fields.body    || '', keys: ['body', 'content', 'message', 'post', 'description', 'text', 'comment'], preferTextarea: true  },
      { value: fields.tags    || '', keys: ['tag', 'keyword', 'category', 'label'],                                  preferTextarea: false },
      { value: fields.linkUrl || '', keys: ['url', 'link', 'website', 'href', 'source'],                             preferTextarea: false },
      { value: fields.anchor  || '', keys: ['anchor', 'link_text', 'link-text', 'linktext'],                         preferTextarea: false },
    ];

    for (const fd of fieldDefs) {
      if (!fd.value) continue;
      await page.evaluate((fd) => {
        const inputs = Array.from(
          document.querySelectorAll(
            'input:not([type="hidden"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="file"]), textarea'
          )
        );
        let best = null, bestScore = -Infinity;
        for (const el of inputs) {
          const attrs = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.className]
            .filter(Boolean).join(' ').toLowerCase();
          let score = 0;
          for (const k of fd.keys) { if (attrs.includes(k)) score += 10; }
          if (!el.value) score += 2;
          if (fd.preferTextarea && el.tagName === 'TEXTAREA') score += 5;
          if (score > bestScore) { bestScore = score; best = el; }
        }
        if (!best || (best.value && best.value.length > 2)) return;
        best.value = fd.value;
        best.dispatchEvent(new Event('input',  { bubbles: true }));
        best.dispatchEvent(new Event('change', { bubbles: true }));
      }, fd);
    }

    // ── Step 4: reCAPTCHA v2 via 2captcha ────────────────────────────────────
    if (captchaKey) {
      const sitekey = await page.evaluate(
        () => document.querySelector('[data-sitekey]')?.getAttribute('data-sitekey') ?? null
      );

      if (sitekey) {
        try {
          const pageUrl = page.url();
          const inData  = await (await fetch(
            `https://2captcha.com/in.php?key=${captchaKey}&method=userrecaptcha&googlekey=${encodeURIComponent(sitekey)}&pageurl=${encodeURIComponent(pageUrl)}&json=1`
          )).json();
          if (inData.status !== 1) throw new Error('2captcha submit: ' + inData.request);

          let token = null;
          for (let i = 0; i < 30; i++) {
            await sleep(3000);
            const poll = await (await fetch(
              `https://2captcha.com/res.php?key=${captchaKey}&action=get&id=${inData.request}&json=1`
            )).json();
            if (poll.status === 1) { token = poll.request; break; }
            if (poll.request !== 'CAPCHA_NOT_READY') throw new Error('2captcha poll: ' + poll.request);
          }

          if (token) {
            await page.evaluate((t) => {
              const ta = document.querySelector('#g-recaptcha-response, textarea[name="g-recaptcha-response"]');
              if (ta) { ta.style.display = 'block'; ta.value = t; }
              try {
                for (const c of Object.values(window.___grecaptcha_cfg?.clients || {})) {
                  for (const v of Object.values(c)) {
                    if (v && typeof v.callback === 'function') v.callback(t);
                  }
                }
              } catch (_) {}
            }, token);
            await sleep(500);
          }
        } catch (capErr) {
          console.warn('[autopost] captcha skipped:', capErr.message);
        }
      }
    }

    // ── Step 5: Submit ────────────────────────────────────────────────────────
    const submitEl = await page.$(
      'button[type="submit"], input[type="submit"], button.submit, button.post, [class*="submit-btn"], [class*="post-btn"]'
    );

    if (submitEl) {
      await submitEl.click();
    } else {
      const submitted = await page.evaluate(() => {
        const form = document.querySelector('form');
        if (form) { form.submit(); return true; }
        return false;
      });
      if (!submitted) return await fail('No submit button or form found');
    }

    await page.waitForLoadState('networkidle').catch(() => {});
    await sleep(waitAfterSubmit);

    const finalUrl  = page.url();
    const pageTitle = await page.title().catch(() => '');

    // Detect failure redirects
    const lower = finalUrl.toLowerCase();
    for (const pat of ['login', 'signin', '/error', '?error', 'captcha', 'banned', 'blocked']) {
      if (lower.includes(pat)) return await fail('Redirected to failure URL: ' + finalUrl);
    }

    await browser.close();
    return { ok: true, url: finalUrl, title: pageTitle };

  } catch (err) {
    return await fail(err.message || String(err));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Vercel handler
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-API-Key,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!checkAuth(req))       return res.status(401).json({ ok: false, error: 'Unauthorized' });
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });

  const body   = req.body || {};
  const action = (body.action || 'visit').trim();

  try {
    const result = action === 'autopost'
      ? await actionAutopost(body)
      : await actionVisit(body);
    return res.status(result.ok ? 200 : 500).json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
}
