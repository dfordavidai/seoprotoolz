// lib/mailtm.js — reusable mail.tm disposable inbox helper
// Used by register.js and universal-register.js

const BASE = 'https://api.mail.tm';

/**
 * Creates a fresh mail.tm inbox and returns { address, password, token }
 */
export async function createInbox() {
  // 1. Fetch an available domain
  const domRes = await fetch(`${BASE}/domains`, { signal: AbortSignal.timeout(10000) });
  const domData = await domRes.json();
  const domain = domData['hydra:member']?.[0]?.domain;
  if (!domain) throw new Error('mail.tm: no domains available');

  // 2. Build random credentials
  const rand     = Math.random().toString(36).slice(2, 10);
  const address  = `${rand}@${domain}`;
  const password = 'Mx' + Math.random().toString(36).slice(2, 12) + '!9';

  // 3. Create account
  const accRes = await fetch(`${BASE}/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password }),
    signal: AbortSignal.timeout(10000),
  });
  if (!accRes.ok) {
    const err = await accRes.text();
    throw new Error('mail.tm account creation failed: ' + err);
  }

  // 4. Get auth token
  const tokRes = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password }),
    signal: AbortSignal.timeout(10000),
  });
  const tokData = await tokRes.json();
  if (!tokData.token) throw new Error('mail.tm: token fetch failed');

  return { address, password, token: tokData.token };
}

/**
 * Polls mail.tm until a verification link arrives.
 * Returns the link string, or null on timeout.
 * @param {string} token   - mail.tm JWT
 * @param {number} maxWait - milliseconds to wait (default 90s)
 */
export async function pollForVerifyLink(token, maxWait = 90000) {
  const deadline = Date.now() + maxWait;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));

    const res = await fetch(`${BASE}/messages`, {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    const msgs = data['hydra:member'] || [];

    if (msgs.length > 0) {
      // Fetch full message body
      const msgRes = await fetch(`${BASE}/messages/${msgs[0].id}`, {
        headers: { Authorization: 'Bearer ' + token },
        signal: AbortSignal.timeout(10000),
      });
      const msg = await msgRes.json();
      const body = msg.text || msg.html || '';

      // Extract verification link
      const match = body.match(
        /https?:\/\/[^\s"'<>]+(?:verif|confirm|activate|activ|token|click)[^\s"'<>]*/i
      );
      if (match) return match[0];
    }
  }
  return null;
}
