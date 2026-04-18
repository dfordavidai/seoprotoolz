/**
 * SEO PARASITE PRO — Playwright Backend Integration Patch
 * =========================================================
 * Paste this entire <script> block just before </body> in index.html.
 *
 * What this does:
 *  1. Monkey-patches blpSubmitSite to call /api/blp-post (server-side Playwright)
 *     for all sites where method === 'browser_form' AND a Vercel backend is configured.
 *  2. Adds blpPlaywrightPost() — direct Playwright post for any single BLP site.
 *  3. Adds gbPlaywrightBatch() — parallel Playwright batch call for Global Blast.
 *  4. Smart content-format routing: never sends HTML to markdown/text-only platforms.
 *  5. Full retry + fallback chain so every site gets a real URL or graceful failure.
 *
 * Requirements:
 *  - Vercel backend deployed with api/blp-post.js and api/gb-post.js
 *  - Settings → Vercel API URL filled in
 *  - Settings → Vercel Secret Key filled in (optional but recommended)
 */

(function() {
'use strict';

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function _vBase() {
  return (typeof vercelUrl === 'function' ? vercelUrl() : (typeof settingGet === 'function' ? settingGet('vercel_url') : ''))
    .replace(/\/+$/, '') || 'https://seoprotoolz.vercel.app';
}

function _vSecret() {
  return (typeof vercelSecret === 'function' ? vercelSecret() : (typeof settingGet === 'function' ? settingGet('vercel_secret') : '')) || '';
}

function _vHeaders() {
  const h = { 'Content-Type': 'application/json' };
  const s = _vSecret();
  if (s) h['X-API-Key'] = s;
  return h;
}

/** Map a BLP site object to the content format the platform expects */
function _detectFormat(site) {
  const u = (site.u || '').toLowerCase();
  const t = (site.t || '');
  const n = (site.n || '').toLowerCase();

  // Platform-specific overrides
  if (/github\.io|netlify\.app|vercel\.app|gitlab\.io|render\.com/.test(u)) return 'html';
  if (/blogger\.com|blogspot\.com|einpresswire|prlog/.test(u)) return 'html';
  if (/dev\.to|hashnode|rentry\.co|write\.as|hackmd\.io|telegra\.ph/.test(u)) return 'markdown';
  if (/medium\.com|substack\.com|ghost\.io|ghost\.org|beehiiv\.com/.test(u)) return 'markdown';
  if (t === 'paste' || /dpaste|hastebin|controlc|paste\.ee|0bin|pastebin/.test(u)) return 'text';
  if (t === 'document' || /scribd|issuu|slideshare|notion/.test(u)) return 'richtext';
  if (t === 'wiki') return 'text';
  if (t === 'press' || t === 'guest') return 'text';

  // Default safe: richtext (WYSIWYG strips markup safely)
  return 'richtext';
}

/** Build the content object sent to the Playwright endpoint */
function _buildContent(keyword, moneyUrl, format, generatedBody) {
  const title = keyword
    ? keyword.charAt(0).toUpperCase() + keyword.slice(1) + ' — Complete Guide ' + new Date().getFullYear()
    : 'Resource Guide';

  let body = generatedBody || '';
  // Inject money URL if not already present
  if (moneyUrl && !body.includes(moneyUrl)) {
    if (format === 'html') {
      body += `\n<p>For more information, visit <a href="${moneyUrl}" target="_blank" rel="noopener">${keyword || 'our guide'}</a>.</p>`;
    } else if (format === 'markdown') {
      body += `\n\n## Further Reading\n\nFor more, see the [${keyword || 'complete guide'}](${moneyUrl}).`;
    } else {
      body += `\n\nLearn more: ${moneyUrl}`;
    }
  }

  const links = moneyUrl ? [{ url: moneyUrl, label: keyword || 'Guide' }] : [];
  return { title, body, tags: keyword || '', links };
}

// ─── CORE: SINGLE-SITE PLAYWRIGHT POST ───────────────────────────────────────

/**
 * Posts to a single site using the Vercel Playwright backend.
 * Returns { ok, resultUrl, error, fallback }
 */
async function blpPlaywrightPost(site, keyword, moneyUrl, generatedContent) {
  const base = _vBase();
  const format = _detectFormat(site);
  const content = _buildContent(keyword, moneyUrl, format, generatedContent);
  const cred = (typeof blpGetCred === 'function') ? blpGetCred(site) : {};

  const payload = {
    url: 'https://' + site.u,
    credentials: {
      username: cred?.username || cred?.user || '',
      password: cred?.password || cred?.pass || '',
      token:    cred?.key || cred?.token || '',
      cookie:   cred?.cookie || '',
    },
    content,
    options: {
      timeout: 45000,
      screenshot: false,
    },
  };

  try {
    const resp = await fetch(base + '/api/blp-post', {
      method: 'POST',
      headers: _vHeaders(),
      body: JSON.stringify(payload),
    });

    const data = await resp.json().catch(() => ({}));

    if (data.ok && data.resultUrl) {
      return { ok: true, url: data.resultUrl, content: generatedContent, format, method: 'playwright_server' };
    }

    // Server returned error — fall through to client-side fallback
    return { ok: false, error: data.error || 'Playwright server error', format };

  } catch (err) {
    return { ok: false, error: 'Network error calling /api/blp-post: ' + err.message, format };
  }
}

// ─── CORE: BATCH GLOBAL BLAST VIA gb-post ────────────────────────────────────

/**
 * Sends a batch of sites to /api/gb-post for parallel Playwright posting.
 * Returns array of { url, ok, resultUrl, error }
 */
async function gbPlaywrightBatch(sites, keyword, moneyUrl, generatedContent) {
  const base = _vBase();

  const sitePayloads = sites.map(site => {
    const cred = (typeof blpGetCred === 'function') ? blpGetCred(site) : {};
    const format = _detectFormat(site);
    return {
      url: 'https://' + site.u,
      method: site.method || (site.auth === 'user_pass' ? 'browser_form' : 'auto'),
      credentials: {
        username: cred?.username || cred?.user || '',
        password: cred?.password || cred?.pass || '',
        token:    cred?.key || cred?.token || '',
        cookie:   cred?.cookie || '',
      },
      _format: format,
    };
  });

  // Build unified content (format = richtext for batch, each site handles its own strip)
  const content = _buildContent(keyword, moneyUrl, 'richtext', generatedContent);

  const payload = {
    sites: sitePayloads,
    content,
    options: {
      concurrency: 5,
      timeout: 45000,
    },
  };

  try {
    const resp = await fetch(base + '/api/gb-post', {
      method: 'POST',
      headers: _vHeaders(),
      body: JSON.stringify(payload),
    });

    const data = await resp.json().catch(() => ({ results: [] }));
    return data.results || [];

  } catch (err) {
    console.warn('[gb-post] Batch call failed:', err.message);
    return sites.map(s => ({ url: 'https://' + s.u, ok: false, error: err.message }));
  }
}

// ─── PATCH: blpSubmitSite ────────────────────────────────────────────────────

/**
 * Wrap the original blpSubmitSite to add Playwright backend support.
 * Sites with method==='browser_form' that previously threw or returned manual:true
 * will now go through the Vercel Playwright backend for real posting.
 */
const _originalBlpSubmitSite = typeof blpSubmitSite === 'function' ? blpSubmitSite : null;

window.blpSubmitSiteWithPlaywright = async function(site, keyword, moneyUrl) {
  // Always try original first (handles API-based sites perfectly)
  if (_originalBlpSubmitSite) {
    try {
      const result = await _originalBlpSubmitSite(site, keyword, moneyUrl);

      // If original returned a real URL, we're done
      if (result && result.url && result.url.startsWith('http') && !result.manual) {
        return result;
      }

      // Original returned manual:true or null URL — escalate to Playwright
      if ((result && result.manual) || !result?.url) {
        console.log('[BLP-PW] Escalating to Playwright backend for:', site.u);
        const pwResult = await blpPlaywrightPost(site, keyword, moneyUrl, result?.content);
        if (pwResult.ok) return { ...result, ...pwResult, fallback: false, playwright: true };
        // Playwright also failed — return original (with fallback URL if any)
        return result;
      }

      return result;

    } catch (err) {
      // Original threw — this site likely needs Playwright
      const needsPlaywright = (
        site.method === 'browser_form' ||
        site.auth === 'user_pass' ||
        site.auth === 'cookie' ||
        err.message.includes('browser') ||
        err.message.includes('manual') ||
        err.message.includes('login')
      );

      if (needsPlaywright && _vBase()) {
        console.log('[BLP-PW] Original threw, trying Playwright for:', site.u, '—', err.message);
        const pwResult = await blpPlaywrightPost(site, keyword, moneyUrl, '');
        if (pwResult.ok) {
          return { url: pwResult.url, content: pwResult.content, manual: false, playwright: true, format: pwResult.format };
        }
      }

      // Re-throw if Playwright also unavailable or failed
      throw err;
    }
  }

  // Fallback: no original function, go straight to Playwright
  const pwResult = await blpPlaywrightPost(site, keyword, moneyUrl, '');
  if (pwResult.ok) return { url: pwResult.url, content: '', manual: false, playwright: true };
  throw new Error(pwResult.error || 'Playwright post failed for ' + site.u);
};

// ─── AUTO-PATCH: Replace blpSubmitSite globally ──────────────────────────────

/**
 * Override the global blpSubmitSite so all callers (BLP blast, Global Blast,
 * Campaign runner) automatically get Playwright fallback without any other changes.
 */
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'blpSubmitSite', {
    get() { return window.blpSubmitSiteWithPlaywright; },
    set(fn) { /* ignore reassignment to keep our patch */ },
    configurable: true,
  });
}

// ─── GLOBAL BLAST ENHANCEMENT ─────────────────────────────────────────────────

/**
 * Called by the Global Blast UI to batch-submit BLP sites via Playwright.
 * Replaces the existing BLP section of runGlobalBlast with a smarter version
 * that sends all browser_form sites to /api/gb-post in one batched call.
 */
window.runBlpPlaywrightBatch = async function(blpSites, keyword, moneyUrl, termAdd) {
  if (!blpSites || !blpSites.length) return [];

  // Split: API-capable sites go to original blpSubmitSite; browser_form go to gb-post
  const apiSites  = blpSites.filter(s => s.method === 'rest_api' || s.auth === 'api_key' || s.auth === 'token' || s.auth === 'none' || s.auth === 'api_or_none');
  const formSites = blpSites.filter(s => s.method === 'browser_form' || s.auth === 'user_pass' || s.auth === 'cookie' || s.auth === 'app_pass');

  const results = [];

  // Process API sites via original path (fast, no browser overhead)
  for (const site of apiSites) {
    try {
      if (termAdd) termAdd('  → [API] ' + site.u + '...', 'info');
      const r = await window.blpSubmitSiteWithPlaywright(site, keyword, moneyUrl);
      results.push({ site, ...r, ok: true });
      if (termAdd) termAdd('  ✓ ' + site.u + ': ' + (r.url || 'content generated'), 'info');
    } catch (e) {
      results.push({ site, ok: false, error: e.message });
      if (termAdd) termAdd('  ✗ ' + site.u + ': ' + e.message, 'error');
    }
  }

  // Process browser_form sites via batch Playwright call
  if (formSites.length) {
    if (termAdd) termAdd('  → [Playwright batch] ' + formSites.length + ' browser-form sites...', 'info');
    const batchResults = await gbPlaywrightBatch(formSites, keyword, moneyUrl, '');

    for (const r of batchResults) {
      const site = formSites.find(s => 'https://' + s.u === r.url || r.url?.includes(s.u));
      results.push({ site: site || { u: r.url }, ...r });
      if (termAdd) {
        if (r.ok) termAdd('  ✓ ' + r.url + ': ' + (r.resultUrl || 'posted'), 'info');
        else termAdd('  ✗ ' + r.url + ': ' + (r.error || 'failed'), 'error');
      }
    }
  }

  return results;
};

// ─── UI: PLAYWRIGHT STATUS BADGE ──────────────────────────────────────────────

/**
 * Adds a small "Playwright ✓" or "Playwright ✗" badge in the BLP/GB UI
 * showing whether the Vercel Playwright backend is reachable.
 */
window.checkPlaywrightBackend = async function() {
  const base = _vBase();
  if (!base) return { ok: false, reason: 'No Vercel URL configured' };
  try {
    const r = await fetch(base + '/api/health', { method: 'GET', headers: _vHeaders(), signal: AbortSignal.timeout(5000) });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok, version: d.version, playwright: d.playwright };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
};

// Run a silent health check on load and update status bar
(async function() {
  try {
    const status = await window.checkPlaywrightBackend();
    const sbEl = document.querySelector('#sb-playwright-status');
    if (sbEl) {
      sbEl.textContent = status.ok ? '🎭 Playwright ✓' : '🎭 Playwright ✗';
      sbEl.style.color = status.ok ? 'var(--win-green)' : 'var(--win-red)';
    }
    if (status.ok) {
      console.info('[BLP-PW] Playwright backend connected ✓ —', status.version || 'v1');
    } else {
      console.warn('[BLP-PW] Playwright backend not reachable:', status.reason || 'check Vercel URL in Settings');
    }
  } catch (_) {}
})();

// ─── FORMAT SAFETY: blpFormatForSite ─────────────────────────────────────────

/**
 * Exported helper for content studio and campaign runner.
 * Ensures generated content is in the right format before submission.
 * Prevents pushing HTML to markdown-only or text-only sites.
 */
window.blpFormatForSite = function(site, rawContent) {
  const format = _detectFormat(site);

  if (format === 'text') {
    // Strip all markup
    return rawContent
      .replace(/<[^>]+>/g, ' ')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  if (format === 'markdown') {
    // Strip only HTML tags, keep markdown syntax
    if (/<\/?[a-z][\s\S]*>/i.test(rawContent)) {
      return rawContent.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    }
    return rawContent;
  }

  if (format === 'html') {
    // If content is plain text or markdown, wrap in minimal HTML
    if (!/<\/?[a-z][\s\S]*>/i.test(rawContent)) {
      const lines = rawContent.split('\n').filter(Boolean);
      const htmlLines = lines.map(l => {
        if (/^#{1,6}\s/.test(l)) {
          const level = l.match(/^(#{1,6})/)[1].length;
          return `<h${level}>${l.replace(/^#{1,6}\s+/, '')}</h${level}>`;
        }
        return `<p>${l}</p>`;
      });
      return htmlLines.join('\n');
    }
    return rawContent;
  }

  // richtext / auto: return as-is (WYSIWYG handles it)
  return rawContent;
};

// ─── EXPOSE PUBLIC API ────────────────────────────────────────────────────────

window.BLP_PLAYWRIGHT = {
  post:        blpPlaywrightPost,
  batch:       gbPlaywrightBatch,
  detectFormat: _detectFormat,
  formatForSite: window.blpFormatForSite,
  checkBackend: window.checkPlaywrightBackend,
};

console.info('[SEO PRO] Playwright integration patch loaded. blpSubmitSite now has Playwright fallback for 850+ sites.');

})();
