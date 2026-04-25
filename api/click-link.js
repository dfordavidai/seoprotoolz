// api/click-link.js — Headless browser: CTR simulator + Universal Auto-Poster
//
// ── ACTION: "visit" (default) ─────────────────────────────────────────────────
// POST {
//   action?:       "visit"  (default if omitted)
//   url:           string   (URL to visit)
//   proxy?:        string   (http://user:pass@host:port)
//   dwellMs?:      number   (ms to stay on page, default 8000)
//   scrollDepth?:  number   (0.0–1.0, how far to scroll, default 0.6)
//   clickLinks?:   bool     (click internal links to simulate navigation, default false)
//   screenshotB64?:bool     (return base64 screenshot on success, default false)
// }
// Returns: { ok, finalUrl, title, status, dwellMs, scrolled, linksClicked, screenshotB64?, error? }
//
// ── ACTION: "autopost" ────────────────────────────────────────────────────────
// POST {
//   action:        "autopost"
//   url:           string   (page with the post form)
//   loginUrl?:     string   (login page — navigated first if provided)
//   credentials?:  { username, password }
//   fields:        { subject?, body?, tags?, linkUrl?, anchor? }
//   captchaKey?:   string   (2captcha API key — only needed if site has captcha)
//   screenshotOnFail?: bool (default true)
//   waitAfterSubmit?:  number (ms to wait after clicking submit, default 4000)
// }
// Returns: { ok, url, title, fieldsFilled, error?, screenshot? }

import { handleCors, checkAuth } from '../lib/auth.js';
import { launchBrowser, createContext } from '../lib/playwright-helpers.js';

export const config = { maxDuration: 120 };

// ═════════════════════════════════════════════════════════════════════════════
// AUTOPOST HELPERS
// ═════════════════════════════════════════════════════════════════════════════

// Native-fill: bypasses React/Vue synthetic event guards
async function nativeFill(page, selector, value) {
  const el = await page.$(selector);
  if (!el) return false;
  const tag = await el.evaluate(e => e.tagName.toLowerCase());
  if (tag === 'select') {
    await page.selectOption(selector, { label: value }).catch(() =>
      page.selectOption(selector, { value }).catch(() => {})
    );
  } else {
    await el.click({ clickCount: 3 });
    await el.fill(value);
    await el.dispatchEvent('input');
    await el.dispatchEvent('change');
  }
  return true;
}

// Rich-text editor fill (Quill / ProseMirror / TipTap / TinyMCE)
async function fillRichEditor(page, value) {
  const selectors = ['.ql-editor', '.ProseMirror', '[contenteditable="true"]', '.tox-edit-area__iframe'];
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (!el) continue;
    if (sel.includes('iframe')) {
      const frame = await el.contentFrame();
      if (frame) { await frame.evaluate(v => { document.body.innerHTML = v; }, value); return true; }
    }
    await el.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type(value, { delay: 10 });
    return true;
  }
  return false;
}

// Smart field mapping patterns
const FIELD_PATTERNS = {
  subject: /title|subject|headline|topic|post.?title/i,
  body:    /\bbody\b|content|message|post.?body|description|text/i,
  tags:    /tag|keyword|categor/i,
  linkUrl: /url|website|href|link/i,
  anchor:  /anchor|link.?text|backlink/i,
};

async function fillForm(page, fields) {
  let filled = 0;
  const inputs = await page.$$('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select');

  for (const el of inputs) {
    const attrs = await el.evaluate(e => ({
      name:        e.name || '',
      id:          e.id || '',
      placeholder: e.placeholder || '',
      tag:         e.tagName.toLowerCase(),
    }));
    const needle = [attrs.name, attrs.id, attrs.placeholder].join('|');

    for (const [fieldKey, pattern] of Object.entries(FIELD_PATTERNS)) {
      if (!fields[fieldKey]) continue;
      if (fieldKey === 'linkUrl' && /image|img|media|avatar|photo/i.test(needle)) continue;
      if (!pattern.test(needle)) continue;
      const selector = attrs.id ? `#${attrs.id}` : attrs.name ? `[name="${attrs.name}"]` : null;
      if (!selector) continue;
      const ok = await nativeFill(page, selector, fields[fieldKey]);
      if (ok) { filled++; break; }
    }
  }

  // Nairaland direct-fill fallback (hard-coded selectors)
  for (const { sel, val } of [
    { sel: 'input[name=subject],#subject', val: fields.subject },
    { sel: 'textarea[name=body],#body',    val: fields.body },
  ]) {
    if (!val) continue;
    const el = await page.$(sel);
    if (!el) continue;
    const existing = await el.inputValue().catch(() => '');
    if (!existing) { await nativeFill(page, sel, val); filled++; }
  }

  // Rich editor fallback if body not filled
  if (fields.body) {
    const bodyEl = await page.$('textarea[name=body],#body,.ql-editor,.ProseMirror,[contenteditable="true"]');
    const bodyVal = bodyEl ? await bodyEl.inputValue().catch(() => '') : '';
    if (!bodyVal) { const ok = await fillRichEditor(page, fields.body); if (ok) filled++; }
  }

  return filled;
}

// 2captcha solver
async function solveCaptcha(page, captchaKey) {
  if (!captchaKey) return true;
  const rcEl = await page.$('.g-recaptcha,[data-sitekey]');
  const hcEl = await page.$('.h-captcha');
  if (!rcEl && !hcEl) return true;

  const sitekey = await (rcEl || hcEl).evaluate(e => e.dataset.sitekey || '');
  const type    = rcEl ? 'userrecaptcha' : 'hcaptcha';
  const pageUrl = page.url();

  const submitRes  = await fetch('https://2captcha.com/in.php', {
    method: 'POST',
    body:   new URLSearchParams({ key: captchaKey, method: type, googlekey: sitekey, pageurl: pageUrl, json: '1' }),
  });
  const submitData = await submitRes.json();
  if (submitData.status !== 1) throw new Error('2captcha submit failed: ' + submitData.request);

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const poll = await fetch(`https://2captcha.com/res.php?key=${captchaKey}&action=get&id=${submitData.request}&json=1`);
    const pd   = await poll.json();
    if (pd.status === 1) {
      await page.evaluate(token => {
        const ta = document.querySelector('textarea[name="g-recaptcha-response"],textarea[name="h-captcha-response"]');
        if (ta) { ta.value = token; ta.style.display = 'block'; }
        else {
          const t = document.createElement('textarea');
          t.name = 'g-recaptcha-response'; t.value = token; t.style.display = 'none';
          document.body.appendChild(t);
        }
        try {
          const cbs = Object.values(window.___grecaptcha_cfg?.clients || {});
          for (const cb of cbs) { if (cb?.V?.callback) { cb.V.callback(token); break; } }
        } catch (_) {}
      }, pd.request);
      return true;
    }
    if (pd.request !== 'CAPCHA_NOT_READY') throw new Error('2captcha: ' + pd.request);
  }
  throw new Error('Captcha timeout');
}

// Login helper
async function doLogin(page, loginUrl, credentials, captchaKey) {
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);
  const { username, password } = credentials;

  for (const sel of ['input[name=username]','input[name=email]','input[name=user]','input[type=email]','#username','#email']) {
    if (await page.$(sel)) { await nativeFill(page, sel, username); break; }
  }
  for (const sel of ['input[name=password]','input[name=pass]','input[type=password]','#password','#pass']) {
    if (await page.$(sel)) { await nativeFill(page, sel, password); break; }
  }

  await solveCaptcha(page, captchaKey);

  for (const sel of ['input[type=submit]','button[type=submit]','[name=submit]']) {
    const btn = await page.$(sel);
    if (btn) { await btn.click(); break; }
  }
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
}

// Find and click submit button
async function clickSubmit(page) {
  for (const sel of ['input[type=submit]','button[type=submit]','[type=submit]','[name=submit]']) {
    const btn = await page.$(sel);
    if (btn) { await btn.click(); return; }
  }
  // Fallback: find button by text
  const btn = await page.evaluateHandle(() =>
    Array.from(document.querySelectorAll('button,input[type=button]'))
      .find(b => /\bpost\b|submit|publish|send|create/i.test(b.value || b.textContent))
  );
  const el = btn.asElement ? btn.asElement() : null;
  if (el) { await el.click(); return; }
  throw new Error('No submit button found');
}

// ═════════════════════════════════════════════════════════════════════════════
// AUTOPOST ACTION
// ═════════════════════════════════════════════════════════════════════════════

async function handleAutopost(req, res) {
  const {
    url,
    loginUrl,
    credentials,
    fields            = {},
    captchaKey,
    screenshotOnFail  = true,
    waitAfterSubmit   = 4000,
  } = req.body || {};

  if (!url)                          return res.status(400).json({ ok: false, error: 'url required' });
  if (!fields.subject && !fields.body) return res.status(400).json({ ok: false, error: 'fields.subject or fields.body required' });

  let browser, screenshot = null;
  try {
    browser = await launchBrowser({});
    const context = await createContext(browser);
    const page    = await context.newPage();

    if (loginUrl && credentials?.username) {
      await doLogin(page, loginUrl, credentials, captchaKey);
    }

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const filled = await fillForm(page, fields);

    if (filled === 0) {
      if (screenshotOnFail) {
        const buf = await page.screenshot({ type: 'jpeg', quality: 60 });
        screenshot = buf.toString('base64');
      }
      await browser.close();
      return res.status(200).json({ ok: false, error: 'No form fields matched', screenshot });
    }

    await solveCaptcha(page, captchaKey);
    await page.waitForTimeout(1500);

    const startUrl = page.url();
    await clickSubmit(page);
    await page.waitForTimeout(waitAfterSubmit);

    const finalUrl   = page.url();
    const finalTitle = await page.title();
    const success    = finalUrl !== startUrl;

    if (!success && screenshotOnFail) {
      const buf = await page.screenshot({ type: 'jpeg', quality: 60 });
      screenshot = buf.toString('base64');
    }

    await browser.close();
    return res.status(200).json({
      ok:           success,
      url:          finalUrl,
      title:        finalTitle,
      fieldsFilled: filled,
      error:        success ? null : 'Submitted but no redirect detected — may be AJAX form',
      screenshot:   success ? null : screenshot,
    });

  } catch (err) {
    if (browser) {
      try {
        if (screenshotOnFail) {
          const pages = browser.contexts()?.[0]?.pages();
          if (pages?.length) {
            const buf = await pages[0].screenshot({ type: 'jpeg', quality: 60 }).catch(() => null);
            if (buf) screenshot = buf.toString('base64');
          }
        }
      } catch (_) {}
      await browser.close().catch(() => {});
    }
    console.error('[click-link/autopost]', err.message);
    return res.status(200).json({ ok: false, error: err.message, screenshot });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// VISIT ACTION (original click-link logic — untouched)
// ═════════════════════════════════════════════════════════════════════════════

async function handleVisit(req, res) {
  const {
    url,
    proxy         = null,
    dwellMs       = 8000,
    scrollDepth   = 0.6,
    clickLinks    = false,
    screenshotB64 = false,
  } = req.body || {};

  if (!url) return res.status(400).json({ error: 'url is required' });
  try { new URL(url); } catch (e) { return res.status(400).json({ error: 'Invalid URL' }); }

  const result = {
    ok: false, finalUrl: url, title: '', status: 0,
    dwellMs: 0, scrolled: false, linksClicked: 0, screenshotB64: null,
  };

  let browser, context, page;
  try {
    browser = await launchBrowser({ proxy });
    context = await createContext(browser);
    page    = await context.newPage();

    await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,mp4,mp3,avi}', r => r.abort());

    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    result.status   = resp?.status() || 0;
    result.finalUrl = page.url();
    result.title    = await page.title();

    if (!resp?.ok() && result.status >= 400) {
      result.note = `HTTP ${result.status}`;
      await browser.close();
      return res.status(200).json(result);
    }

    const scrollSteps = 8;
    for (let i = 1; i <= scrollSteps; i++) {
      const fraction = (i / scrollSteps) * scrollDepth;
      await page.evaluate(f => window.scrollTo(0, document.body.scrollHeight * f), fraction);
      await page.waitForTimeout(200 + Math.random() * 300);
    }
    result.scrolled = true;

    const clampedDwell = Math.min(Math.max(Number(dwellMs) || 8000, 2000), 55000);
    await page.waitForTimeout(clampedDwell);
    result.dwellMs = clampedDwell;

    if (clickLinks) {
      const origin = new URL(url).origin;
      const links  = await page.$$eval(
        'a[href]',
        (els, o) => els
          .filter(el => { try { return new URL(el.href).origin === o && el.offsetParent !== null; } catch { return false; } })
          .slice(0, 3).map(el => el.href),
        origin
      );
      for (const link of links) {
        try {
          await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 10000 });
          await page.waitForTimeout(1500 + Math.random() * 1500);
          result.linksClicked++;
        } catch (_) {}
      }
    }

    if (screenshotB64) {
      const shot = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false });
      result.screenshotB64 = shot.toString('base64');
    }

    result.ok = true;

  } catch (err) {
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    result.error = isTimeout ? 'Page load timed out' : err.message;
    console.error('[click-link]', err.message);
  } finally {
    await browser?.close().catch(() => {});
  }

  return res.status(result.ok ? 200 : 500).json(result);
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN HANDLER — routes by action
// ═════════════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!checkAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const action = req.body?.action || 'visit';

  if (action === 'autopost') return handleAutopost(req, res);
  return handleVisit(req, res);
}
