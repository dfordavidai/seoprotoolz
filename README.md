# SEO Parasite Pro — Vercel Backend v2.0

Full serverless backend for SEO Parasite Pro. Deploy to Vercel in minutes.

---

## 📁 File Structure

```
/
├── api/
│   ├── health.js              — Status check (public, no auth)
│   ├── proxy.js               — Universal CORS proxy (GET + POST)
│   ├── ping.js                — Search engine + RSS pinger
│   ├── index.js               — Google + Bing URL indexing
│   ├── captcha.js             — Captcha solving proxy (2captcha / anticaptcha / capmonster)
│   ├── whois.js               — Domain WHOIS/RDAP lookup
│   ├── headers.js             — HTTP header inspector
│   ├── supabase.js            — Supabase sync proxy (hides service-role key)
│   ├── register.js            — Preset platform account creator (Playwright)
│   ├── universal-register.js  — Universal account creator for any URL (Playwright)
│   └── click-link.js          — Browser-based link clicker (Playwright)
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
```bash
npm install -g vercel
```

### 2. Deploy
```bash
cd /path/to/this/folder
vercel --prod
```

### 3. Set Environment Variables in Vercel Dashboard

Go to **Project → Settings → Environment Variables** and add:

| Variable | Required | Description |
|---|---|---|
| `API_SECRET_KEY` | ✅ Recommended | Any secret string. Set this in your frontend too. If not set, API is open (dev mode). |
| `SUPABASE_URL` | For sync | Your Supabase project URL e.g. `https://xyz.supabase.co` |
| `SUPABASE_SERVICE_KEY` | For sync | Service role key (found in Supabase → Settings → API) |
| `GOOGLE_SA_JSON` | For indexing | Full Google service account JSON (paste the entire JSON string) |
| `BING_API_KEY` | For indexing | Bing Webmaster Tools API key |
| `TWOCAPTCHA_KEY` | For captcha | 2captcha API key |
| `ANTICAPTCHA_KEY` | For captcha | anti-captcha.com API key |
| `CAPMONSTER_KEY` | For captcha | capmonster.cloud API key |

> **Note:** Only one captcha key is needed. The backend will use whichever is configured, in this priority order: capmonster → anticaptcha → 2captcha.

---

## 📡 API Reference

All endpoints return JSON. Auth is via `X-API-Key: <your-secret>` header.

### `GET /api/health`
Public status check. No auth required.

```json
{
  "ok": true,
  "service": "SEO Parasite Pro Backend",
  "version": "2.0.0",
  "env": { "has_secret": true, "has_supabase": true, ... }
}
```

---

### `POST /api/proxy`
Universal CORS proxy. Fetches any URL from the server side.

```json
{
  "url": "https://example.com/wp-login.php",
  "method": "POST",
  "body": "log=user&pwd=pass",
  "headers": { "Content-Type": "application/x-www-form-urlencoded" },
  "timeout": 25000
}
```

Response always has HTTP 200. Check `ok` and `status_code` inside:
```json
{
  "ok": true,
  "status_code": 200,
  "body": "<html>...",
  "redirected": false,
  "redirect_url": "https://example.com/wp-login.php",
  "content_type": "text/html; charset=UTF-8"
}
```

---

### `POST /api/ping`
Pings search engines + RSS aggregators after publishing content.

```json
{
  "url": "https://yoursite.com/new-post",
  "sitemap": "https://yoursite.com/sitemap.xml",
  "name": "My New Post"
}
```

---

### `POST /api/index`
Submits URLs to Google Indexing API and Bing URL Submission API.

```json
{
  "urls": ["https://yoursite.com/page1", "https://yoursite.com/page2"],
  "siteUrl": "https://yoursite.com",
  "engines": ["google", "bing"]
}
```

---

### `POST /api/captcha`
Solves captchas via configured solver service.

```json
{
  "type": "recaptcha_v2",
  "sitekey": "6Le...",
  "pageurl": "https://example.com/register",
  "solver": "2captcha",
  "apiKey": "optional-override-key"
}
```

Supported types: `recaptcha_v2`, `recaptcha_v3`, `hcaptcha`, `image`

---

### `GET /api/whois?domain=example.com`
Also accepts `POST { domain }`.

Returns domain age, registration date, expiry, registrar, nameservers.

---

### `GET /api/headers?url=https://example.com`
Also accepts `POST { url }`.

Returns full HTTP headers + SEO signals (x-robots-tag, canonical link, indexability).

---

### `POST /api/supabase`
Proxies Supabase REST operations without exposing the service role key.

```json
{
  "action": "upsert",
  "table": "spp_keywords",
  "data": { "keyword": "seo tips", "volume": 5000 }
}
```

```json
{
  "action": "select",
  "table": "spp_links",
  "filter": { "platform": "eq.wordpress" }
}
```

Actions: `upsert` | `insert` | `update` | `select` | `delete` | `rpc`

---

### `POST /api/register`
Creates an account on a preset platform using Playwright.

```json
{
  "platform": "wordpress",
  "username": "myuser123",
  "password": "SecurePass!1",
  "captchaKey": "your-2captcha-key",
  "useMailTm": true,
  "autoVerify": true
}
```

Supported platforms: `wordpress`, `medium`, `reddit`, `quora`, `tumblr`, `weebly`,
`blogger`, `wix`, `devto`, `hashnode`, `strikingly`, `site123`, `livejournal`,
`ghost`, `substack`, `linkedin`, `pinterest`, `mix`

---

### `POST /api/universal-register`
Creates an account on **any** website. Automatically finds the signup form.

```json
{
  "url": "https://anywebsite.com/register",
  "profile": {
    "email": "user@tempmail.com",
    "username": "myuser",
    "password": "SecurePass!1",
    "firstName": "John",
    "lastName": "Doe",
    "fullName": "John Doe",
    "phone": "5551234567",
    "website": "https://mysite.com",
    "bio": "SEO professional",
    "city": "New York",
    "country": "US",
    "zipcode": "10001",
    "birthYear": "1990",
    "birthMonth": "06",
    "birthDay": "15"
  },
  "captchaKey": "optional-2captcha-key",
  "autoVerify": false,
  "mailTmToken": "optional-mailtm-token-if-autoverify-true"
}
```

---

### `POST /api/click-link`
Visits a URL using a real Chromium browser (bypasses anti-bot).

```json
{
  "url": "https://example.com/verify?token=abc123",
  "waitFor": "networkidle",
  "waitMs": 2000,
  "screenshot": false
}
```

---

## 🔒 Security Notes

- Set `API_SECRET_KEY` in Vercel env vars to lock down all endpoints
- The `SUPABASE_SERVICE_KEY` is never exposed to the browser — only the backend proxy uses it
- The proxy blocks requests to localhost and private IP ranges
- All Playwright functions run in an isolated serverless container per request

---

## 🛠 Local Development

```bash
npm install
vercel dev
```

The server will start at `http://localhost:3000`.
