// api/health.js — Health check / status endpoint
// GET /api/health → { ok, service, version, supabase_configured, captcha_configured, ts }

import { handleCors } from '../lib/auth.js';

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  const supabaseConfigured = !!(
    process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  );
  const captchaConfigured = !!(
    process.env.TWOCAPTCHA_KEY ||
    process.env.ANTICAPTCHA_KEY ||
    process.env.CAPMONSTER_KEY
  );

  return res.status(200).json({
    ok:                  true,
    service:             'SEO Parasite Pro Backend',
    version:             '2.0.0',
    environment:         process.env.VERCEL_ENV || 'development',
    supabase_configured: supabaseConfigured,
    captcha_configured:  captchaConfigured,
    endpoints: [
      '/api/health', '/api/proxy', '/api/headers', '/api/whois',
      '/api/ping',   '/api/supabase', '/api/captcha',
      '/api/register', '/api/universal-register', '/api/click-link',
    ],
    ts: new Date().toISOString(),
  });
}
