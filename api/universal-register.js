// api/universal-register.js — Learn-Once Replay-Always Universal Registration Engine
//
// First run on any site: deep-scans DOM, records EXACT selectors → saves schema to Supabase
// Subsequent runs: loads saved schema, fills deterministically — 100% hit rate
//
// POST {
//   url:         string   (target site — homepage or signup page)
//   proxy?:      string   (http://user:pass@host:port)
//   captchaKey?: string   (solver API key override)
//   solver?:     string   ('twocaptcha'|'anticaptcha'|'capmonster')
//   profile?:    object   (override any generated profile fields)
//   headless?:   bool     (default true)
//   forceLearn?: bool     (force re-learn even if schema exists)
// }
// Returns: { ok, email, password, username, note, log[], captchaSolved,
//            verifyStatus, verifyLink, profileUrl, formFields[], schemaMode }

import { handleCors, checkAuth } from '../lib/auth.js';
import { launchBrowser, createContext, injectCaptchaToken, clickSubmit, detectOutcome } from '../lib/playwright-helpers.js';
import { createInbox, pollForVerifyLink } from '../lib/mailtm.js';
import { pickSolver, solveCaptcha } from '../lib/captcha-solver.js';

export const config = { maxDuration: 120 };

// ── Supabase schema persistence (uses existing SUPABASE_URL + SUPABASE_SERVICE_KEY env vars) ──
const SUPABASE_URL         = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';
const SCHEMA_TABLE         = 'site_form_schemas';

// In-memory fallback for cold starts when Supabase isn't configured
const MEM_CACHE = {};

function siteKey(url) {
  try { const u = new URL(url); return (u.hostname + u.pathname).replace(/\/+$/, '').toLowerCase(); }
  catch { return url.toLowerCase().slice(0, 120); }
}

async function schemaGet(key) {
  // Memory first
  if (MEM_CACHE[key]) return MEM_CACHE[key];
  // Supabase
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${SCHEMA_TABLE}?site_key=eq.${encodeURIComponent(key)}&select=schema_json&limit=1`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!rows?.length) return null;
    const schema = JSON.parse(rows[0].schema_json);
    MEM_CACHE[key] = schema;
    return schema;
  } catch { return null; }
}

async function schemaSave(key, schema) {
  MEM_CACHE[key] = schema;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/${SCHEMA_TABLE}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ site_key: key, schema_json: JSON.stringify(schema), updated_at: new Date().toISOString() }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* non-fatal — memory cache still works */ }
}

// ── Profile builder ───────────────────────────────────────────────────────────
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randStr(n = 6) { return Math.random().toString(36).slice(2, 2 + n); }

function buildProfile(email, overrides = {}) {
  const firstNames = ['Alex','Jordan','Morgan','Taylor','Casey','Riley','Avery','Blake','Drew','Jamie'];
  const lastNames  = ['Smith','Johnson','Williams','Brown','Jones','Davis','Garcia','Wilson','Moore','Taylor'];
  const fn = firstNames[rand(0, firstNames.length - 1)];
  const ln = lastNames[rand(0, lastNames.length - 1)];
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
    gender:     'Male',
    ...overrides,
  };
}

// ── LEARN phase: deep DOM scan to build exact selectors per field ─────────────
// Runs in browser context via page.evaluate()
const LEARN_SCRIPT = `(function learnForm() {
  const FIELD_PATTERNS = {
    email:     [/email|e-mail|mail|correo/i],
    username:  [/user.?name|userid|login|handle|nickname|nick|screen.?name|display.?name|user.?login|\\buname\\b/i],
    password:  [/^password$|^passwd$|^pass$|^pwd$|new.?password|password1|account.?password|^pw$/i],
    password2: [/password.?confirm|confirm.?pass|password2|retype|repeat.*pass|verify.*pass|pass2/i],
    firstName: [/first.?name|fname|given.?name|forename|name.?first|^first$/i],
    lastName:  [/last.?name|lname|family.?name|surname|name.?last|^last$/i],
    fullName:  [/full.?name|your.?name|real.?name|author.?name|complete.?name|^name$/i],
    phone:     [/phone|telephone|^tel$|mobile|cell|phone.?number|mobile.?number/i],
    website:   [/website|^url$|^site$|homepage|blog|portfolio/i],
    bio:       [/\\bbio\\b|about.?me|biography|introduction|^description$/i],
    city:      [/^city$|^town$|locality/i],
    country:   [/^country$|nation|country.?code/i],
    zipcode:   [/^zip$|zipcode|postal.?code|postcode/i],
    birthYear: [/birth.?year|year.?of.?birth|dob.?year|^year$/i],
    birthMonth:[/birth.?month|dob.?month|^month$/i],
    birthDay:  [/birth.?day|dob.?day|^day$/i],
    gender:    [/^gender$|^sex$/i],
  };

  function matchField(el) {
    const attrs = [
      el.getAttribute('name')||'',
      el.getAttribute('id')||'',
      el.getAttribute('placeholder')||'',
      el.getAttribute('aria-label')||'',
      el.getAttribute('autocomplete')||'',
    ].join(' ');
    const type = (el.getAttribute('type')||'text').toLowerCase();

    // type shortcuts
    if (type === 'email') return 'email';
    if (type === 'tel')   return 'phone';
    if (type === 'url')   return 'website';

    // Look at label text too
    let labelText = '';
    const id = el.getAttribute('id');
    if (id) { const lbl = document.querySelector('label[for="'+id+'"]'); if (lbl) labelText = lbl.textContent||''; }
    const combined = attrs + ' ' + labelText;

    // password special-case: check confirm patterns FIRST
    if (type === 'password') {
      for (const p of FIELD_PATTERNS.password2) { if (p.test(combined)) return 'password2'; }
      return 'password';
    }

    for (const [field, patterns] of Object.entries(FIELD_PATTERNS)) {
      for (const p of patterns) { if (p.test(combined)) return field; }
    }
    return null;
  }

  function uniqueSelector(el) {
    // Prefer id
    if (el.id) return '#' + CSS.escape(el.id);
    // name attribute
    const name = el.getAttribute('name');
    const tag  = el.tagName.toLowerCase();
    if (name) return tag + '[name="' + name + '"]';
    // Build path
    const parts = [];
    let node = el;
    while (node && node !== document.body) {
      let sel = node.tagName.toLowerCase();
      if (node.id) { sel = '#' + CSS.escape(node.id); parts.unshift(sel); break; }
      const siblings = node.parentNode ? Array.from(node.parentNode.children).filter(c => c.tagName === node.tagName) : [];
      if (siblings.length > 1) sel += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      parts.unshift(sel);
      node = node.parentNode;
    }
    return parts.join(' > ');
  }

  const fields = [];
  const seenFields = new Set();

  // Step 1: find the best form (most inputs)
  const forms = Array.from(document.querySelectorAll('form'));
  const allInputs = forms.length
    ? forms.sort((a,b) => b.querySelectorAll('input,select,textarea').length - a.querySelectorAll('input,select,textarea').length)[0]
           .querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]):not([type=file]),select,textarea')
    : document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]):not([type=file]),select,textarea');

  for (const el of allInputs) {
    try {
      // Must be visible
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

      const tag  = el.tagName.toLowerCase();
      const type = (el.getAttribute('type')||'text').toLowerCase();

      let profileKey = null;
      if (tag === 'select') {
        profileKey = matchField(el) || 'select:' + (el.getAttribute('name')||el.getAttribute('id')||'');
      } else if (type === 'checkbox') {
        profileKey = 'checkbox:' + (el.getAttribute('name')||el.getAttribute('id')||'terms');
      } else if (type === 'radio') {
        profileKey = 'radio:' + (el.getAttribute('name')||el.getAttribute('id')||'');
      } else {
        profileKey = matchField(el);
      }

      if (!profileKey) continue;

      // Deduplicate: same profileKey shouldn't appear twice unless it's password (pw + pw2)
      const dedupeKey = profileKey === 'password2' ? 'password2' : profileKey === 'password' ? 'password' : profileKey;
      if (seenFields.has(dedupeKey) && !['password','password2'].includes(profileKey)) continue;
      seenFields.add(dedupeKey);

      fields.push({
        profileKey,
        selector: uniqueSelector(el),
        tag,
        type,
        name: el.getAttribute('name')||'',
        id:   el.getAttribute('id')||'',
      });
    } catch(e) {}
  }

  // Step 2: detect submit button
  const submitSelectors = [
    'button[type="submit"]','input[type="submit"]',
    'button:not([type="button"])[class*="submit"]',
    'button:not([type="button"])[class*="register"]',
    'button:not([type="button"])[class*="signup"]',
    '#submit-btn','#registerBtn','#signupBtn','.submit-btn',
  ];
  let submitSel = null;
  for (const sel of submitSelectors) {
    try {
      const btn = document.querySelector(sel);
      if (btn) { submitSel = sel; break; }
    } catch {}
  }

  // Step 3: detect captcha
  let captcha = null;
  const rcEl = document.querySelector('.g-recaptcha,[data-sitekey]');
  if (rcEl) captcha = { type:'recaptcha_v2', sitekey: rcEl.getAttribute('data-sitekey') };
  const rc3 = document.querySelector('script[src*="recaptcha/api.js?render="]');
  if (!captcha && rc3) { const m = rc3.src.match(/render=([^&]+)/); if (m) captcha = { type:'recaptcha_v3', sitekey:m[1] }; }
  const hcEl = document.querySelector('.h-captcha,[data-hcaptcha-sitekey]');
  if (!captcha && hcEl) captcha = { type:'hcaptcha', sitekey: hcEl.getAttribute('data-sitekey') };

  return { fields, submitSel, captcha, url: location.href, learnedAt: Date.now() };
})()`;

// ── REPLAY phase: fill form using exact learned selectors ─────────────────────
async function replayForm(page, schema, profile) {
  const filled = [];
  const profileValues = {
    email:      profile.email,
    username:   profile.username,
    password:   profile.password,
    password2:  profile.password,
    firstName:  profile.firstName,
    lastName:   profile.lastName,
    fullName:   profile.fullName,
    phone:      profile.phone,
    website:    profile.website,
    bio:        profile.bio,
    city:       profile.city,
    country:    profile.country,
    zipcode:    profile.zipcode,
    birthYear:  profile.birthYear,
    birthMonth: profile.birthMonth,
    birthDay:   profile.birthDay,
    gender:     profile.gender,
  };

  for (const field of schema.fields) {
    try {
      const el = await page.$(field.selector);
      if (!el) {
        // Selector stale — try by name/id fallback
        const fallback = field.name
          ? await page.$(`[name="${field.name}"]`)
          : field.id ? await page.$(`#${field.id}`) : null;
        if (!fallback) continue;
      }
      const target = await page.$(field.selector) || (field.name ? await page.$(`[name="${field.name}"]`) : null) || (field.id ? await page.$(`#${field.id}`) : null);
      if (!target) continue;
      if (!await target.isVisible().catch(() => false)) continue;

      const pk = field.profileKey;

      if (pk.startsWith('checkbox:')) {
        const checked = await target.isChecked().catch(() => false);
        if (!checked) await target.check().catch(() => {});
        filled.push(pk);
        continue;
      }
      if (pk.startsWith('radio:')) {
        await target.check().catch(() => {});
        filled.push(pk);
        continue;
      }
      if (pk.startsWith('select:') || field.tag === 'select') {
        // Gender/country select — pick appropriate option
        await target.evaluate((sel, profileGender) => {
          if (!sel.options || sel.options.length < 2) return;
          const genderIdx = [...sel.options].findIndex(o => ['male','m','1'].includes(o.value.toLowerCase()));
          sel.selectedIndex = genderIdx > -1 ? genderIdx : 1;
          sel.dispatchEvent(new Event('change', {bubbles:true}));
        }, profile.gender).catch(() => {});
        filled.push(pk);
        continue;
      }

      const value = profileValues[pk];
      if (value !== undefined && value !== null && value !== '') {
        await target.fill(String(value)).catch(async () => {
          // Fallback for React-controlled inputs
          await target.click().catch(() => {});
          await target.type(String(value), {delay: 30}).catch(() => {});
        });
        await target.dispatchEvent('input').catch(() => {});
        await target.dispatchEvent('change').catch(() => {});
        filled.push(pk);
        await page.waitForTimeout(80 + Math.random() * 60);
      }
    } catch { /* skip unresponsive field */ }
  }
  return filled;
}

// ── Navigate to registration page ────────────────────────────────────────────
async function navigateToRegPage(page, url, L) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  L(`  ✔ Loaded: ${await page.title()}`, 't-info');

  const isRegPage = await page.evaluate(() => {
    const pw  = document.querySelectorAll('input[type="password"]').length;
    const em  = document.querySelectorAll('input[type="email"],input[name*="email"]').length;
    const txt = (document.body?.innerText || '').toLowerCase().slice(0, 1500);
    return pw >= 1 || em >= 1 || /sign.?up|register|create.+account|join.+free/i.test(txt);
  });

  if (isRegPage) { L('  ✔ Already on registration page', 't-info'); return true; }

  L('  🔍 Searching for signup link…', 'tm');
  const signupSelectors = [
    'a[href*="signup"]','a[href*="register"]','a[href*="join"]',
    'a[href*="create-account"]','a[href*="sign-up"]','a[href*="enroll"]',
    'a:text-matches("sign up","i")','a:text-matches("register","i")',
    'a:text-matches("create account","i")','a:text-matches("get started","i")',
    'button:text-matches("sign up","i")','button:text-matches("register","i")',
  ];
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
        await page.waitForTimeout(2000);
        return true;
      }
    } catch {}
  }
  L('  ⚠ No signup link found — trying form on current page', 't-warn');
  return false;
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!checkAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const {
    url,
    proxy           = null,
    captchaKey      = null,
    solver:  preferredSolver = null,
    profile: profileOverride = {},
    forceLearn      = false,
    _checkSchema    = false,
    _learnOnly      = false,
    schema:  clientSchema   = null,
  } = req.body || {};

  if (!url) return res.status(400).json({ error: 'url is required' });

  // Schema-check mode: just report if we have a saved schema (no browser launch)
  if (_checkSchema) {
    const key = siteKey(url);
    const schema = await schemaGet(key);
    return res.status(200).json({
      ok: true,
      schemaExists: !!schema,
      fieldCount: schema?.fields?.length || 0,
      learnedAt: schema?.learnedAt || null,
    });
  }

  // Learn-only mode: open site, scan the form DOM, save schema — no registration
  if (_learnOnly) {
    let browser2, context2, page2;
    try {
      browser2 = await launchBrowser({ proxy });
      context2 = await createContext(browser2);
      page2    = await context2.newPage();
      const L2 = () => {};
      await navigateToRegPage(page2, url, L2);
      await page2.waitForTimeout(2500);
      const schema = await page2.evaluate(new Function('return ' + LEARN_SCRIPT)()).catch(async () => {
        return await page2.evaluate(LEARN_SCRIPT).catch(() => null);
      });
      if (schema && schema.fields && schema.fields.length > 0) {
        const key = siteKey(url);
        await schemaSave(key, schema);
      }
      return res.status(200).json({ ok: true, schema: schema || null });
    } catch(e) {
      return res.status(200).json({ ok: false, schema: null, error: e.message });
    } finally {
      await browser2?.close().catch(() => {});
    }
  }

  const log = [];
  const L = (msg, cls = 'tm') => { log.push({ msg, cls }); console.log('[universal-register]', msg); };

  const result = {
    ok: false, email: null, password: null, username: null,
    note: '', log,
    captchaSolved: false, formFields: [],
    verifyStatus: 'unverified', verifyLink: null, profileUrl: null,
    schemaMode: 'unknown',
  };

  let browser, context, page;

  try {
    // ── 1. Create disposable email inbox ─────────────────────────────────────
    L('📬 Creating disposable inbox via mail.tm…', 'tm');
    const inbox = await createInbox();
    result.email = inbox.address;
    L(`  ✔ Inbox: ${inbox.address}`, 't-info');

    const profile = buildProfile(inbox.address, profileOverride);
    result.password = profile.password;
    result.username = profile.username;

    // ── 2. Check for existing schema ─────────────────────────────────────────
    const key = siteKey(url);
    // clientSchema: pre-learned schema sent directly from the Learn & Register frontend tab
    let schema = clientSchema || (forceLearn ? null : await schemaGet(key));

    if (clientSchema) {
      L(`📋 CLIENT SCHEMA — Using schema sent from Learn tab (${clientSchema.fields.length} fields)`, 't-accent');
      result.schemaMode = 'client';
      // Persist it so future runs can replay without re-learning
      await schemaSave(key, clientSchema);
    } else if (schema) {
      L(`📖 REPLAY MODE — Using saved schema (${schema.fields.length} fields learned ${new Date(schema.learnedAt).toLocaleDateString()})`, 't-accent');
      result.schemaMode = 'replay';
    } else {
      L('🧠 LEARN MODE — First run on this site, deep-scanning form…', 't-accent');
      result.schemaMode = 'learn';
    }

    // ── 3. Launch browser ─────────────────────────────────────────────────────
    L(`🌐 Launching Chromium → ${url}`, 'tm');
    browser = await launchBrowser({ proxy });
    context = await createContext(browser);
    page    = await context.newPage();

    await navigateToRegPage(page, url, L);

    // ── 4. Learn or Replay ────────────────────────────────────────────────────
    let filled = [];

    if (!schema || schema.fields.length === 0) {
      // LEARN: deep scan DOM
      L('  🔬 Deep-scanning form DOM…', 'tm');
      schema = await page.evaluate(new Function('return ' + LEARN_SCRIPT)()).catch(async () => {
        // evaluate with string
        return await page.evaluate(LEARN_SCRIPT);
      });

      if (!schema || !schema.fields || schema.fields.length === 0) {
        // Fallback: run the script as a string eval
        schema = await page.evaluate(eval(`(${LEARN_SCRIPT})`)).catch(() => null)
               || await page.evaluate(() => eval(`(function learnForm(){return {fields:[],submitSel:null,captcha:null,url:location.href,learnedAt:Date.now()}})()`));
      }

      L(`  ✔ Learned ${schema.fields?.length || 0} field(s): ${(schema.fields||[]).map(f=>f.profileKey).join(', ')}`, 't-info');

      if (schema.fields && schema.fields.length > 0) {
        await schemaSave(key, schema);
        L(`  💾 Schema saved to ${SUPABASE_URL ? 'Supabase' : 'memory'}`, 'tm');
      } else {
        L('  ⚠ No fields learned — falling back to heuristic fill', 't-warn');
        result.schemaMode = 'heuristic';
      }
    }

    // REPLAY (or heuristic fallback)
    if (schema.fields && schema.fields.length > 0) {
      L('  📝 Filling form fields via learned selectors…', 'tm');
      filled = await replayForm(page, schema, profile);
      L(`  → Filled ${filled.length} field(s): ${filled.join(', ')}`, 'tm');

      // If replay missed critical fields (email/password), attempt re-learn once
      const hasEmail    = filled.some(f => f === 'email');
      const hasPassword = filled.some(f => f === 'password');
      if ((!hasEmail || !hasPassword) && result.schemaMode === 'replay') {
        L('  ⚠ Replay missed critical fields — re-learning schema…', 't-warn');
        const freshSchema = await page.evaluate(LEARN_SCRIPT).catch(() => null);
        if (freshSchema && freshSchema.fields.length > 0) {
          schema = freshSchema;
          await schemaSave(key, schema);
          filled = await replayForm(page, schema, profile);
          L(`  → Re-fill: ${filled.length} fields: ${filled.join(', ')}`, 't-info');
          result.schemaMode = 'replay-relearned';
        }
      }
    } else {
      // Absolute fallback: heuristic fill (original behavior)
      L('  📝 Heuristic fill (no schema)…', 't-warn');
      const { fillForm } = await import('../lib/playwright-helpers.js');
      filled = await fillForm(page, profile);
      L(`  → Heuristic filled: ${filled.join(', ')}`, 'tm');
    }

    result.formFields = filled;

    // ── 5. CAPTCHA detection & solving ────────────────────────────────────────
    const captchaData = schema?.captcha || await page.evaluate(() => {
      const rcEl = document.querySelector('.g-recaptcha,[data-sitekey]');
      if (rcEl) return { type:'recaptcha_v2', sitekey:rcEl.getAttribute('data-sitekey') };
      const rc3 = document.querySelector('script[src*="recaptcha/api.js?render="]');
      if (rc3) { const m=rc3.src.match(/render=([^&]+)/); if(m) return {type:'recaptcha_v3',sitekey:m[1]}; }
      const hcEl = document.querySelector('.h-captcha,[data-hcaptcha-sitekey]');
      if (hcEl) return { type:'hcaptcha', sitekey:hcEl.getAttribute('data-sitekey') };
      return null;
    });

    if (captchaData?.sitekey) {
      L(`  🔐 CAPTCHA: ${captchaData.type} (${captchaData.sitekey.slice(0, 20)}…)`, 't-warn');
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
          L('  ✔ CAPTCHA solved & injected', 't-info');
        } else {
          L(`  ✗ CAPTCHA failed: ${solved.error}`, 't-err');
        }
      } else {
        L('  ⚠ No captcha solver configured', 't-warn');
      }
    }

    // ── 6. Submit ─────────────────────────────────────────────────────────────
    await page.waitForTimeout(500 + Math.random() * 500);
    const submitUrl = page.url();
    L('  🚀 Submitting…', 'tm');

    // Try learned submit selector first
    let submitted = false;
    if (schema?.submitSel) {
      try {
        const btn = await page.$(schema.submitSel);
        if (btn && await btn.isVisible()) { await btn.click(); submitted = true; }
      } catch {}
    }
    if (!submitted) await clickSubmit(page);

    await page.waitForTimeout(3500);

    const outcome = await detectOutcome(page, submitUrl);
    result.profileUrl = outcome.finalUrl;
    result.note       = outcome.note;

    if (outcome.success) {
      result.ok = true;
      L(`  ✔ Registered! → ${outcome.finalUrl}`, 't-info');
    } else if (outcome.error) {
      L('  ✗ Error detected on page', 't-err');

      // On failure with replay schema, invalidate & retry with fresh learn
      if (result.schemaMode === 'replay') {
        L('  🔄 Clearing stale schema — next run will re-learn', 't-warn');
        delete MEM_CACHE[key];
        // Remove from Supabase
        if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
          fetch(`${SUPABASE_URL}/rest/v1/${SCHEMA_TABLE}?site_key=eq.${encodeURIComponent(key)}`, {
            method: 'DELETE',
            headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
          }).catch(() => {});
        }
      }
    } else {
      result.ok = true;
      L('  ⚠ Ambiguous outcome — treating as OK', 't-warn');
    }

    // ── 7. Email verification polling ─────────────────────────────────────────
    if (result.ok) {
      L('  📬 Polling for verification email (90s)…', 'tm');
      const verifyLink = await pollForVerifyLink(inbox.token, 90000);
      if (verifyLink) {
        result.verifyLink = verifyLink;
        L(`  → Verify link: ${verifyLink.slice(0, 80)}`, 't-info');
        try {
          await page.goto(verifyLink, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await page.waitForTimeout(2000);
          result.verifyStatus = 'verified';
          L('  ✔ Email verified!', 't-info');
        } catch (e) {
          result.verifyStatus = 'link_found_click_failed';
          L(`  ⚠ Click failed: ${e.message}`, 't-warn');
        }
      } else {
        result.verifyStatus = 'no_email_received';
        L('  ⚠ No verification email in 90s', 't-warn');
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
