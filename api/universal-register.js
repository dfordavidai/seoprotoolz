// api/universal-register.js — Full auto-registration with disposable email + captcha
// Creates a fresh mail.tm inbox, registers on the target site, polls for verify link
//
// POST {
//   url:         string   (target site — homepage or signup page)
//   proxy?:      string   (http://user:pass@host:port)
//   captchaKey?: string   (solver API key override)
//   solver?:     string   ('twocaptcha'|'anticaptcha'|'capmonster')
//   profile?:    object   (override any generated profile fields)
//   headless?:   bool     (default true)
// }
// Returns: { ok, email, password, username, note, log[], captchaSolved,
//            verifyStatus, verifyLink, profileUrl, formFields[] }

import { handleCors, checkAuth } from '../lib/auth.js';
import { launchBrowser, createContext, injectCaptchaToken, clickSubmit, fillForm, detectOutcome } from '../lib/playwright-helpers.js';
import { createInbox, pollForVerifyLink } from '../lib/mailtm.js';
import { pickSolver, solveCaptcha } from '../lib/captcha-solver.js';

export const config = { maxDuration: 120 };

// ── Field map for smart form detection ───────────────────────────────────────
const FIELD_MAP = {
  email:      ['email','e-mail','mail','correo','emailaddress','user_email','login_email'],
  username:   ['username','user_name','userid','login','handle','nickname','nick','screen_name','display_name','user_login','uname'],
  password:   ['password','passwd','pass','pwd','new_password','password1','account_password'],
  password2:  ['password_confirmation','password2','confirm_password','retype_password','repeat_password','confirmpassword','pass2','verify_password','password_confirm'],
  firstName:  ['first_name','firstname','fname','given_name','forename','name_first','first','prenom'],
  lastName:   ['last_name','lastname','lname','family_name','surname','name_last','last','nom'],
  fullName:   ['full_name','fullname','your_name','real_name','author_name','complete_name'],
  phone:      ['phone','telephone','tel','mobile','cell','phone_number','mobile_number'],
  website:    ['website','url','site','homepage','blog','portfolio'],
  bio:        ['bio','about','description','about_me','biography','introduction'],
  city:       ['city','town','locality'],
  country:    ['country','nation','country_code'],
  zipcode:    ['zip','zipcode','postal_code','postcode'],
  birthYear:  ['birth_year','year','dob_year','birthday_year'],
  birthMonth: ['birth_month','month','dob_month','birthday_month'],
  birthDay:   ['birth_day','day','dob_day','birthday_day'],
  gender:     ['gender','sex'],
};

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randStr(n = 6) { return Math.random().toString(36).slice(2, 2 + n); }

function buildProfile(email, overrides = {}) {
  const base = ['Alex','Jordan','Morgan','Taylor','Casey','Riley','Avery','Blake'];
  const surnm = ['Smith','Johnson','Williams','Brown','Jones','Davis','Garcia','Wilson'];
  const fn = base[rand(0, base.length - 1)];
  const ln = surnm[rand(0, surnm.length - 1)];
  return {
    email,
    password:   'Str0ng#' + randStr(6) + '!' + rand(10, 99),
    username:   email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) + rand(10, 99),
    firstName:  fn,
    lastName:   ln,
    fullName:   `${fn} ${ln}`,
    phone:      `+1${rand(2002000000, 9999999999)}`,
    website:    '',
    bio:        'Passionate writer and digital creator.',
    city:       'New York',
    country:    'US',
    zipcode:    '10001',
    birthYear:  String(rand(1985, 1998)),
    birthMonth: String(rand(1, 12)).padStart(2, '0'),
    birthDay:   String(rand(1, 28)).padStart(2, '0'),
    ...overrides,
  };
}

// Detect which profile field an input element maps to (runs in browser context)
function detectFieldClient(nameAttr, idAttr, phAttr, typeAttr, fieldMap) {
  const combined = [nameAttr, idAttr, phAttr].join(' ').toLowerCase();
  for (const [field, patterns] of Object.entries(fieldMap)) {
    if (patterns.some(p => combined.includes(p))) return field;
  }
  if (typeAttr === 'email')    return 'email';
  if (typeAttr === 'password') return 'password';
  if (typeAttr === 'tel')      return 'phone';
  if (typeAttr === 'url')      return 'website';
  return null;
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!checkAuth(req, res)) return;

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const {
    url,
    proxy      = null,
    captchaKey = null,
    solver:    preferredSolver = null,
    profile:   profileOverride = {},
  } = req.body || {};

  if (!url) return res.status(400).json({ error: 'url is required' });

  const log = [];
  const L = (msg, cls = 'tm') => { log.push({ msg, cls }); console.log('[universal-register]', msg); };

  const result = {
    ok: false, email: null, password: null, username: null,
    note: '', log,
    captchaSolved: false, formFields: [],
    verifyStatus: 'unverified', verifyLink: null, profileUrl: null,
  };

  let browser, context, page;

  try {
    // ── 1. Create disposable email inbox ──────────────────────────────────
    L('📬 Creating disposable inbox via mail.tm…', 'tm');
    const inbox = await createInbox();
    result.email    = inbox.address;
    result.password = buildProfile(inbox.address, profileOverride).password;
    L(`  ✔ Inbox: ${inbox.address}`, 't-info');

    const profile = buildProfile(inbox.address, profileOverride);
    result.username = profile.username;

    // ── 2. Launch browser ──────────────────────────────────────────────────
    L(`🌐 Launching Chromium → ${url}`, 't-accent');
    browser = await launchBrowser({ proxy });
    context = await createContext(browser);
    page    = await context.newPage();

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    L(`  ✔ Loaded: ${await page.title()}`, 't-info');

    // ── 3. Navigate to registration form ──────────────────────────────────
    const isRegPage = await page.evaluate(() => {
      const pw  = document.querySelectorAll('input[type="password"]').length;
      const em  = document.querySelectorAll('input[type="email"],input[name*="email"]').length;
      const txt = document.body?.innerText?.toLowerCase().slice(0, 1000) || '';
      return pw >= 1 || em >= 1 || /sign.?up|register|create.+account|join.+free/i.test(txt);
    });

    if (!isRegPage) {
      L('  🔍 Searching for signup link…', 'tm');
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
            L(`  → Clicking signup link: ${href}`, 't-info');
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

    // ── 4. Smart form filling ─────────────────────────────────────────────
    L('  📝 Filling form fields…', 'tm');
    const filled = await fillForm(page, profile);
    result.formFields = filled;
    L(`  → Filled ${filled.length} field(s): ${filled.slice(0, 8).join(', ')}`, 'tm');

    // ── 5. Captcha detection & solving ────────────────────────────────────
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
      L(`  🔐 Captcha: ${captchaData.type} (${captchaData.sitekey.slice(0, 20)}…)`, 't-warn');
      const { solver, apiKey } = pickSolver(preferredSolver, captchaKey);
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
          L('  ✔ Captcha solved & injected', 't-info');
        } else {
          L(`  ✗ Captcha failed: ${solved.error}`, 't-err');
        }
      } else {
        L('  ⚠ No captcha solver configured — submission may fail', 't-warn');
      }
    }

    // ── 6. Submit ─────────────────────────────────────────────────────────
    await page.waitForTimeout(500 + Math.random() * 500);
    const submitUrl = page.url();
    L('  🚀 Submitting…', 'tm');
    await clickSubmit(page);
    await page.waitForTimeout(3500);

    const outcome = await detectOutcome(page, submitUrl);
    result.profileUrl  = outcome.finalUrl;
    result.note        = outcome.note;

    if (outcome.success) {
      result.ok = true;
      L(`  ✔ Registered! → ${outcome.finalUrl}`, 't-info');
    } else if (outcome.error) {
      result.ok = false;
      L('  ✗ Error detected on page', 't-err');
    } else {
      result.ok = true; // ambiguous — treat as success
      L('  ⚠ Ambiguous outcome — treating as OK', 't-warn');
    }

    // ── 7. Email verification polling ─────────────────────────────────────
    if (result.ok) {
      L('  📬 Polling for verification email (90s)…', 'tm');
      const verifyLink = await pollForVerifyLink(inbox.token, 90000);
      if (verifyLink) {
        result.verifyLink = verifyLink;
        L(`  → Verify link found: ${verifyLink.slice(0, 80)}`, 't-info');

        // Click the verify link
        try {
          await page.goto(verifyLink, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await page.waitForTimeout(2000);
          result.verifyStatus = 'verified';
          L('  ✔ Email verified!', 't-info');
        } catch (e) {
          result.verifyStatus = 'link_found_click_failed';
          L(`  ⚠ Found link but click failed: ${e.message}`, 't-warn');
        }
      } else {
        result.verifyStatus = 'no_email_received';
        L('  ⚠ No verification email in 90s (some sites don\'t require it)', 't-warn');
      }
    }

  } catch (err) {
    L(`  💥 Fatal: ${err.message}`, 't-err');
    result.note = err.message;
    console.error('[universal-register] fatal:', err);
  } finally {
    await browser?.close().catch(() => {});
  }

  return res.status(result.ok ? 200 : 500).json(result);
}
