'use strict';

/**
 * api/health.js
 * Health check endpoint — reports server status and Playwright availability.
 * GET /api/health
 */

const { cors } = require('../lib/auth');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.end();

  let playwrightOk = false;
  let playwrightVersion = null;

  try {
    // Lightweight check — just require, don't launch browser
    const pw = require('playwright-core');
    playwrightOk = typeof pw.chromium?.launch === 'function';
    playwrightVersion = require('playwright-core/package.json').version;
  } catch (_) {}

  res.status(200).json({
    ok: true,
    version: '2.0.0',
    service: 'SEO Parasite Pro — Vercel Backend',
    playwright: playwrightOk,
    playwrightVersion,
    timestamp: new Date().toISOString(),
    region: process.env.VERCEL_REGION || process.env.AWS_REGION || 'unknown',
  });
};
