// api/index.js — API root info page
// GET /api → returns service info JSON

import { handleCors } from '../lib/auth.js';

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  return res.status(200).json({
    service:     'SEO Parasite Pro Backend',
    version:     '2.0.0',
    description: 'Serverless Vercel backend for SEO Parasite Pro frontend.',
    endpoints: {
      'GET  /api/health':               'Health check + config status',
      'GET  /api':                       'This info page',
      'POST /api/proxy':                 'CORS-safe HTTP proxy — { url, method, headers, body, timeout }',
      'GET  /api/proxy?url=<encoded>':   'Proxy GET shorthand',
      'POST /api/headers':               'Fetch response headers — { url }',
      'GET  /api/headers?url=<encoded>': 'Headers GET shorthand',
      'POST /api/whois':                 'WHOIS + DNS + DA lookup — { domain }',
      'POST /api/ping':                  'Ping URLs to Google/Bing/IndexNow — { urls[], pingGoogle, pingBing, pingIndexNow }',
      'POST /api/supabase':              'Supabase relay (uses server-side service key) — { endpoint, method, body }',
      'POST /api/captcha':               'Solve captcha — { type, site_key, site_url, solver, api_key }',
      'POST /api/register':             'Browser-based registration — { url, email, password, proxy? }',
      'POST /api/universal-register':   'Full auto-register with disposable email — { url, proxy?, captchaKey? }',
      'POST /api/click-link':           'Headless link visitor / CTR simulator — { url, dwellMs?, proxy? }',
    },
    env_vars_required: {
      optional: [
        'API_SECRET_KEY     — Lock API with a secret key',
        'SUPABASE_URL       — Supabase project URL',
        'SUPABASE_ANON_KEY  — Supabase public anon key',
        'SUPABASE_SERVICE_KEY — Supabase service role key (admin)',
        'TWOCAPTCHA_KEY     — 2captcha API key',
        'ANTICAPTCHA_KEY    — Anti-Captcha API key',
        'CAPMONSTER_KEY     — CapMonster API key',
        'BING_WEBMASTER_KEY — Bing Webmaster Tools key (for ping)',
        'INDEXNOW_KEY       — IndexNow submission key (for ping)',
        'MOZ_ACCESS_ID      — Moz API access ID (for DA lookups)',
        'MOZ_SECRET_KEY     — Moz API secret key (for DA lookups)',
      ],
    },
    docs: 'https://github.com/dfordavidai/seoprotoolz',
    ts:   new Date().toISOString(),
  });
}
