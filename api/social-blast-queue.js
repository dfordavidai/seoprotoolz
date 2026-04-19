/**
 * /api/social-blast-queue.js
 * Drip-mode queue manager backed by Supabase
 * Stores pending submissions and processes them with natural spacing
 *
 * Table required (run in Supabase SQL editor):
 *
 *   create table if not exists spp_blast_queue (
 *     id           uuid primary key default gen_random_uuid(),
 *     campaign_id  text,
 *     platform     text not null,
 *     url          text not null,
 *     keyword      text not null,
 *     title        text,
 *     description  text,
 *     tags         text[],
 *     credentials  jsonb,
 *     subreddit    text,
 *     tumblr_blog  text,
 *     status       text not null default 'pending',   -- pending|running|done|failed
 *     result       jsonb,
 *     error        text,
 *     scheduled_at timestamptz not null default now(),
 *     executed_at  timestamptz,
 *     created_at   timestamptz not null default now()
 *   );
 *
 * Routes:
 *   POST /api/social-blast-queue          — enqueue jobs
 *   GET  /api/social-blast-queue?process=1 — process next N pending jobs (call from cron)
 *   GET  /api/social-blast-queue?campaign_id=X — list queue status
 *   DELETE /api/social-blast-queue?id=X   — cancel a pending job
 */

import { allowCors, authCheck, jsonError } from '../lib/auth.js';

// ─── Supabase REST helper ─────────────────────────────────────────────────────

function supabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
  return { url: url.replace(/\/$/, ''), key };
}

async function sbSelect(table, filter = {}, opts = {}) {
  const { url, key } = supabase();
  const params = new URLSearchParams({ select: opts.select || '*', ...filter });
  if (opts.order) params.set('order', opts.order);
  if (opts.limit) params.set('limit', String(opts.limit));

  const res = await fetch(`${url}/rest/v1/${table}?${params}`, {
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
  });
  return res.json();
}

async function sbInsert(table, rows) {
  const { url, key } = supabase();
  const res = await fetch(`${url}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
  });
  return res.json();
}

async function sbUpdate(table, id, patch) {
  const { url, key } = supabase();
  const res = await fetch(`${url}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(patch),
  });
  return res.ok;
}

async function sbDelete(table, id) {
  const { url, key } = supabase();
  const res = await fetch(`${url}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
    },
  });
  return res.ok;
}

// ─── Drip scheduling ──────────────────────────────────────────────────────────

/**
 * Space submissions across a natural time window.
 * Randomises within a ±30% jitter band to look organic.
 */
function buildDripSchedule(platforms, { start_at, min_gap_minutes = 8, max_gap_minutes = 25 }) {
  const schedule = [];
  let cursor = start_at ? new Date(start_at) : new Date();

  for (const platform of platforms) {
    schedule.push({ platform, scheduled_at: new Date(cursor) });
    const gap = min_gap_minutes + Math.random() * (max_gap_minutes - min_gap_minutes);
    cursor = new Date(cursor.getTime() + gap * 60 * 1000);
  }

  return schedule;
}

// ─── Process pending jobs (call via cron or manually) ─────────────────────────

async function processPending(req, limit = 5) {
  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';

  // Fetch jobs that are due
  const now = new Date().toISOString();
  const jobs = await sbSelect('spp_blast_queue', {
    status: 'eq.pending',
    scheduled_at: `lte.${now}`,
  }, { order: 'scheduled_at.asc', limit });

  if (!Array.isArray(jobs) || jobs.length === 0) {
    return { processed: 0, results: [] };
  }

  const results = [];

  for (const job of jobs) {
    // Mark as running
    await sbUpdate('spp_blast_queue', job.id, { status: 'running' });

    try {
      const blastRes = await fetch(`${base}/api/social-blast`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': process.env.API_SECRET_KEY || '',
          'X-Internal': '1',
        },
        body: JSON.stringify({
          platform: job.platform,
          url: job.url,
          keyword: job.keyword,
          title: job.title,
          description: job.description,
          tags: job.tags,
          credentials: job.credentials,
          subreddit: job.subreddit,
          tumblr_blog: job.tumblr_blog,
        }),
      });

      const result = await blastRes.json();

      await sbUpdate('spp_blast_queue', job.id, {
        status: result.ok ? 'done' : 'failed',
        result,
        error: result.ok ? null : (result.error || 'Unknown error'),
        executed_at: new Date().toISOString(),
      });

      results.push({ id: job.id, platform: job.platform, ok: result.ok, result });
    } catch (err) {
      await sbUpdate('spp_blast_queue', job.id, {
        status: 'failed',
        error: err.message,
        executed_at: new Date().toISOString(),
      });
      results.push({ id: job.id, platform: job.platform, ok: false, error: err.message });
    }
  }

  return { processed: results.length, results };
}

// ─── Request handler ──────────────────────────────────────────────────────────

async function handler(req, res) {
  // GET: list queue status or process pending
  if (req.method === 'GET') {
    const { process: doProcess, campaign_id, limit } = req.query || {};

    if (doProcess === '1' || doProcess === 'true') {
      const result = await processPending(req, parseInt(limit || '5', 10));
      return res.status(200).json({ ok: true, ...result });
    }

    const filter = campaign_id ? { campaign_id: `eq.${campaign_id}` } : {};
    const jobs = await sbSelect('spp_blast_queue', filter, { order: 'scheduled_at.asc', limit: 100 });

    const counts = {
      pending: jobs.filter(j => j.status === 'pending').length,
      running: jobs.filter(j => j.status === 'running').length,
      done: jobs.filter(j => j.status === 'done').length,
      failed: jobs.filter(j => j.status === 'failed').length,
    };

    return res.status(200).json({ ok: true, total: jobs.length, counts, jobs });
  }

  // DELETE: cancel a pending job
  if (req.method === 'DELETE') {
    const { id } = req.query || {};
    if (!id) return res.status(400).json(jsonError('id query param required'));
    const ok = await sbDelete('spp_blast_queue', id);
    return res.status(200).json({ ok, id });
  }

  // POST: enqueue a batch with optional drip scheduling
  if (req.method !== 'POST') return res.status(405).json(jsonError('Method not allowed'));

  const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');

  const {
    campaign_id,
    platforms,
    url,
    keyword,
    title,
    description,
    tags,
    credentials_map,
    subreddit,
    tumblr_blog,
    drip,             // boolean — enable drip mode
    drip_options,     // { start_at, min_gap_minutes, max_gap_minutes }
    fire_now,         // boolean — skip queue, fire immediately via /api/social-blast
  } = body;

  if (!url) return res.status(400).json(jsonError('url is required'));
  if (!keyword) return res.status(400).json(jsonError('keyword is required'));
  if (!platforms || !platforms.length) return res.status(400).json(jsonError('platforms[] is required'));

  // Immediate fire — bypass queue
  if (fire_now) {
    const base = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000';

    const blastRes = await fetch(`${base}/api/social-blast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': process.env.API_SECRET_KEY || '',
        'X-Internal': '1',
      },
      body: JSON.stringify({
        platforms, url, keyword, title, description, tags,
        credentials_map, subreddit, tumblr_blog,
        drip_mode: false,
      }),
    });

    const result = await blastRes.json();
    return res.status(200).json(result);
  }

  // Build drip schedule or schedule all for immediate execution
  const schedule = drip
    ? buildDripSchedule(platforms, drip_options || {})
    : platforms.map(p => ({ platform: p, scheduled_at: new Date() }));

  const rows = schedule.map(({ platform, scheduled_at }) => ({
    campaign_id: campaign_id || null,
    platform,
    url,
    keyword,
    title: title || null,
    description: description || null,
    tags: tags || null,
    credentials: (credentials_map || {})[platform.toLowerCase()] || null,
    subreddit: subreddit || null,
    tumblr_blog: tumblr_blog || null,
    status: 'pending',
    scheduled_at: scheduled_at.toISOString(),
  }));

  const inserted = await sbInsert('spp_blast_queue', rows);

  return res.status(200).json({
    ok: true,
    enqueued: rows.length,
    campaign_id: campaign_id || null,
    drip_mode: !!drip,
    first_fire: schedule[0]?.scheduled_at,
    last_fire: schedule[schedule.length - 1]?.scheduled_at,
    jobs: inserted,
  });
}

export default allowCors(authCheck(handler));
