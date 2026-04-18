// lib/playwright-helpers.js — shared Playwright/Chromium helpers
// Used by register.js, universal-register.js, click-link.js

import { chromium } from 'playwright-core';
import * as chromiumExec from '@sparticuz/chromium';

/**
 * Launches a Chromium browser configured for Vercel's serverless environment.
 * @param {object} opts
 * @param {string} [opts.proxy]   - proxy server URL e.g. 'http://user:pass@host:port'
 * @returns {Promise<import('playwright-core').Browser>}
 */
export async function launchBrowser(opts = {}) {
  const launchOpts = {
    executablePath: await chromiumExec.executablePath(),
    args: [
      ...chromiumExec.args,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
    ],
    headless: chromiumExec.headless,
  };
  if (opts.proxy) launchOpts.proxy = { server: opts.proxy };
  return chromium.launch(launchOpts);
}

/**
 * Creates a browser context that looks like a real Chrome user.
 */
export async function createContext(browser) {
  return browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
}

/**
 * Injects a solved reCAPTCHA / hCaptcha token into the page.
 */
export async function injectCaptchaToken(page, token) {
  await page.evaluate((tok) => {
    // reCAPTCHA v2/v3 textarea
    try {
      const el = document.getElementById('g-recaptcha-response');
      if (el) { el.style.display = 'block'; el.value = tok; }
    } catch (e) {}
    // hCaptcha textarea
    try {
      const el = document.querySelector('[name="h-captcha-response"]');
      if (el) el.value = tok;
    } catch (e) {}
    // Fire grecaptcha callback if present
    try {
      const clients = window.___grecaptcha_cfg?.clients || {};
      const client  = Object.values(clients)[0];
      if (client?.callback && typeof client.callback === 'function') client.callback(tok);
    } catch (e) {}
    // Generic window callbacks
    ['captchaCallback', 'onCaptchaSuccess', 'recaptchaCallback'].forEach((fn) => {
      try { if (typeof window[fn] === 'function') window[fn](tok); } catch (e) {}
    });
  }, token);
}

/**
 * Tries to click the submit / sign-up button on the current page.
 * Returns true if a button was found and clicked.
 */
export async function clickSubmit(page) {
  const selectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:text-matches("sign up", "i")',
    'button:text-matches("create account", "i")',
    'button:text-matches("register", "i")',
    'button:text-matches("join", "i")',
    'button:text-matches("get started", "i")',
    'button:text-matches("continue", "i")',
    'button:text-matches("next", "i")',
    '[data-testid*="submit"]',
    '[data-testid*="signup"]',
    '#submit-btn', '#registerBtn', '#signupBtn', '.submit-btn',
    'form button:last-of-type',
  ];

  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        await btn.click();
        return true;
      }
    } catch (e) {}
  }

  // Last resort: form.submit()
  const submitted = await page.evaluate(() => {
    const form = document.querySelector('form');
    if (form) { form.submit(); return true; }
    return false;
  });
  return submitted;
}

/**
 * Generic form filler.
 * Iterates all visible inputs and fills them using the profile object.
 * Returns array of filled field names.
 */
export async function fillForm(page, profile) {
  const inputs = await page.$$(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]):not([type="reset"]):not([type="file"]), select, textarea'
  );

  const filled = [];

  for (const input of inputs) {
    try {
      if (!await input.isVisible()) continue;

      const tag      = await input.evaluate(el => el.tagName.toLowerCase());
      const type     = await input.evaluate(el => (el.getAttribute('type') || 'text').toLowerCase());
      const name     = await input.evaluate(el => el.getAttribute('name') || '');
      const id       = await input.evaluate(el => el.getAttribute('id') || '');
      const ph       = await input.evaluate(el => el.getAttribute('placeholder') || '');
      const combined = [name, id, ph].join(' ').toLowerCase();

      // Selects
      if (tag === 'select') {
        await input.evaluate(el => {
          if (el.options.length > 1) {
            const maleIdx = [...el.options].findIndex(o => ['male', 'm'].includes(o.value.toLowerCase()));
            el.selectedIndex = maleIdx > -1 ? maleIdx : 1;
          }
        });
        filled.push('select:' + (name || id));
        continue;
      }

      // Checkboxes (agree to terms, newsletter, etc.)
      if (type === 'checkbox') {
        if (!await input.isChecked()) await input.check().catch(() => {});
        filled.push('checkbox:' + (name || id));
        continue;
      }

      // Radio buttons
      if (type === 'radio') {
        await input.check().catch(() => {});
        filled.push('radio:' + (name || id));
        continue;
      }

      // Text/email/tel/url/password inputs
      let value = null;

      if (/confirm.?password|password.?confirm|password2|retype|repeat.*pass|verify.*pass/i.test(combined)) {
        value = profile.password;
      } else if (/password|passwd|pwd/i.test(combined) || type === 'password') {
        value = profile.password;
      } else if (/email|e-mail|mail/i.test(combined) || type === 'email') {
        value = profile.email;
      } else if (/user(?:name)?|login|handle|nick|screen/i.test(combined)) {
        value = profile.username;
      } else if (/first.?name|fname|given.?name|forename/i.test(combined)) {
        value = profile.firstName;
      } else if (/last.?name|lname|family.?name|surname/i.test(combined)) {
        value = profile.lastName;
      } else if (/\bname\b|full.?name|display.?name|real.?name/i.test(combined)) {
        value = profile.fullName;
      } else if (/phone|mobile|tel|cell/i.test(combined) || type === 'tel') {
        value = profile.phone;
      } else if (/website|\burl\b|blog|homepage/i.test(combined) || type === 'url') {
        value = profile.website;
      } else if (/bio|about|description|intro/i.test(combined)) {
        value = profile.bio;
      } else if (/city|town/i.test(combined)) {
        value = profile.city;
      } else if (/country/i.test(combined)) {
        value = profile.country;
      } else if (/zip|postal/i.test(combined)) {
        value = profile.zipcode;
      } else if (/birth.?year|year.?of.?birth/i.test(combined)) {
        value = String(profile.birthYear);
      } else if (/birth.?month/i.test(combined)) {
        value = profile.birthMonth;
      } else if (/birth.?day/i.test(combined)) {
        value = profile.birthDay;
      } else if (type === 'text' && /user|name/i.test(combined)) {
        value = profile.username;
      }

      if (value !== null) {
        await input.fill(String(value));
        filled.push(name || id || type);
        await page.waitForTimeout(100 + Math.random() * 80);
      }
    } catch (e) {
      // Field not accessible — skip silently
    }
  }

  return filled;
}

/**
 * Checks common success/error signals on a page after form submission.
 * Returns { success: boolean, error: boolean, note: string, finalUrl: string }
 */
export async function detectOutcome(page, originalUrl) {
  const finalUrl = page.url();
  const body     = (await page.evaluate(() =>
    document.body?.innerText?.toLowerCase().slice(0, 2000) || ''
  ));

  const successSigs = [
    'thank', 'success', 'verify', 'check your email',
    'welcome', 'confirm', 'account created', 'registered',
    'almost done', 'one more step', 'sent you', 'activation',
  ];
  const errorSigs = [
    'already taken', 'already exists', 'already registered',
    'username taken', 'email already', 'invalid email',
    'try again', 'error occurred', 'failed',
  ];

  const success = successSigs.some(s => body.includes(s)) || finalUrl !== originalUrl;
  const error   = !success && errorSigs.some(s => body.includes(s));

  return {
    success,
    error,
    note: success
      ? 'Registration accepted → ' + finalUrl.slice(0, 80)
      : error
      ? 'Error signals detected on page'
      : 'Ambiguous outcome',
    finalUrl,
  };
}
