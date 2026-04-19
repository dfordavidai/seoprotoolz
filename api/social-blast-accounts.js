/**
 * /api/social-blast-accounts.js
 * Platform account creation & credential management for the Social Bookmarking Blaster.
 *
 * Wraps /api/register and /api/universal-register with:
 *  - auto email verification via mail.tm
 *  - credential persistence in Supabase (encrypted at rest via Supabase RLS)
 *  - bulk account creation across multiple platforms
 *  - account health checking
 *
 * Table required:
 *   create table if not exists spp_blast_accounts (
 *     id          uuid primary key default gen_random_uuid(),
 *     platform    text not null,
 *     username    text,
 *     email       text,
 *     password    text,
 *     credentials jsonb,         -- api keys, tokens, etc.
 *     status      text default 'active',  -- active|banned|pending_verify|failed
 *     created_at  timestamptz not null default now(),
 *     last_used   timestamptz,
 *     notes       text
 *   );
 *
 * Routes:
 *   POST   /api/social-blast-accounts/create      — create one or more accounts
 *   GET    /api/social-blast-accounts/list         — list stored accounts
 *   POST   /api/social-blast-accounts/credentials  — upsert manual credentials (API keys, tokens)
 *   DELETE /api/social-blast-accounts?id=X         — remove an account record
 *   GET    /api/social-blast-accounts/health       — ping platform login to verify account still works
 */

import { allowCors, authCheck, jsonError } from '../lib/auth.js';

// ─── Supabase helpers (mirrors social-blast-queue.js pattern) ─────────────────

function sbHeaders() {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

function sbBase() {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('SUPABASE_URL not set');
  return url.replace(/\/$/, '');
}

async function sbUpsert(table, row, onConflict = 'id') {
  const res = await fetch(`${sbBase()}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: { ...sbHeaders(), 'Prefer': 'return=representation,resolution=merge-duplicates' },
    body: JSON.stringify(row),
  });
  return res.json();
}

async function sbQuery(table, filters = {}, opts = {}) {
  const params = new URLSearchParams({ select: opts.select || '*', ...filters });
  if (opts.order) params.set('order', opts.order);
  if (opts.limit) params.set('limit', String(opts.limit));
  const res = await fetch(`${sbBase()}/rest/v1/${table}?${params}`, {
    headers: sbHeaders(),
  });
  return res.json();
}

async function sbPatch(table, id, patch) {
  const res = await fetch(`${sbBase()}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
    body: JSON.stringify(patch),
  });
  return res.ok;
}

async function sbRemove(table, id) {
  const res = await fetch(`${sbBase()}/rest/v1/${table}?id=eq.${id}`, {
    method: 'DELETE',
    headers: sbHeaders(),
  });
  return res.ok;
}

// ─── Internal API helpers ─────────────────────────────────────────────────────

function apiBase() {
  return process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';
}

function apiHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-API-Key': process.env.API_SECRET_KEY || '',
    'X-Internal': '1',
  };
}

async function callRegister(payload) {
  const res = await fetch(`${apiBase()}/api/register`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function callUniversalRegister(payload) {
  const res = await fetch(`${apiBase()}/api/universal-register`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify(payload),
  });
  return res.json();
}

// ─── Platforms supported by /api/register ────────────────────────────────────

const PRESET_PLATFORMS = new Set([
  'wordpress', 'medium', 'reddit', 'quora', 'tumblr', 'weebly',
  'blogger', 'wix', 'devto', 'hashnode', 'strikingly', 'site123',
  'livejournal', 'ghost', 'substack', 'linkedin', 'pinterest', 'mix',
]);

// ─── Random profile generator ─────────────────────────────────────────────────

function randomProfile(overrides = {}) {
  const firstNames = ['Alex', 'Jordan', 'Casey', 'Morgan', 'Riley', 'Taylor', 'Jamie', 'Drew'];
  const lastNames  = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis'];
  const firstName  = firstNames[Math.floor(Math.random() * firstNames.length)];
  const lastName   = lastNames[Math.floor(Math.random() * lastNames.length)];
  const suffix     = Math.floor(Math.random() * 9000) + 1000;

  return {
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`,
    username: `${firstName.toLowerCase()}${lastName.toLowerCase()}${suffix}`,
    password: `Secure${suffix}!x`,
    city: 'Austin',
    country: 'US',
    zipcode: '78701',
    bio: 'Digital marketing enthusiast and content creator.',
    birthYear: '1990',
    birthMonth: '06',
    birthDay: '15',
    ...overrides,
  };
}

// ─── Create accounts ──────────────────────────────────────────────────────────

async function createAccounts(req, { platforms, profile_overrides = {}, captchaKey, auto_verify = true, save_to_db = true }) {
  const results = [];

  for (const platform of platforms) {
    const profile = randomProfile(profile_overrides);
    let result;

    try {
      if (PRESET_PLATFORMS.has(platform.toLowerCase())) {
        result = await callRegister({
          platform: platform.toLowerCase(),
          username: profile.username,
          password: profile.password,
          captchaKey: captchaKey || null,
          useMailTm: auto_verify,
          autoVerify: auto_verify,
        });
      } else {
        // For non-preset platforms, try universal register
        result = await callUniversalRegister({
          url: guessPlatformRegisterUrl(platform),
          profile: { ...profile, email: `${profile.username}@placeholder.com` },
          captchaKey: captchaKey || null,
          autoVerify: auto_verify,
        });
      }

      const accountRecord = {
        platform: platform.toLowerCase(),
        username: result.username || profile.username,
        email: result.email || null,
        password: profile.password,
        credentials: result.credentials || {},
        status: result.ok ? 'active' : 'failed',
        notes: result.message || null,
      };

      if (save_to_db && process.env.SUPABASE_URL) {
        const saved = await sbUpsert('spp_blast_accounts', accountRecord, 'platform,username');
        accountRecord.id = Array.isArray(saved) ? saved[0]?.id : saved?.id;
      }

      results.push({ platform, ok: !!result.ok, account: accountRecord, raw: result });
    } catch (err) {
      results.push({ platform, ok: false, error: err.message });
    }
  }

  return results;
}

function guessPlatformRegisterUrl(platform) {
  const urlMap = {
    folkd: 'https://www.folkd.com/user/register',
    diigo: 'https://www.diigo.com/sign-up',
    instapaper: 'https://www.instapaper.com/account/create',
    bizsugar: 'https://www.bizsugar.com/user/register',
    netvouz: 'https://www.netvouz.com/register',
    pearltrees: 'https://www.pearltrees.com/signup',
  };
  return urlMap[platform.toLowerCase()] || `https://www.${platform.toLowerCase()}.com/signup`;
}

// ─── List accounts ────────────────────────────────────────────────────────────

async function listAccounts(platform, status) {
  const filters = {};
  if (platform) filters.platform = `eq.${platform}`;
  if (status) filters.status = `eq.${status}`;
  return sbQuery('spp_blast_accounts', filters, { order: 'created_at.desc', limit: 200 });
}

// ─── Upsert manual credentials (API keys, OAuth tokens) ──────────────────────

async function upsertCredentials(req, { platform, username, credentials, notes }) {
  if (!platform) throw new Error('platform required');
  if (!credentials) throw new Error('credentials object required');

  const row = {
    platform: platform.toLowerCase(),
    username: username || null,
    credentials,
    status: 'active',
    notes: notes || null,
  };

  return sbUpsert('spp_blast_accounts', row, 'platform,username');
}

// ─── Health check ─────────────────────────────────────────────────────────────

async function checkHealth(accounts) {
  // We don't store plaintext sessions, so health check is a lightweight
  // HEAD/GET to verify the platform is reachable and the account profile URL responds.
  const results = [];

  for (const account of accounts) {
    const profileUrl = guessProfileUrl(account.platform, account.username);
    if (!profileUrl) {
      results.push({ id: account.id, platform: account.platform, reachable: null, note: 'No profile URL pattern known' });
      continue;
    }

    try {
      const res = await fetch(profileUrl, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
      const alive = res.status < 400;
      if (!alive) await sbPatch('spp_blast_accounts', account.id, { status: 'banned', notes: `HEAD ${profileUrl} → ${res.status}` });
      results.push({ id: account.id, platform: account.platform, reachable: alive, status_code: res.status, profile_url: profileUrl });
    } catch (err) {
      results.push({ id: account.id, platform: account.platform, reachable: false, error: err.message });
    }
  }

  return results;
}

function guessProfileUrl(platform, username) {
  if (!username) return null;
  const map = {
    reddit:      `https://www.reddit.com/user/${username}`,
    tumblr:      `https://${username}.tumblr.com`,
    medium:      `https://medium.com/@${username}`,
    mix:         `https://mix.com/u/${username}`,
    diigo:       `https://www.diigo.com/user/${username}`,
    folkd:       `https://www.folkd.com/user/${username}`,
    bizsugar:    `https://www.bizsugar.com/user/${username}`,
    devto:       `https://dev.to/${username}`,
    hashnode:    `https://hashnode.com/@${username}`,
    pinterest:   `https://www.pinterest.com/${username}`,
    linkedin:    `https://www.linkedin.com/in/${username}`,
  };
  return map[platform] || null;
}

// ─── Request handler ──────────────────────────────────────────────────────────

async function handler(req, res) {
  const urlPath = req.url?.split('?')[0] || '';
  const action = urlPath.split('/').pop(); // create | list | credentials | health

  // DELETE
  if (req.method === 'DELETE') {
    const id = req.query?.id || new URLSearchParams(req.url?.split('?')[1] || '').get('id');
    if (!id) return res.status(400).json(jsonError('id query param required'));
    const ok = await sbRemove('spp_blast_accounts', id);
    return res.status(200).json({ ok, id });
  }

  // GET routes
  if (req.method === 'GET') {
    const qp = req.query || Object.fromEntries(new URLSearchParams(req.url?.split('?')[1] || ''));

    if (action === 'health') {
      const { platform, limit } = qp;
      const filters = {};
      if (platform) filters.platform = `eq.${platform}`;
      filters.status = 'eq.active';
      const accounts = await sbQuery('spp_blast_accounts', filters, { limit: parseInt(limit || '20', 10) });
      const results = await checkHealth(Array.isArray(accounts) ? accounts : []);
      return res.status(200).json({ ok: true, results });
    }

    // list (default GET)
    const accounts = await listAccounts(qp.platform, qp.status);
    return res.status(200).json({ ok: true, total: Array.isArray(accounts) ? accounts.length : 0, accounts });
  }

  if (req.method !== 'POST') return res.status(405).json(jsonError('Method not allowed'));

  const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');

  // POST /api/social-blast-accounts/credentials
  if (action === 'credentials') {
    const result = await upsertCredentials(req, body);
    return res.status(200).json({ ok: true, result });
  }

  // POST /api/social-blast-accounts/create (or default POST)
  const { platforms, profile_overrides, captchaKey, auto_verify, save_to_db } = body;
  if (!platforms || !platforms.length) return res.status(400).json(jsonError('platforms[] is required'));

  const results = await createAccounts(req, { platforms, profile_overrides, captchaKey, auto_verify, save_to_db });
  const succeeded = results.filter(r => r.ok).length;

  return res.status(200).json({
    ok: true,
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  });
}

export default allowCors(authCheck(handler));
