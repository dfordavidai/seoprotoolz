// api/captcha.js — Captcha solving relay
// POST { type, site_key, site_url, image_base64, image_url, text_question, action, timeout, solver, api_key }
// Returns: { ok, solution, solver, taskId, error? }

import { handleCors, checkAuth } from '../lib/auth.js';
import { pickSolver, solveCaptcha } from '../lib/captcha-solver.js';

export const config = { maxDuration: 180 };

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!checkAuth(req, res)) return;

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const {
    type          = 'recaptcha_v2',
    site_key      = '',
    site_url      = '',
    image_base64  = null,
    image_url     = null,
    text_question = null,
    action        = 'verify',
    timeout       = 120,
    solver:       preferredSolver = null,
    api_key:      clientKey       = null,
  } = req.body || {};

  // ── Pick solver ─────────────────────────────────────────────────────────
  const { solver, apiKey } = pickSolver(preferredSolver, clientKey);

  if (!solver || !apiKey) {
    return res.status(503).json({
      ok:    false,
      error: 'No captcha solver configured. Set TWOCAPTCHA_KEY, ANTICAPTCHA_KEY, or CAPMONSTER_KEY in Vercel env vars, or pass api_key in the request.',
    });
  }

  // ── Handle image URL: fetch and convert to base64 ───────────────────────
  let resolvedImageBase64 = image_base64;
  if (!resolvedImageBase64 && image_url && type === 'image') {
    try {
      const imgRes = await fetch(image_url, { signal: AbortSignal.timeout(10000) });
      const buf    = await imgRes.arrayBuffer();
      resolvedImageBase64 = Buffer.from(buf).toString('base64');
    } catch (e) {
      return res.status(400).json({ ok: false, error: 'Failed to fetch image_url: ' + e.message });
    }
  }

  // ── Solve ────────────────────────────────────────────────────────────────
  const result = await solveCaptcha(solver, apiKey, {
    type,
    sitekey:      site_key,
    pageurl:      site_url,
    imageBase64:  resolvedImageBase64,
    textQuestion: text_question,
    action,
    maxWait:      timeout * 1000,
  });

  if (!result.ok) {
    return res.status(502).json(result);
  }

  return res.status(200).json(result);
}
