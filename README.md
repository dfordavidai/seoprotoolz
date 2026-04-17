# SEO Parasite Pro — Vercel Backend v2.1

Full serverless backend for SEO Parasite Pro. Deploy to Vercel in minutes.

---

## 📁 File Structure

```
/
├── api/
│   ├── health.js              — Status + feature flags (GET/POST, no auth required)
│   ├── index.js               — API root info page
│   ├── proxy.js               — Universal CORS proxy (GET + POST)
│   ├── proxy-test.js          — Proxy liveness tester (Proxy Manager module)
│   ├── ping.js                — Google + Bing + IndexNow URL submission
│   ├── captcha.js             — Captcha solving relay (2captcha / anticaptcha / capmonster)
│   ├── whois.js               — Domain WHOIS/RDAP + DNS lookup
│   ├── headers.js             — HTTP header inspector + SEO signals
│   ├── supabase.js            — Supabase relay (hides service-role key)
│   ├── register.js            — Platform account creator via Playwright (platform ID routing)
│   ├── universal-register.js  — Universal account creator for any URL
│   └── click-link.js          — Browser-based link clicker / CTR simulator
│
├── lib/
│   ├── auth.js                — API key auth + CORS helpers
│   ├── mailtm.js              — mail.tm disposable inbox helper
│   ├── captcha-solver.js      — 2captcha / anticaptcha / capmonster helper
│   └── playwright-helpers.js  — Shared Playwright/Chromium utilities
│
├── package.json
├── vercel.json
└── README.md
```

---

## 🚀 Deployment

### 1. Install Vercel CLI

```
npm install -g vercel
```

### 2. Deploy

```
cd /path/to/this/folder
vercel --prod
```

### 3. Set Environment Variables in Vercel Dashboard

Go to **Project → Settings → Environment Variables** and add:

| Variable | Required | Description |
|---|---|---|
| `API_SECRET_KEY` | ✅ Recommended | Any secret string. Set this in frontend Settings too. |
| `SUPABASE_URL` | For sync | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | For sync | Supabase public anon key |
| `SUPABASE_SERVICE_KEY` | For sync | Service role key (Supabase → Settings → API) |
| `BING_WEBMASTER_KEY` | For indexing | Bing Webmaster Tools API key |
| `INDEXNOW_KEY` | For indexing | Your IndexNow key |
| `TWOCAPTCHA_KEY` | For captcha | 2captcha API key |
| `ANTICAPTCHA_KEY` | For captcha | anti-captcha.com API key |
| `CAPMONSTER_KEY` | For captcha | capmonster.cloud API key |
| `MOZ_ACCESS_ID` | Optional | Moz API access ID (DA lookups) |
| `MOZ_SECRET_KEY` | Optional | Moz API secret key |

> Only one captcha key is needed. Priority: capmonster → anticaptcha → 2captcha.

---

## 📡 API Reference

All endpoints return JSON. Auth via `X-API-Key: <key>` or `x-secret: <key>` header.

### `GET /api/health`
Public status check. Returns feature flags so the frontend knows what is available.

### `POST /api/proxy`
Universal CORS proxy. Body: `{ url, method, headers, body, timeout }`.
Returns both `status` and `status_code` for frontend compatibility.

### `POST /api/proxy-test`
Tests proxy liveness. Body: `{ proxy: "http://ip:port", url: "https://api.ipify.org?format=json" }`.
Returns: `{ ok, status, ms, ip }`.

### `POST /api/ping`
Pings Google, Bing, and IndexNow. Body: `{ urls[], pingGoogle, pingBing, pingIndexNow, indexNowKey, batch }`.
Set `batch: true` for efficient multi-URL IndexNow grouping by host.

### `POST /api/register`
Creates an account on a preset platform via Playwright.

**Frontend v2 shape (preferred):**
```json
{ "platform": "devto", "username": "seopro1234", "password": "MyPass!99",
  "captchaKey": "optional", "useMailTm": true, "autoVerify": true }
```

**Supported platforms:** `wordpress`, `medium`, `reddit`, `quora`, `tumblr`, `weebly`,
`blogger`, `wix`, `devto`, `hashnode`, `strikingly`, `site123`, `github`, `gitlab`,
`netlify`, `vercel`, `notion`, `substack`, `ghost`, `linkedin`, `pinterest`, `mix`, `livejournal`

**Also accepts legacy shape:** `{ url, email, password, username }`

Returns: `{ ok, email, apiKey, profileUrl, verifyStatus, note, log[], captchaSolved, formFields[] }`

### `POST /api/universal-register`
Creates an account on any website. Auto-creates mail.tm inbox, fills form, solves captcha.
Body: `{ url, proxy?, captchaKey?, profile? }`

### `POST /api/click-link`
Visits a URL with real Chromium. Used for email verification and CTR simulation.
Body: `{ url, dwellMs?, scrollDepth?, clickLinks?, screenshotB64? }`

### `POST /api/supabase`
Proxies Supabase without exposing the service role key.

Action-based: `{ action: "upsert"|"insert"|"select"|"update"|"delete"|"rpc", table, data, filter }`
Endpoint-based: `{ endpoint: "/rest/v1/table?select=*", method: "GET" }`

### `POST /api/captcha`
Solves captchas. Body: `{ type, site_key, site_url, solver?, api_key? }`
Types: `recaptcha_v2`, `recaptcha_v3`, `hcaptcha`, `image`

### `GET /api/whois?domain=example.com`
WHOIS, DNS, IP, registrar, DA (requires Moz keys).

### `GET /api/headers?url=https://example.com`
Full HTTP headers and SEO signals.

---

## 🔒 Security

- Set `API_SECRET_KEY` to lock all endpoints
- `SUPABASE_SERVICE_KEY` is never sent to the browser
- Proxy blocks requests to private/loopback IP ranges

---

## 🛠 Local Development

```
npm install
vercel dev
```
