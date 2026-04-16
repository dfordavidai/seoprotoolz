// lib/captcha-solver.js — reusable captcha solving helper
// Supports: 2captcha, anti-captcha, capmonster
// Used by captcha.js endpoint and directly by register.js / universal-register.js

export const SOLVERS = {
  twocaptcha:  {
    submit: 'https://2captcha.com/in.php',
    result: 'https://2captcha.com/res.php',
  },
  anticaptcha: {
    submit: 'https://api.anti-captcha.com/createTask',
    result: 'https://api.anti-captcha.com/getTaskResult',
  },
  capmonster: {
    submit: 'https://api.capmonster.cloud/createTask',
    result: 'https://api.capmonster.cloud/getTaskResult',
  },
};

/**
 * Picks the best available solver based on env vars + request preference.
 * Returns { solver, apiKey } or { solver: null, apiKey: null }
 */
export function pickSolver(preferredSolver, clientKey) {
  const solver =
    preferredSolver ||
    (process.env.CAPMONSTER_KEY  ? 'capmonster'  : null) ||
    (process.env.ANTICAPTCHA_KEY ? 'anticaptcha' : null) ||
    (process.env.TWOCAPTCHA_KEY  ? 'twocaptcha'  : null);

  const apiKey =
    clientKey ||
    (solver === 'capmonster'  ? process.env.CAPMONSTER_KEY  : null) ||
    (solver === 'anticaptcha' ? process.env.ANTICAPTCHA_KEY : null) ||
    (solver === 'twocaptcha'  ? process.env.TWOCAPTCHA_KEY  : null);

  return { solver, apiKey };
}

/**
 * Submits a captcha task and returns the taskId.
 * @param {string} solver  - 'twocaptcha' | 'anticaptcha' | 'capmonster'
 * @param {string} apiKey
 * @param {object} opts    - { type, sitekey, pageurl, imageBase64 }
 */
export async function submitTask(solver, apiKey, opts) {
  const { type = 'recaptcha_v2', sitekey, pageurl, imageBase64 } = opts;

  if (solver === 'twocaptcha') {
    let body = `key=${apiKey}&json=1`;
    if (type === 'image' && imageBase64) {
      body += `&method=base64&body=${encodeURIComponent(imageBase64)}`;
    } else if (type === 'recaptcha_v2') {
      body += `&method=userrecaptcha&googlekey=${sitekey}&pageurl=${encodeURIComponent(pageurl)}`;
    } else if (type === 'recaptcha_v3') {
      body += `&method=userrecaptcha&version=v3&googlekey=${sitekey}&pageurl=${encodeURIComponent(pageurl)}&action=verify&min_score=0.3`;
    } else if (type === 'hcaptcha') {
      body += `&method=hcaptcha&sitekey=${sitekey}&pageurl=${encodeURIComponent(pageurl)}`;
    }
    const res  = await fetch(SOLVERS.twocaptcha.submit, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await res.json();
    if (!data.request || data.status !== 1) throw new Error('2captcha submit failed: ' + JSON.stringify(data));
    return data.request; // taskId
  }

  // Anti-Captcha / CapMonster (identical JSON format)
  let task = {};
  if (type === 'image' && imageBase64) {
    task = { type: 'ImageToTextTask', body: imageBase64 };
  } else if (type === 'recaptcha_v2') {
    task = { type: 'NoCaptchaTaskProxyless', websiteURL: pageurl, websiteKey: sitekey };
  } else if (type === 'recaptcha_v3') {
    task = { type: 'RecaptchaV3TaskProxyless', websiteURL: pageurl, websiteKey: sitekey, minScore: 0.3, pageAction: 'verify' };
  } else if (type === 'hcaptcha') {
    task = { type: 'HCaptchaTaskProxyless', websiteURL: pageurl, websiteKey: sitekey };
  }

  const res  = await fetch(SOLVERS[solver].submit, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientKey: apiKey, task }),
  });
  const data = await res.json();
  if (data.errorId) throw new Error(data.errorDescription || 'Task creation failed');
  return data.taskId;
}

/**
 * Polls for a captcha result until solved or timeout.
 * @param {string} solver
 * @param {string|number} taskId
 * @param {string} apiKey
 * @param {number} maxWait - ms (default 120s)
 * @returns {{ ok: true, solution: string }}
 */
export async function pollResult(solver, taskId, apiKey, maxWait = 120000) {
  const deadline = Date.now() + maxWait;
  await new Promise(r => setTimeout(r, 5000)); // initial wait

  while (Date.now() < deadline) {
    if (solver === 'twocaptcha') {
      const res  = await fetch(`${SOLVERS.twocaptcha.result}?action=get&key=${apiKey}&id=${taskId}`);
      const text = await res.text();
      if (text.startsWith('OK|')) return { ok: true, solution: text.split('|')[1] };
      if (text !== 'CAPCHA_NOT_READY') throw new Error('2captcha error: ' + text);
    } else {
      const res  = await fetch(SOLVERS[solver].result, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
      });
      const data = await res.json();
      if (data.status === 'ready') {
        return {
          ok: true,
          solution: data.solution?.gRecaptchaResponse || data.solution?.text || '',
        };
      }
      if (data.errorId) throw new Error(data.errorDescription || 'Solver error');
    }
    await new Promise(r => setTimeout(r, 4000));
  }

  throw new Error('Captcha solve timeout after ' + (maxWait / 1000) + 's');
}

/**
 * High-level: solve a captcha end-to-end.
 * Returns { ok, solution, solver, taskId } or { ok: false, error }
 */
export async function solveCaptcha(solver, apiKey, opts) {
  try {
    const taskId  = await submitTask(solver, apiKey, opts);
    const result  = await pollResult(solver, taskId, apiKey);
    return { ...result, solver, taskId };
  } catch (e) {
    return { ok: false, error: e.message, solver };
  }
}
