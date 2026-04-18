// api/register.js — Platform-aware Playwright registration engine
//
// Frontend sends:
//   POST { platform, username, password, captchaKey, useMailTm, autoVerify }
//   (AC Engine v2 — platform ID is mapped server-side to signup URL)
//
// Also accepts legacy shape:
//   POST { url, email, password, username, ... }
//
// Returns:
//   { ok, email, apiKey, profileUrl, verifyStatus, note, log[] }

import { handleCors, checkAuth }                                       from '../lib/auth.js';
import { launchBrowser, createContext,
         injectCaptchaToken, clickSubmit,
         fillForm, detectOutcome }                                      from '../lib/playwright-helpers.js';
import { createInbox, pollForVerifyLink }                               from '../lib/mailtm.js';
import { pickSolver, solveCaptcha }                                     from '../lib/captcha-solver.js';

export const config = { maxDuration: 180 };

// ── Platform → signup URL map (mirrors frontend signupMap + extras) ──────────
const PLATFORM_SIGNUP_URLS = {
  wordpress:  'https://wordpress.com/start',
  medium:     'https://medium.com/m/signin',
  reddit:     'https://www.reddit.com/register',
  quora:      'https://www.quora.com/signup',
  tumblr:     'https://www.tumblr.com/register',
  weebly:     'https://www.weebly.com/signup',
  blogger:    'https://accounts.google.com/signin',  // requires Google OAuth
  wix:        'https://users.wix.com/signin?signupFirst=true',
  devto:      'https://dev.to/enter?state=new-user',
  hashnode:   'https://hashnode.com/onboard',
  strikingly: 'https://app.strikingly.com/users/sign_up',
  site123:    'https://www.site123.com/signup',
  // extras
  github:     'https://github.com/signup',
  gitlab:     'https://gitlab.com/users/sign_up',
  netlify:    'https://app.netlify.com/signup',
  vercel:     'https://vercel.com/signup',
  notion:     'https://www.notion.so/signup',
  substack:   'https://substack.com/signup',
  ghost:      'https://account.ghost.org/signup',
  linkedin:   'https://www.linkedin.com/signup',
  pinterest:  'https://www.pinterest.com/join/',
  mix:        'https://mix.com/register',
  livejournal:'https://www.livejournal.com/create/',
};

// ── Post-registration API token extraction hints per platform ────────────────
// After a successful signup some platforms redirect to an API token page.
// We attempt to scrape it from the final page DOM.
const TOKEN_SELECTORS = {
  devto:    ['input[id*="api"][type="text"]', 'code'],
  hashnode: ['input[placeholder*="token" i]', 'code'],
  ghost:    ['input[id*="token" i]', 'code'],
  medium:   ['input[id*="token" i]', 'code'],
};

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function buildProfile(email, username, overrides = {}) {
  const firstNames = ['Alex','Jordan','Morgan','Taylor','Casey','Riley','Avery','Blake','Drew','Jamie'];
  const lastNames  = ['Smith','Johnson','Williams','Brown','Jones','Davis','Garcia','Wilson','Moore','Taylor'];
  const fn = firstNames[rand(0, firstNames.length - 1)];
  const ln = lastNames[rand(0, lastNames.length - 1)];
  return {
    email,
    password:   overrides.password || ('Str0ng#' + Math.random().toString(36).slice(2,8) + '!' + rand(10,99)),
    username:   username || (email.split('@')[0].replace(/[^a-zA-Z0-9]/g,'').slice(0,12) + rand(10,99)),
    firstName:  fn,
    lastName:   ln,
    fullName:   `${fn} ${ln}`,
    phone:      `+1${rand(2002000000, 9999999999)}`,
    website:    '',
    bio:        'Digital content creator and SEO professional.',
    city:       'New York',
    country:    'US',
    zipcode:    '10001',
    birthYear:  String(rand(1985, 1998)),
    birthMonth: String(rand(1, 12)).padStart(2, '0'),
    birthDay:   String(rand(1, 28)).padStart(2, '0'),
    ...overrides,
  };
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!checkAuth(req, res))  return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const body = req.body || {};

  // ── Resolve target URL ────────────────────────────────────────────────────
  // Accept either { platform } (frontend v2 shape) or legacy { url }
  let targetUrl = body.url || null;
  const platform = (body.platform || '').toLowerCase();

  if (!targetUrl && platform) {
    targetUrl = PLATFORM_SIGNUP_URLS[platform] || null;
    if (!targetUrl) {
      return res.status(400).json({
        ok: false,
        error: `Unknown platform "${platform}". Pass a direct url instead, or use one of: ${Object.keys(PLATFORM_SIGNUP_URLS).join(', ')}`,
      });
    }
  }

  if (!targetUrl) {
    return res.status(400).json({ ok: false, error: 'Provide either platform or url' });
  }

  // ── Build user profile ────────────────────────────────────────────────────
  const {
    username    = '',
    password    = '',
    captchaKey  = null,
    useMailTm   = true,
    autoVerify  = true,
    firstName   = null,
    lastName    = null,
    proxy       = null,
  } = body;

  const log = [];
  const L   = (msg, cls = 'tm') => { log.push({ msg, cls }); console.log('[register]', msg); };

  const result = {
    ok: false, email: null, apiKey: null,
    profileUrl: null, verifyStatus: 'unverified',
    note: '', log,
    captchaSolved: false, formFields: [],
  };

  let email    = body.email || null;
  let inboxToken = null;
  let browser, context, page;

  try {
    // ── 1. Create disposable inbox if useMailTm ───────────────────────────
    if (useMailTm && !email) {
      L('📬 Creating disposable inbox via mail.tm…', 'tm');
      try {
        const inbox  = await createInbox();
        email        = inbox.address;
        inboxToken   = inbox.token;
        L(`  ✔ Inbox: ${email}`, 't-info');
      } catch (e) {
        L(`  ⚠ mail.tm failed (${e.message}) — using generated email`, 't-warn');
        email = `${username || 'user'}${rand(1000,9999)}@tempmail.io`;
      }
    } else if (!email) {
      email = `${username || 'seouser'}${rand(1000,9999)}@outlook.com`;
    }

    result.email = email;

    const profile = buildProfile(email, username, {
      password:  password || undefined,
      firstName: firstName || undefined,
      lastName:  lastName  || undefined,
    });

    L(`🌐 Launching Chromium → ${targetUrl}`, 't-accent');
    browser = await launchBrowser({ proxy });
    context = await createContext(browser);
    page    = await context.newPage();

    // ── 2. Navigate to signup page ────────────────────────────────────────
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    L(`  ✔ Loaded: ${await page.title()}`, 't-info');

    // ── 3. Find registration form if not already on one ───────────────────
    const isRegPage = await page.evaluate(() => {
      const pw  = document.querySelectorAll('input[type="password"]').length;
      const em  = document.querySelectorAll('input[type="email"],input[name*="email"]').length;
      const txt = (document.body?.innerText || '').toLowerCase().slice(0, 1000);
      return pw >= 1 || em >= 1 || /sign.?up|register|create.+account|join.+free/i.test(txt);
    });

    if (!isRegPage) {
      L('  🔍 Not on reg page — searching for signup link…', 'tm');
      const signupSelectors = [
        'a[href*="signup"]', 'a[href*="register"]', 'a[href*="join"]',
        'a[href*="create-account"]', 'a[href*="sign-up"]', 'a[href*="enroll"]',
        'a:text-matches("sign up", "i")', 'a:text-matches("register", "i")',
        'a:text-matches("create account", "i")', 'a:text-matches("get started", "i")',
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
              page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {}),
              el.click(),
            ]);
            found = true;
            break;
          }
        } catch (_) {}
      }
      if (!found) L('  ⚠ No signup link found — trying form on current page', 't-warn');
      await page.waitForTimeout(2000);
    } else {
      L('  ✔ Already on registration page', 't-info');
    }

    // ── 4. Fill the form ──────────────────────────────────────────────────
    L('  📝 Filling form fields…', 'tm');
    const filled = await fillForm(page, profile);
    result.formFields = filled;
    L(`  → Filled: ${filled.join(', ') || 'none detected'}`, 'tm');

    // ── 5. Detect and solve CAPTCHA ───────────────────────────────────────
    const captchaData = await page.evaluate(() => {
      const rcEl = document.querySelector('.g-recaptcha, [data-sitekey]');
      if (rcEl) return { type: 'recaptcha_v2', sitekey: rcEl.getAttribute('data-sitekey') };
      const rc3 = document.querySelector('script[src*="recaptcha/api.js?render="]');
      if (rc3) { const m = rc3.src.match(/render=([^&]+)/); if (m) return { type: 'recaptcha_v3', sitekey: m[1] }; }
      const hcEl = document.querySelector('.h-captcha, [data-hcaptcha-sitekey]');
      if (hcEl) return { type: 'hcaptcha', sitekey: hcEl.getAttribute('data-sitekey') };
      const cfEl = document.querySelector('[data-cf-turnstile-sitekey], .cf-turnstile');
      if (cfEl) return { type: 'turnstile', sitekey: cfEl.getAttribute('data-sitekey') };
      return null;
    });

    if (captchaData?.sitekey) {
      L(`  🔐 CAPTCHA detected: ${captchaData.type}`, 't-warn');
      const { solver, apiKey: solverKey } = pickSolver(null, captchaKey);
      if (solver && solverKey) {
        L(`  → Solving via ${solver}…`, 'tm');
        const solved = await solveCaptcha(solver, solverKey, {
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
        L('  ⚠ No captcha solver configured — submission may fail', 't-warn');
      }
    }

    // ── 6. Submit ─────────────────────────────────────────────────────────
    const submitUrl = page.url();
    await page.waitForTimeout(400 + Math.random() * 600);
    L('  🚀 Submitting form…', 'tm');
    const clicked = await clickSubmit(page);
    if (!clicked) L('  ⚠ No submit button found — tried form.submit()', 't-warn');
    await page.waitForTimeout(3500);

    // ── 7. Detect outcome ─────────────────────────────────────────────────
    const outcome = await detectOutcome(page, submitUrl);
    result.profileUrl = outcome.finalUrl;
    result.note       = outcome.note;

    if (outcome.success) {
      result.ok = true;
      L(`  ✔ Registration accepted → ${outcome.finalUrl}`, 't-info');
    } else if (outcome.error) {
      L('  ✗ Error signals detected on page', 't-err');
    } else {
      result.ok = true; // ambiguous — treat as OK
      L('  ⚠ Ambiguous outcome — treating as success', 't-warn');
    }

    // ── 8. Try to scrape API token if platform supports it ────────────────
    if (result.ok && TOKEN_SELECTORS[platform]) {
      for (const sel of TOKEN_SELECTORS[platform]) {
        try {
          const val = await page.$eval(sel, el => el.value || el.textContent || '');
          if (val && val.trim().length > 8) {
            result.apiKey = val.trim();
            L(`  🔑 API token found: ${result.apiKey.slice(0, 20)}…`, 't-accent');
            break;
          }
        } catch (_) {}
      }
    }

    // ── 9. Email verification polling ─────────────────────────────────────
    if (autoVerify && result.ok && inboxToken) {
      L('  📬 Polling for verification email (up to 90s)…', 'tm');
      const link = await pollForVerifyLink(inboxToken, 90000);
      if (link) {
        result.verifyLink = link;
        L(`  → Verify link: ${link.slice(0, 80)}`, 't-info');
        try {
          await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await page.waitForTimeout(2000);
          result.verifyStatus = 'verified';
          L('  ✔ Email verified!', 't-info');
        } catch (e) {
          result.verifyStatus = 'link_found_click_failed';
          L(`  ⚠ Click failed: ${e.message}`, 't-warn');
        }
      } else {
        result.verifyStatus = 'no_email_received';
        L('  ⚠ No verification email within 90s', 't-warn');
      }
    } else if (!inboxToken && result.ok) {
      result.verifyStatus = 'manual_verify_needed';
    }

  } catch (err) {
    L(`  💥 Fatal: ${err.message}`, 't-err');
    result.note = err.message;
    console.error('[register] fatal:', err);
  } finally {
    await browser?.close().catch(() => {});
  }

  return res.status(result.ok ? 200 : 500).json(result);
}
