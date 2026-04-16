// api/register.js — Playwright-based account registration
// POST {
//   url:         string  (registration page URL)
//   email:       string
//   password:    string
//   username?:   string
//   firstName?:  string
//   lastName?:   string
//   proxy?:      string  (http://user:pass@host:port)
//   captchaKey?: string  (solver API key)
//   autoVerify?: bool    (poll for verification email - requires mail.tm account)
// }
// Returns: { ok, note, log[], formFields[], captchaSolved, verifyStatus, finalUrl }

import { handleCors, checkAuth } from '../lib/auth.js';
import { launchBrowser, createContext, injectCaptchaToken, clickSubmit, fillForm, detectOutcome } from '../lib/playwright-helpers.js';
import { createInbox, pollForVerifyLink } from '../lib/mailtm.js';
import { pickSolver, solveCaptcha } from '../lib/captcha-solver.js';

export const config = { maxDuration: 120 };

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!checkAuth(req, res)) return;

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const {
    url,
    email,
    password,
    username,
    firstName  = 'Alex',
    lastName   = 'Morgan',
    proxy      = null,
    captchaKey = null,
    autoVerify = false,
  } = req.body || {};

  if (!url)      return res.status(400).json({ error: 'url is required' });
  if (!email)    return res.status(400).json({ error: 'email is required' });
  if (!password) return res.status(400).json({ error: 'password is required' });

  const log         = [];
  const L           = (msg, cls = 'tm') => { log.push({ msg, cls }); console.log('[register]', msg); };
  const rand        = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  // Build user profile
  const profile = {
    email,
    password,
    username:   username || email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '') + rand(10, 99),
    firstName,
    lastName,
    fullName:   `${firstName} ${lastName}`,
    phone:      `+1${rand(2002000000, 9999999999)}`,
    website:    '',
    bio:        'Writer and content creator.',
    city:       'New York',
    country:    'US',
    zipcode:    '10001',
    birthYear:  String(rand(1985, 1998)),
    birthMonth: String(rand(1, 12)).padStart(2, '0'),
    birthDay:   String(rand(1, 28)).padStart(2, '0'),
  };

  const result = {
    ok: false, note: '', log,
    formFields: [], captchaSolved: false,
    verifyStatus: 'unverified', verifyLink: null, profileUrl: null,
    submitStatus: '',
  };

  let browser, context, page;

  try {
    // ── Launch browser ──────────────────────────────────────────────────────
    L(`🌐 Launching Chromium → ${url}`, 't-accent');
    browser = await launchBrowser({ proxy });
    context = await createContext(browser);
    page    = await context.newPage();

    // ── Navigate ────────────────────────────────────────────────────────────
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    L(`  ✔ Loaded: ${await page.title()}`, 't-info');

    // ── Find signup page if not already on one ──────────────────────────────
    const isRegPage = await page.evaluate(() => {
      const pw  = document.querySelectorAll('input[type="password"]').length;
      const em  = document.querySelectorAll('input[type="email"],input[name*="email"]').length;
      const txt = document.body?.innerText?.toLowerCase().slice(0, 1000) || '';
      return pw >= 1 || em >= 1 || /sign.?up|register|create.+account|join.+free/i.test(txt);
    });

    if (!isRegPage) {
      L('  🔍 Not on reg page — looking for signup link…', 'tm');
      const signupSelectors = [
        'a[href*="signup"]', 'a[href*="register"]', 'a[href*="join"]',
        'a[href*="create-account"]', 'a[href*="sign-up"]',
        'a:text-matches("sign up", "i")', 'a:text-matches("register", "i")',
        'a:text-matches("create account", "i")', 'a:text-matches("join", "i")',
        'button:text-matches("sign up", "i")', 'button:text-matches("register", "i")',
      ];
      let found = false;
      for (const sel of signupSelectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            const href = await el.getAttribute('href') || sel;
            L(`  → Clicking: ${href}`, 't-info');
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {}),
              el.click(),
            ]);
            found = true;
            break;
          }
        } catch (_) {}
      }
      if (!found) L('  ⚠ No signup link found — trying form on current page', 't-warn');
      await page.waitForTimeout(1500);
    } else {
      L('  ✔ Already on registration page', 't-info');
    }

    // ── Fill the form ───────────────────────────────────────────────────────
    L('  📝 Filling form fields…', 'tm');
    const filled = await fillForm(page, profile);
    result.formFields = filled;
    L(`  → Filled: ${filled.join(', ') || 'none detected'}`, 'tm');

    // ── Detect & solve CAPTCHA ──────────────────────────────────────────────
    const captchaData = await page.evaluate(() => {
      // reCAPTCHA v2
      const rcEl = document.querySelector('.g-recaptcha, [data-sitekey]');
      if (rcEl) return { type: 'recaptcha_v2', sitekey: rcEl.getAttribute('data-sitekey') };
      // reCAPTCHA v3
      const rc3 = document.querySelector('script[src*="recaptcha/api.js?render="]');
      if (rc3) {
        const m = rc3.src.match(/render=([^&]+)/);
        return m ? { type: 'recaptcha_v3', sitekey: m[1] } : null;
      }
      // hCaptcha
      const hcEl = document.querySelector('.h-captcha, [data-hcaptcha-sitekey]');
      if (hcEl) return { type: 'hcaptcha', sitekey: hcEl.getAttribute('data-sitekey') };
      return null;
    });

    if (captchaData?.sitekey) {
      L(`  🔐 CAPTCHA detected: ${captchaData.type} (${captchaData.sitekey})`, 't-warn');
      const { solver, apiKey } = pickSolver(null, captchaKey);
      if (solver && apiKey) {
        L(`  → Solving via ${solver}…`, 'tm');
        const solved = await solveCaptcha(solver, apiKey, {
          type:    captchaData.type,
          sitekey: captchaData.sitekey,
          pageurl: page.url(),
        });
        if (solved.ok) {
          await injectCaptchaToken(page, solved.solution);
          result.captchaSolved = true;
          L('  ✔ CAPTCHA solved & injected', 't-info');
        } else {
          L(`  ✗ CAPTCHA solve failed: ${solved.error}`, 't-err');
        }
      } else {
        L('  ⚠ No captcha solver configured — skipping', 't-warn');
      }
    }

    // ── Submit ──────────────────────────────────────────────────────────────
    const submitUrl = page.url();
    await page.waitForTimeout(500 + Math.random() * 500);
    L('  🚀 Submitting form…', 'tm');

    const clicked = await clickSubmit(page);
    if (!clicked) L('  ⚠ No submit button found — tried form.submit()', 't-warn');

    await page.waitForTimeout(3000);

    // ── Detect outcome ──────────────────────────────────────────────────────
    const outcome = await detectOutcome(page, submitUrl);
    result.submitStatus = outcome.note;
    result.profileUrl   = outcome.finalUrl;

    if (outcome.success) {
      L(`  ✔ Registration accepted: ${outcome.finalUrl}`, 't-info');
      result.ok   = true;
      result.note = outcome.note;
    } else if (outcome.error) {
      L('  ✗ Error signals detected on page', 't-err');
      result.note = outcome.note;
    } else {
      L('  ⚠ Ambiguous outcome — check manually', 't-warn');
      result.ok   = true; // treat as OK when unsure
      result.note = outcome.note;
    }

    // ── Email verification ──────────────────────────────────────────────────
    if (autoVerify && result.ok) {
      L('  📬 Polling for verification email (up to 90s)…', 'tm');
      // We can only auto-verify if email was created via mail.tm
      // Check env for a mail.tm token stored during account creation
      const mailtmToken = process.env.__MAILTM_TOKEN__;
      if (mailtmToken) {
        const link = await pollForVerifyLink(mailtmToken, 90000);
        if (link) {
          L(`  → Found verify link: ${link.slice(0, 80)}`, 't-info');
          result.verifyLink = link;
          await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 20000 });
          result.verifyStatus = 'verified';
          L('  ✔ Email verified!', 't-info');
        } else {
          L('  ⚠ No verification email received in 90s', 't-warn');
          result.verifyStatus = 'timeout';
        }
      } else {
        result.verifyStatus = 'skipped';
        L('  ⚠ autoVerify requires mail.tm token — use /api/universal-register for full auto-verify', 't-warn');
      }
    }

  } catch (err) {
    L(`  💥 Fatal error: ${err.message}`, 't-err');
    result.note = err.message;
    console.error('[register] fatal:', err);
  } finally {
    await browser?.close().catch(() => {});
  }

  return res.status(result.ok ? 200 : 500).json(result);
}
