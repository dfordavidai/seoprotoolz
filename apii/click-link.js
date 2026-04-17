// api/click-link.js — Headless browser link visitor / CTR simulator
// POST {
//   url:           string   (URL to visit)
//   proxy?:        string   (http://user:pass@host:port)
//   dwellMs?:      number   (ms to stay on page, default 8000)
//   scrollDepth?:  number   (0.0–1.0, how far to scroll, default 0.6)
//   clickLinks?:   bool     (click internal links to simulate navigation, default false)
//   screenshotB64?:bool     (return base64 screenshot on success, default false)
// }
// Returns: { ok, finalUrl, title, status, dwellMs, scrolled, linksClicked, screenshotB64?, error? }

import { handleCors, checkAuth } from '../lib/auth.js';
import { launchBrowser, createContext } from '../lib/playwright-helpers.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!checkAuth(req, res)) return;

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const {
    url,
    proxy          = null,
    dwellMs        = 8000,
    scrollDepth    = 0.6,
    clickLinks     = false,
    screenshotB64  = false,
  } = req.body || {};

  if (!url) return res.status(400).json({ error: 'url is required' });

  try { new URL(url); } catch (e) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const result = {
    ok: false, finalUrl: url, title: '', status: 0,
    dwellMs: 0, scrolled: false, linksClicked: 0, screenshotB64: null,
  };

  let browser, context, page;

  try {
    browser = await launchBrowser({ proxy });
    context = await createContext(browser);
    page    = await context.newPage();

    // Intercept and block heavy resources to speed up load
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

    // ── Simulate human scroll ───────────────────────────────────────────────
    const scrollSteps = 8;
    for (let i = 1; i <= scrollSteps; i++) {
      const fraction = (i / scrollSteps) * scrollDepth;
      await page.evaluate(f => window.scrollTo(0, document.body.scrollHeight * f), fraction);
      await page.waitForTimeout(200 + Math.random() * 300);
    }
    result.scrolled = true;

    // ── Dwell time ──────────────────────────────────────────────────────────
    const clampedDwell = Math.min(Math.max(Number(dwellMs) || 8000, 2000), 55000);
    await page.waitForTimeout(clampedDwell);
    result.dwellMs = clampedDwell;

    // ── Optional: click internal links ─────────────────────────────────────
    if (clickLinks) {
      const origin = new URL(url).origin;
      const links  = await page.$$eval(
        'a[href]',
        (els, o) => els
          .filter(el => {
            try { return new URL(el.href).origin === o && el.offsetParent !== null; }
            catch { return false; }
          })
          .slice(0, 3)
          .map(el => el.href),
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

    // ── Optional: screenshot ────────────────────────────────────────────────
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
