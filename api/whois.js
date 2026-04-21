// api/whois.js — WHOIS & domain info lookup
// POST { domain } or GET ?domain=<domain>
// Returns: { ok, domain, whois, da, ip, nameservers, registrar, created, expires }

import { handleCors, checkAuth } from '../lib/auth.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!checkAuth(req, res)) return;

  let domain = req.method === 'POST'
    ? req.body?.domain
    : req.query?.domain;

  if (!domain) return res.status(400).json({ error: 'Missing domain parameter' });

  // Clean up the domain
  domain = domain.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim().toLowerCase();

  const result = { ok: false, domain, whois: null, ip: null, da: null };

  try {
    // ── 1. Domain info via rdap (free, no key needed) ─────────────────────
    const rdapUrl = `https://rdap.org/domain/${domain}`;
    const rdapRes = await fetch(rdapUrl, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    }).catch(() => null);

    if (rdapRes?.ok) {
      const rdap = await rdapRes.json().catch(() => ({}));

      // Extract key info from RDAP
      const nameservers = (rdap.nameservers || []).map(n => n.ldhName?.toLowerCase()).filter(Boolean);
      const events = rdap.events || [];
      const regEvent = events.find(e => e.eventAction === 'registration');
      const expEvent = events.find(e => e.eventAction === 'expiration');
      const updEvent = events.find(e => e.eventAction === 'last changed');

      const entities = rdap.entities || [];
      const registrar = entities.find(e => (e.roles || []).includes('registrar'));
      const registrarName = registrar?.vcardArray?.[1]?.find(v => v[0] === 'fn')?.[3] ||
                            registrar?.handle || null;

      result.whois = {
        registrar:   registrarName,
        created:     regEvent?.eventDate || null,
        expires:     expEvent?.eventDate || null,
        updated:     updEvent?.eventDate || null,
        status:      (rdap.status || []).join(', ') || null,
        nameservers,
        handle:      rdap.handle || null,
      };
      result.ok = true;
    }

    // ── 2. DNS / IP lookup via public DNS-over-HTTPS ──────────────────────
    const dnsRes = await fetch(
      `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=A`,
      { signal: AbortSignal.timeout(8000) }
    ).catch(() => null);

    if (dnsRes?.ok) {
      const dns = await dnsRes.json().catch(() => ({}));
      const aRecord = (dns.Answer || []).find(r => r.type === 1);
      if (aRecord) result.ip = aRecord.data;
    }

    // ── 3. Domain Authority estimate via Moz free endpoint ───────────────
    // (Uses public endpoint; returns null if unavailable — DA is best-effort)
    const mozKey = process.env.MOZ_ACCESS_ID && process.env.MOZ_SECRET_KEY
      ? Buffer.from(`${process.env.MOZ_ACCESS_ID}:${process.env.MOZ_SECRET_KEY}`).toString('base64')
      : null;

    if (mozKey) {
      const mozRes = await fetch('https://lsapi.seomoz.com/v2/url_metrics', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${mozKey}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({ targets: [domain] }),
        signal: AbortSignal.timeout(10000),
      }).catch(() => null);

      if (mozRes?.ok) {
        const mozData = await mozRes.json().catch(() => ({}));
        result.da = mozData?.results?.[0]?.domain_authority ?? null;
        result.pa = mozData?.results?.[0]?.page_authority   ?? null;
      }
    }

    // Mark as ok even if some parts failed — return whatever we got
    result.ok = true;
    return res.status(200).json(result);

  } catch (err) {
    return res.status(200).json({
      ...result,
      ok:    false,
      error: err.message,
    });
  }
}
