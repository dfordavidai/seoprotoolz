// api/supabase.js — Server-side Supabase relay
//
// Hides the SERVICE_KEY from the browser. Frontend calls this via:
//   vercelFetchSupabase(endpoint, method, body)
//
// Accepts two call shapes:
//
//   Shape A (new / preferred):
//     POST { endpoint, method, body, use_service_key, extra_headers }
//
//   Shape B (legacy action-based):
//     POST { action: 'upsert'|'insert'|'select'|'update'|'delete'|'rpc',
//            table, data, filter, rpcFn, rpcArgs }
//
// Returns: { ok, status, data }

import { handleCors, checkAuth } from '../lib/auth.js';

export const config = { maxDuration: 30 };

// Convert legacy action-based shape → { endpoint, method, body }
function resolveShapeB(body) {
  const { action, table, data, filter, rpcFn, rpcArgs } = body;
  const tableSlug = encodeURIComponent(table || '');
  const prefix    = '/rest/v1/';

  switch (action) {
    case 'select': {
      let ep = `${prefix}${tableSlug}?select=*`;
      if (filter) {
        for (const [col, val] of Object.entries(filter)) {
          ep += `&${col}=${val}`;
        }
      }
      return { endpoint: ep, method: 'GET', reqBody: null, useServiceKey: true };
    }
    case 'insert':
      return { endpoint: `${prefix}${tableSlug}`, method: 'POST', reqBody: data, useServiceKey: true };

    case 'upsert':
      return {
        endpoint: `${prefix}${tableSlug}`,
        method:   'POST',
        reqBody:  data,
        useServiceKey: true,
        extraHeaders: { Prefer: 'resolution=merge-duplicates,return=representation' },
      };

    case 'update': {
      let ep = `${prefix}${tableSlug}?`;
      if (filter) {
        ep += Object.entries(filter).map(([k, v]) => `${k}=${v}`).join('&');
      }
      return { endpoint: ep, method: 'PATCH', reqBody: data, useServiceKey: true };
    }

    case 'delete': {
      let ep = `${prefix}${tableSlug}?`;
      if (filter) {
        ep += Object.entries(filter).map(([k, v]) => `${k}=${v}`).join('&');
      }
      return { endpoint: ep, method: 'DELETE', reqBody: null, useServiceKey: true };
    }

    case 'rpc':
      return {
        endpoint:      `/rest/v1/rpc/${encodeURIComponent(rpcFn || '')}`,
        method:        'POST',
        reqBody:       rpcArgs || {},
        useServiceKey: true,
      };

    default:
      return null;
  }
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!checkAuth(req, res))  return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const body = req.body || {};

  // ── Resolve the call shape ────────────────────────────────────────────────
  let endpoint, method, reqBody, useServiceKey, extraHeaders;

  if (body.action) {
    // Shape B (legacy)
    const resolved = resolveShapeB(body);
    if (!resolved) return res.status(400).json({ error: `Unknown action: ${body.action}` });
    ({ endpoint, method, reqBody, useServiceKey, extraHeaders } = resolved);
    extraHeaders = extraHeaders || {};
  } else {
    // Shape A (preferred)
    endpoint       = body.endpoint;
    method         = body.method         || 'GET';
    reqBody        = body.body           || null;
    useServiceKey  = body.use_service_key !== false; // default true
    extraHeaders   = body.extra_headers  || {};
  }

  if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });

  // ── Resolve Supabase credentials ──────────────────────────────────────────
  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const anonKey     = process.env.SUPABASE_ANON_KEY;
  const serviceKey  = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl) {
    return res.status(503).json({ ok: false, error: 'SUPABASE_URL not configured on server' });
  }

  const apiKey = (useServiceKey && serviceKey) ? serviceKey : anonKey;
  if (!apiKey) {
    return res.status(503).json({ ok: false, error: 'No Supabase API key configured on server' });
  }

  const targetUrl = supabaseUrl + (endpoint.startsWith('/') ? '' : '/') + endpoint;

  // ── Proxy to Supabase ─────────────────────────────────────────────────────
  try {
    const fetchOpts = {
      method: method.toUpperCase(),
      headers: {
        'apikey':        apiKey,
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=representation',
        ...extraHeaders,
      },
      signal: AbortSignal.timeout(25000),
    };

    if (reqBody && !['GET', 'HEAD'].includes(method.toUpperCase())) {
      fetchOpts.body = typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody);
    }

    const upstream = await fetch(targetUrl, fetchOpts);
    const text     = await upstream.text();

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
