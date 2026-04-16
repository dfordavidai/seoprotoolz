// api/supabase.js — Server-side Supabase relay
// Allows the frontend to use the Supabase SERVICE KEY (admin operations)
// without exposing it in the browser.
//
// POST { endpoint, method, body, use_service_key }
// endpoint: e.g. "/rest/v1/accounts?select=*" or "/auth/v1/admin/users"

import { handleCors, checkAuth } from '../lib/auth.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!checkAuth(req, res)) return;

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const {
    endpoint,
    method         = 'GET',
    body           = null,
    use_service_key = false,
    extra_headers  = {},
  } = req.body || {};

  if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });

  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const anonKey     = process.env.SUPABASE_ANON_KEY;
  const serviceKey  = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl) {
    return res.status(503).json({ error: 'SUPABASE_URL not configured on server' });
  }

  const apiKey = (use_service_key && serviceKey) ? serviceKey : anonKey;
  if (!apiKey) {
    return res.status(503).json({ error: 'Supabase API key not configured on server' });
  }

  const targetUrl = `${supabaseUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;

  try {
    const fetchOpts = {
      method: method.toUpperCase(),
      headers: {
        'apikey':        apiKey,
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=representation',
        ...extra_headers,
      },
      signal: AbortSignal.timeout(25000),
    };

    if (body && !['GET', 'HEAD'].includes(method.toUpperCase())) {
      fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const upstream = await fetch(targetUrl, fetchOpts);
    const text = await upstream.text();

    let data;
    try { data = JSON.parse(text); } catch { data = text; }

    return res.status(upstream.status).json({
      ok:     upstream.ok,
      status: upstream.status,
      data,
    });
  } catch (err) {
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    return res.status(502).json({
      ok:    false,
      error: isTimeout ? 'Supabase request timed out' : err.message,
    });
  }
}
