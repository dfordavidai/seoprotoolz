// api/health.js — Health check endpoint
// GET /api/health

import { handleCors } from '../lib/auth.js';

export const config = { maxDuration: 30, memory: 256 };

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  let playwrightOk = false;
  let playwrightVersion = null;

  try {
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    const pw = require('playwright-core');
    playwrightOk = typeof pw.chromium?.launch === 'function';
    playwrightVersion = require('playwright-core/package.json').version;
  } catch (_) {}

  return res.status(200).json({
    ok: true,
    version: '2.1.0',
    service: 'SEO Parasite Pro — Vercel Backend',
    playwright: playwrightOk,
    playwrightVersion,
    timestamp: new Date().toISOString(),
    region: process.env.VERCEL_REGION || process.env.AWS_REGION || 'unknown',
    env: {
      hasApiSecret:      !!process.env.API_SECRET,
      hasSupabaseUrl:    !!process.env.SUPABASE_URL,
      hasSupabaseAnon:   !!process.env.SUPABASE_ANON_KEY,
      hasSupabaseService:!!process.env.SUPABASE_SERVICE_KEY,
    },
  });
}
