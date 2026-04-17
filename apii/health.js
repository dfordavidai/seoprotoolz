// api/health.js — Health check / status endpoint
// Called by frontend Settings panel "Test Connection" button
//
// GET  /api/health → full status JSON
// POST /api/health → same (frontend may POST with secret header)

import { handleCors } from '../lib/auth.js';

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  // Allow both GET and POST (frontend tests with POST + X-API-Key)
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'GET or POST required' });
  }

  const supabaseConfigured = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
  const captchaConfigured  = !!(
    process.env.TWOCAPTCHA_KEY  ||
    process.env.ANTICAPTCHA_KEY ||
    process.env.CAPMONSTER_KEY
  );
  const googleIndexConfigured = !!process.env.GOOGLE_SA_JSON;
  const bingConfigured        = !!process.env.BING_WEBMASTER_KEY;
  const indexNowConfigured    = !!process.env.INDEXNOW_KEY;
  const mozConfigured         = !!(process.env.MOZ_ACCESS_ID && process.env.MOZ_SECRET_KEY);
  const hasSecret             = !!process.env.API_SECRET_KEY;

  return res.status(200).json({
    ok:                   true,
    service:              'SEO Parasite Pro Backend',
    version:              '2.1.0',
    environment:          process.env.VERCEL_ENV || 'development',

    // Feature flags — frontend reads these to know what's available
    features: {
      proxy:              true,
      ping:               true,
      indexing:           googleIndexConfigured || bingConfigured || indexNowConfigured,
      captcha:            captchaConfigured,
      register:           true,
      universalRegister:  true,
      clickLink:          true,
      whois:              true,
      headers:            true,
      supabase:           supabaseConfigured,
      proxyTest:          true,
    },

    // Per-service config status (no secrets exposed)
    config: {
      hasSecret,
      supabase:         supabaseConfigured,
      captcha:          captchaConfigured,
      captchaProvider:  process.env.CAPMONSTER_KEY  ? 'capmonster'  :
                        process.env.ANTICAPTCHA_KEY ? 'anticaptcha' :
                        process.env.TWOCAPTCHA_KEY  ? 'twocaptcha'  : null,
      googleIndex:      googleIndexConfigured,
      bingWebmaster:    bingConfigured,
      indexNow:         indexNowConfigured,
      moz:              mozConfigured,
    },

    endpoints: [
      'GET  /api/health',
      'POST /api/proxy',
      'GET  /api/proxy?url=<encoded>',
      'POST /api/proxy-test',
      'POST /api/ping',
      'POST /api/index',
      'POST /api/captcha',
      'POST /api/whois',
      'GET  /api/whois?domain=<domain>',
      'POST /api/headers',
      'GET  /api/headers?url=<encoded>',
      'POST /api/supabase',
      'POST /api/register',
      'POST /api/universal-register',
      'POST /api/click-link',
    ],

    ts: new Date().toISOString(),
  });
}
