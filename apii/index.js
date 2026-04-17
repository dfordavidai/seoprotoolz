// api/index.js — Root API info page
// GET /api → service info JSON
// Also re-exports the indexing logic used by /api/ping for Google/Bing API submission

import { handleCors } from '../lib/auth.js';

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  return res.status(200).json({
    service:     'SEO Parasite Pro Backend',
    version:     '2.1.0',
    description: 'Serverless Vercel backend for SEO Parasite Pro.',
    endpoints: {
      'GET  /api':                         'This info page',
      'GET  /api/health':                  'Health check + feature flags',
      'POST /api/proxy':                   'CORS-safe HTTP proxy — { url, method, headers, body, timeout }',
      'GET  /api/proxy?url=<encoded>':     'Proxy GET shorthand',
      'POST /api/proxy-test':              'Test proxy liveness — { proxy, url }',
      'POST /api/headers':                 'Fetch response headers — { url }',
      'GET  /api/headers?url=<encoded>':   'Headers GET shorthand',
      'POST /api/whois':                   'WHOIS + DNS + DA lookup — { domain }',
      'GET  /api/whois?domain=<domain>':   'WHOIS GET shorthand',
      'POST /api/ping':                    'Ping Google/Bing/IndexNow — { urls[], pingGoogle, pingBing, pingIndexNow, indexNowKey }',
      'POST /api/supabase':                'Supabase relay (server-side service key) — { endpoint, method, body }',
      'POST /api/captcha':                 'Solve captcha — { type, site_key, site_url, solver, api_key }',
      'POST /api/register':                'Platform account creation via Playwright — { platform, username, password, captchaKey, useMailTm, autoVerify }',
      'POST /api/universal-register':      'Universal account creator — { url, proxy?, captchaKey? }',
      'POST /api/click-link':              'Headless link visitor / CTR sim — { url, dwellMs?, scrollDepth?, clickLinks? }',
    },
    env_vars: {
      optional: [
        'API_SECRET_KEY       — Lock all endpoints with a secret key',
        'SUPABASE_URL         — Supabase project URL',
        'SUPABASE_ANON_KEY    — Supabase anon key',
        'SUPABASE_SERVICE_KEY — Supabase service-role key (admin)',
        'TWOCAPTCHA_KEY       — 2captcha API key',
        'ANTICAPTCHA_KEY      — Anti-Captcha API key',
        'CAPMONSTER_KEY       — CapMonster API key',
        'BING_WEBMASTER_KEY   — Bing Webmaster Tools key',
        'INDEXNOW_KEY         — IndexNow submission key',
        'GOOGLE_SA_JSON       — Google Service Account JSON (for Indexing API)',
        'MOZ_ACCESS_ID        — Moz API access ID (DA lookups)',
        'MOZ_SECRET_KEY       — Moz API secret key (DA lookups)',
      ],
    },
    docs: 'https://github.com/dfordavidai/seoprotoolz',
    ts:   new Date().toISOString(),
  });
}
