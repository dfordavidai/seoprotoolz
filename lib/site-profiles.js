/**
 * lib/site-profiles.js
 * Per-platform knowledge base for BLP + Global Blast Playwright post engine.
 * FORMAT TYPES:
 *  'markdown'       — platform renders Markdown (raw MD, NO HTML tags)
 *  'html'           — platform accepts raw HTML in editor
 *  'text'           — plain text only (strip ALL markup including MD markers)
 *  'richtext'       — WYSIWYG / contenteditable (paste as text)
 *  'upload_pdf'     — requires an actual PDF file upload (cannot do via REST)
 *  'upload_html_pdf'— accepts HTML or PDF file upload
 *  'auto'           — detect at runtime from page content
 */

// ─── SHARED HELPERS ───────────────────────────────────────────────────────────

function slug(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Strip HTML tags → plain text, preserving URLs from href attributes */
function toPlainText(html) {
  // First extract href URLs so they're preserved as plain text
  const withUrls = (html || '').replace(/<a[^>]+href="([^"]+)"[^>]*>([^<]*)<\/a>/gi, '$2 ($1)');
  return withUrls.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Markdown → plain text (strip markers but KEEP URLs) */
function mdToPlain(md) {
  return (md || '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    // Keep the URL visible from markdown links: [text](url) → text (url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/>+\s*/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .trim();
}

/** Basic Markdown → HTML conversion */
function mdToHtml(md) {
  return (md || '')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^[-*+] (.+)$/gm, '<li>$1</li>')
    .split('\n\n')
    .map(p => p.trim().startsWith('<') ? p : '<p>' + p.trim() + '</p>')
    .join('\n');
}

// ─── PDF / DOCUMENT PLATFORM DETECTION ────────────────────────────────────────

const PDF_DOMAINS = new Set([
  'scribd.com', 'issuu.com', 'slideshare.net', 'academia.edu', 'archive.org',
]);

function isPdfPlatform(urlOrDomain) {
  let domain = urlOrDomain;
  try { domain = new URL(urlOrDomain).hostname.replace(/^www\./, ''); } catch (_) {}
  return PDF_DOMAINS.has(domain);
}

// ─── SITE PROFILE REGISTRY ────────────────────────────────────────────────────

const PROFILES = {

  // ── PASTE / ANON ──────────────────────────────────────────────────────────

  'pastebin.com': {
    loginUrl: 'https://pastebin.com/login',
    loginSelectors: { user: '#loginform input[name="paste_username"]', pass: '#loginform input[name="paste_password"]', submit: '#loginform [type="submit"]' },
    postUrl: 'https://pastebin.com/',
    postType: 'text',
    postSelectors: {
      body: '#postform-text',
      title: '#postform-name',
      submit: '#postform [type="submit"]',
      successPattern: /pastebin\.com\/[A-Za-z0-9]{8}/,
    },
  },

  'justpaste.it': {
    loginUrl: 'https://justpaste.it/login',
    loginSelectors: { user: 'input[name="email"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://justpaste.it/create',
    postType: 'text',
    postSelectors: {
      title: 'input[name="title"]',
      body: '.jp-editor [contenteditable]',
      submit: '#save-button,[name="publish"]',
      successPattern: /justpaste\.it\/[A-Za-z0-9]+/,
    },
  },

  'rentry.co': {
    loginUrl: null,
    postUrl: 'https://rentry.co',
    postType: 'text',
    postSelectors: {
      body: '#id_text',
      submit: '[type="submit"]',
      successPattern: /rentry\.co\/[a-z0-9]+/,
    },
    anonymous: true,
  },

  'hastebin.com': {
    loginUrl: null,
    postUrl: 'https://hastebin.com',
    postType: 'text',
    postSelectors: {
      body: '#textArea,[contenteditable="true"]',
      submit: null,
      submitKey: 'ctrl+s',
      successPattern: /hastebin\.com\/[a-z]+/,
    },
    anonymous: true,
  },

  'controlc.com': {
    loginUrl: null,
    postUrl: 'https://controlc.com',
    postType: 'text',
    postSelectors: {
      body: 'textarea[name="paste_data"],textarea[name="content"]',
      submit: '[type="submit"]',
      successPattern: /controlc\.com\/[a-f0-9]+/,
    },
    anonymous: true,
  },

  'dpaste.com': {
    loginUrl: null,
    postUrl: 'https://dpaste.com',
    postType: 'text',
    postSelectors: {
      body: 'textarea[name="content"]',
      submit: '[type="submit"][value="Save"]',
      successPattern: /dpaste\.com\/[A-Z0-9]+/,
    },
    anonymous: true,
  },

  'paste.ee': {
    loginUrl: 'https://paste.ee/login',
    loginSelectors: { user: 'input[name="email"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://paste.ee',
    postType: 'text',
    postSelectors: {
      body: '#paste-content,textarea[name="section_0_contents"]',
      submit: '#submit-paste,[type="submit"]',
      successPattern: /paste\.ee\/p\//,
    },
  },

  'write.as': {
    loginUrl: 'https://write.as/login',
    loginSelectors: { user: 'input[name="alias"]', pass: 'input[name="pass"]', submit: '[type="submit"]' },
    postUrl: 'https://write.as/new',
    postType: 'markdown',
    postSelectors: {
      body: '#editor,textarea[name="body"]',
      submit: '#publish,[type="submit"][value="Publish"]',
      successPattern: /write\.as\//,
    },
  },

  // ── BLOGGING PLATFORMS ────────────────────────────────────────────────────

  'medium.com': {
    loginUrl: 'https://medium.com/m/signin',
    loginSelectors: null,
    postUrl: 'https://medium.com/new-story',
    postType: 'markdown',
    postSelectors: {
      title: 'h3[data-testid="title"] [data-placeholder]',
      body: '[data-slate-editor] p',
      submit: '[data-testid="publish-button"]',
      successPattern: /medium\.com\/@[^/]+\//,
    },
    preferApi: true,
  },

  'dev.to': {
    loginUrl: 'https://dev.to/enter',
    loginSelectors: { user: 'input[name="user[email]"]', pass: 'input[name="user[password]"]', submit: '[name="commit"]' },
    postUrl: 'https://dev.to/new',
    postType: 'markdown',
    postSelectors: {
      title: '#article-form--title',
      body: '#article-form--body,.CodeMirror-scroll,#editor-0',
      submit: '[data-testid="publish-button"],#btn-publish',
      successPattern: /dev\.to\/[^/]+\/[^/]+-\d+/,
    },
  },

  'hashnode.com': {
    loginUrl: 'https://hashnode.com/api/auth/signin/email-password',
    loginSelectors: { user: 'input[name="email"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://hashnode.com/post',
    postType: 'markdown',
    postSelectors: {
      title: 'input[placeholder*="title"]',
      body: '.ql-editor,[data-placeholder*="Write"]',
      submit: '[data-testid="publish-btn"],button:has-text("Publish")',
      successPattern: /hashnode\.com\/@/,
    },
  },

  'substack.com': {
    loginUrl: 'https://substack.com/sign-in',
    loginSelectors: { user: 'input[name="email"]', pass: 'input[type="password"]', submit: '[type="submit"]' },
    postUrl: (creds) => `https://${creds.subdomain || 'open'}.substack.com/publish`,
    postType: 'html',
    postSelectors: {
      title: '[data-testid="post-title-input"],h1[contenteditable]',
      body: '.pub-editor [contenteditable="true"]',
      submit: '[data-testid="publish-button"],button:has-text("Publish")',
      successPattern: /substack\.com\/p\//,
    },
  },

  'wordpress.com': {
    loginUrl: 'https://wordpress.com/log-in',
    loginSelectors: { user: '#usernameOrEmail', pass: '#password', submit: '#primary form [type="submit"]' },
    postUrl: 'https://wordpress.com/post',
    postType: 'html',
    postSelectors: {
      title: '.editor-post-title__input',
      body: '.block-editor-rich-text__editable[aria-label="Add text or type"]',
      submit: '.editor-post-publish-button',
      successPattern: /wordpress\.com\/post\//,
    },
  },

  'blogger.com': {
    loginUrl: 'https://accounts.google.com/ServiceLogin',
    loginSelectors: { user: '#identifierId', pass: 'input[name="Passwd"]', submit: '#identifierNext,#passwordNext' },
    postUrl: 'https://www.blogger.com/blog/post/create',
    postType: 'html',
    postSelectors: {
      title: '#post-title-panel input',
      body: '.editable.main-content,[contenteditable="true"]',
      submit: '#publish-btn',
      successPattern: /blogger\.com|blogspot\.com/,
    },
    requiresGoogle: true,
  },

  'tumblr.com': {
    loginUrl: 'https://www.tumblr.com/login',
    loginSelectors: { user: '#signup_email,[name="user[email]"]', pass: '#signup_password,[name="user[password]"]', submit: '[type="submit"]' },
    postUrl: 'https://www.tumblr.com/new/text',
    postType: 'html',
    postSelectors: {
      title: '[data-testid="post-title"]',
      body: '[data-testid="post-body"] [contenteditable]',
      submit: '[data-testid="publish-button"]',
      successPattern: /tumblr\.com\/post\//,
    },
  },

  'ghost.io': {
    loginUrl: (creds) => `https://${creds.subdomain}.ghost.io/ghost/#/signin`,
    loginSelectors: { user: '#email', pass: '#password', submit: '[type="submit"]' },
    postUrl: (creds) => `https://${creds.subdomain}.ghost.io/ghost/#/editor/post`,
    postType: 'html',
    postSelectors: {
      title: '.gh-editor-title',
      body: '[data-kg-editor] [contenteditable]',
      submit: '.gh-btn-editor-publish,.publish-flow__button',
      successPattern: /ghost\.io\//,
    },
  },

  'livejournal.com': {
    loginUrl: 'https://www.livejournal.com/login.bml',
    loginSelectors: { user: '#user', pass: '#password', submit: '#login-btn,[type="submit"]' },
    postUrl: 'https://www.livejournal.com/update.bml',
    postType: 'html',
    postSelectors: {
      title: '#subject',
      body: '#draft,[name="event"],.draft-content',
      submit: '#btn_submit',
      successPattern: /livejournal\.com\/[^/]+\/\d+/,
    },
  },

  'hubpages.com': {
    loginUrl: 'https://hubpages.com/user/login',
    loginSelectors: { user: '#email', pass: '#password', submit: '[type="submit"]' },
    postUrl: 'https://hubpages.com/hubs/create',
    postType: 'text',
    postSelectors: {
      title: 'input[name="title"]',
      body: '[contenteditable="true"]',
      submit: '[type="submit"][value*="Save"],[type="submit"]',
      successPattern: /hubpages\.com\//,
    },
  },

  'vocal.media': {
    loginUrl: 'https://vocal.media/login',
    loginSelectors: { user: 'input[type="email"]', pass: 'input[type="password"]', submit: '[type="submit"]' },
    postUrl: 'https://vocal.media/new',
    postType: 'text',
    postSelectors: {
      title: '[placeholder*="Title"],[data-testid="story-title"]',
      body: '[contenteditable="true"]',
      submit: 'button:has-text("Publish"),button:has-text("Submit")',
      successPattern: /vocal\.media\//,
    },
  },

  'wattpad.com': {
    loginUrl: 'https://www.wattpad.com/login',
    loginSelectors: { user: 'input[name="username"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://www.wattpad.com/myworks/new',
    postType: 'text',
    postSelectors: {
      title: '#book-title',
      body: '#story-text,[contenteditable]',
      submit: '[name="submit"],button[type="submit"]',
      successPattern: /wattpad\.com\/story\//,
    },
  },

  // ── WEB 2.0 BUILDERS ──────────────────────────────────────────────────────

  'weebly.com': {
    loginUrl: 'https://www.weebly.com/login',
    loginSelectors: { user: '#email', pass: '#password', submit: '#submit-login' },
    postUrl: null,
    postType: 'text',
    autoNav: true,
    postSelectors: {
      title: '.blog-post-title-input',
      body: '[contenteditable="true"]',
      submit: '.publish-btn',
      successPattern: /weebly\.com/,
    },
  },

  'strikingly.com': {
    loginUrl: 'https://www.strikingly.com/auth/sign_in',
    loginSelectors: { user: '#user_email', pass: '#user_password', submit: '[type="submit"]' },
    postUrl: null,
    postType: 'text',
    autoNav: true,
    postSelectors: {
      title: '.blog-title-input',
      body: '[contenteditable]',
      submit: '.publish-post',
      successPattern: /strikingly\.com/,
    },
  },

  'wix.com': {
    loginUrl: 'https://users.wix.com/signin',
    loginSelectors: { user: '#email', pass: '#password', submit: '[data-testid="loginButton"]' },
    postUrl: null,
    postType: 'html',
    autoNav: true,
    postSelectors: {
      title: '[aria-label="Post title"]',
      body: '[contenteditable="true"]',
      submit: '[data-hook="publish-button"]',
      successPattern: /wix\.com/,
    },
  },

  'jimdo.com': {
    loginUrl: 'https://account.jimdo.com/en/login',
    loginSelectors: { user: 'input[name="email"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: null,
    postType: 'text',
    autoNav: true,
    postSelectors: {
      body: '[contenteditable="true"]',
      submit: 'button:has-text("Publish")',
      successPattern: /jimdosite\.com|jimdo\.com/,
    },
  },

  'webnode.com': {
    loginUrl: 'https://www.webnode.com/login/',
    loginSelectors: { user: 'input[name="username"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: null,
    postType: 'text',
    autoNav: true,
    postSelectors: {
      body: '[contenteditable="true"]',
      submit: 'button:has-text("Save")',
      successPattern: /webnode\.com/,
    },
  },

  'telegra.ph': {
    loginUrl: null,
    postUrl: 'https://telegra.ph',
    postType: 'text',
    anonymous: true,
    preferApi: true,
    postSelectors: {
      title: 'h1[contenteditable],input.title_input',
      body: 'p[contenteditable],article [contenteditable]',
      submit: 'button.publish_button',
      successPattern: /telegra\.ph\/[A-Za-z0-9-]+/,
    },
  },

  // ── DOCUMENT / SLIDE ──────────────────────────────────────────────────────
  // These platforms require actual PDF file uploads. The backend cannot
  // auto-upload a PDF — the frontend generates a PDF and shows a download
  // panel for manual upload. The REST handler returns a {manual: true} signal.

  'scribd.com': {
    loginUrl: 'https://www.scribd.com/login',
    loginSelectors: { user: 'input[name="email"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://www.scribd.com/upload-document',
    postType: 'upload_pdf',
    uploadPage: 'https://www.scribd.com/upload-document',
    postSelectors: {
      upload: 'input[type="file"]',
      submit: '[type="submit"]',
      successPattern: /scribd\.com\/document\//,
    },
  },

  'issuu.com': {
    loginUrl: 'https://issuu.com/login',
    loginSelectors: { user: 'input[type="email"]', pass: 'input[type="password"]', submit: '[type="submit"]' },
    postUrl: 'https://issuu.com/home/publish',
    postType: 'upload_pdf',
    uploadPage: 'https://issuu.com/home/publish',
    postSelectors: {
      upload: 'input[type="file"]',
      submit: '[type="submit"]',
      successPattern: /issuu\.com\//,
    },
  },

  'slideshare.net': {
    loginUrl: 'https://www.slideshare.net/login',
    loginSelectors: { user: 'input[name="email"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://www.slideshare.net/upload',
    postType: 'upload_pdf',
    uploadPage: 'https://www.slideshare.net/upload',
    postSelectors: {
      upload: 'input[type="file"]',
      submit: '#btn-upload,[type="submit"]',
      successPattern: /slideshare\.net\/[^/]+\//,
    },
  },

  'academia.edu': {
    loginUrl: 'https://www.academia.edu/login',
    loginSelectors: { user: 'input[name="email"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://www.academia.edu/upload',
    postType: 'upload_pdf',
    uploadPage: 'https://www.academia.edu/upload',
    postSelectors: {
      upload: 'input[type="file"]',
      submit: '[type="submit"]',
      successPattern: /academia\.edu\//,
    },
  },

  'archive.org': {
    loginUrl: 'https://archive.org/account/login',
    loginSelectors: { user: '#username', pass: '#password', submit: '[type="submit"]' },
    postUrl: 'https://archive.org/upload/',
    postType: 'upload_pdf',
    uploadPage: 'https://archive.org/upload/',
    postSelectors: {
      upload: 'input[type="file"]',
      submit: '[type="submit"]',
      successPattern: /archive\.org\/details\//,
    },
  },

  'notion.so': {
    loginUrl: 'https://www.notion.so/login',
    loginSelectors: { user: 'input[name="email"]', pass: 'input[type="password"]', submit: '[type="submit"]' },
    postUrl: 'https://www.notion.so/new',
    postType: 'text',
    postSelectors: {
      title: '[placeholder="Untitled"]',
      body: '[placeholder="Type \'/\' for commands"],[contenteditable="true"]',
      submit: null,
      shareButton: 'button:has-text("Share")',
      publicToggle: '[role="switch"][aria-label*="Share"]',
      successPattern: /notion\.so\//,
    },
  },

  // ── FORUMS / Q&A ──────────────────────────────────────────────────────────

  'click4r.com': {
    loginUrl: 'https://www.click4r.com/login',
    loginSelectors: { user: 'input[name="email"],input[name="username"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://www.click4r.com/posts/create',
    postType: 'text',
    postSelectors: {
      title: 'input[name="title"]',
      body: '.ql-editor,[contenteditable]',
      submit: 'button:has-text("Publish"),[type="submit"]',
      successPattern: /click4r\.com\/posts\//,
    },
  },

  'diigo.com': {
    loginUrl: 'https://www.diigo.com/sign-in',
    loginSelectors: { user: 'input[name="username"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://www.diigo.com/user/add_page',
    postType: 'text',
    postSelectors: {
      body: '#notes',
      submit: '#savebtn',
      successPattern: /diigo\.com/,
    },
  },

  // ── SOCIAL / PROFILE ──────────────────────────────────────────────────────

  'pinterest.com': {
    loginUrl: 'https://www.pinterest.com/login',
    loginSelectors: { user: '#email', pass: '#password', submit: '[data-test-id="log-in-button"]' },
    postUrl: 'https://www.pinterest.com/pin/creation/button',
    postType: 'text',
    postSelectors: {
      title: '[data-test-id="pin-draft-title"]',
      body: '[data-test-id="pin-draft-description"]',
      submit: '[data-test-id="storyboard-creation-nav-done"]',
      successPattern: /pinterest\.com\/pin\//,
    },
  },

  'mix.com': {
    loginUrl: 'https://mix.com/login',
    loginSelectors: { user: 'input[name="email"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://mix.com/submit',
    postType: 'text',
    postSelectors: {
      body: 'input[name="url"]',
      submit: '[type="submit"]',
      successPattern: /mix\.com/,
    },
  },

  // ── PRESS RELEASE ─────────────────────────────────────────────────────────

  'prlog.org': {
    loginUrl: 'https://www.prlog.org/login.html',
    loginSelectors: { user: 'input[name="email"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://www.prlog.org/submit.html',
    postType: 'text',
    postSelectors: {
      title: 'input[name="headline"]',
      body: 'textarea[name="body"]',
      submit: 'input[type="submit"][value*="Submit"]',
      successPattern: /prlog\.org\/\d+/,
    },
  },

  'einpresswire.com': {
    loginUrl: 'https://www.einpresswire.com/login',
    loginSelectors: { user: 'input[name="email"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://www.einpresswire.com/article/add',
    postType: 'html',
    postSelectors: {
      title: 'input[name="headline"]',
      body: 'textarea[name="body"],.mce-content-body,[contenteditable]',
      submit: '[type="submit"][value*="Submit"],[name="submit"]',
      successPattern: /einpresswire\.com\/article\//,
    },
  },

  'openpr.com': {
    loginUrl: 'https://www.openpr.com/login.html',
    loginSelectors: { user: 'input[name="username"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://www.openpr.com/news/submit.html',
    postType: 'text',
    postSelectors: {
      title: 'input[name="headline"]',
      body: 'textarea[name="text"]',
      submit: '[type="submit"]',
      successPattern: /openpr\.com\/news\//,
    },
  },

  // ── ARTICLE DIRECTORIES ───────────────────────────────────────────────────

  'ezinearticles.com': {
    loginUrl: 'https://ezinearticles.com/?Login',
    loginSelectors: { user: 'input[name="email"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://ezinearticles.com/?Submit-Your-Articles',
    postType: 'text',
    postSelectors: {
      title: 'input[name="headline"]',
      body: 'textarea[name="article_body"],.mce_editable',
      submit: '[type="submit"][name="submit"]',
      successPattern: /ezinearticles\.com/,
    },
  },

  'articlebase.com': {
    loginUrl: 'https://www.articlebase.com/login.php',
    loginSelectors: { user: 'input[name="login"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://www.articlebase.com/submit.php',
    postType: 'text',
    postSelectors: {
      title: 'input[name="title"]',
      body: 'textarea[name="body"]',
      submit: '[type="submit"]',
      successPattern: /articlebase\.com/,
    },
  },

  // ── PASTE SITES (additional) ──────────────────────────────────────────────

  'paste.fo': {
    loginUrl: null,
    postUrl: 'https://paste.fo',
    postType: 'text',
    postSelectors: {
      body: 'textarea[name="content"],textarea[id="paste-content"]',
      title: 'input[name="title"]',
      submit: '[type="submit"]',
      successPattern: /paste\.fo\/[a-zA-Z0-9]+/,
    },
    anonymous: true,
  },

  'pastecode.io': {
    loginUrl: null,
    postUrl: 'https://pastecode.io',
    postType: 'text',
    postSelectors: {
      body: 'textarea[name="text"],#editor',
      title: 'input[name="title"]',
      submit: '[type="submit"],button:has-text("Create")',
      successPattern: /pastecode\.io\/[a-zA-Z0-9]+/,
    },
    anonymous: true,
  },

  'ghostbin.co': {
    loginUrl: null,
    postUrl: 'https://ghostbin.co/paste/new',
    postType: 'text',
    postSelectors: {
      body: 'textarea#text,.ace_text-input',
      title: 'input[name="title"]',
      submit: 'button[type="submit"],input[type="submit"]',
      successPattern: /ghostbin\.co\/paste\/[a-zA-Z0-9]+/,
    },
    anonymous: true,
  },

  // ── CODE / DEVELOPER PLATFORMS ───────────────────────────────────────────

  'gist.github.com': {
    loginUrl: 'https://github.com/login',
    loginSelectors: { user: '#login_field', pass: '#password', submit: '[name="commit"]' },
    postUrl: 'https://gist.github.com',
    postType: 'markdown',
    postSelectors: {
      title: 'input[placeholder*="Gist description"]',
      body: '.CodeMirror-code,.cm-content,.ace_editor textarea',
      submit: 'button:has-text("Create public gist")',
      successPattern: /gist\.github\.com\/[^/]+\/[a-f0-9]+/,
    },
    preferApi: true,
  },

  'gitlab.com': {
    loginUrl: 'https://gitlab.com/users/sign_in',
    loginSelectors: { user: '#user_login', pass: '#user_password', submit: '[data-testid="sign-in-button"]' },
    postUrl: 'https://gitlab.com/-/snippets/new',
    postType: 'markdown',
    postSelectors: {
      title: '#snippet_title',
      body: '.CodeMirror-code,.cm-content',
      submit: 'button[type="submit"]:has-text("Create")',
      successPattern: /gitlab\.com\/-\/snippets\/\d+/,
    },
    preferApi: true,
  },

  'codepen.io': {
    loginUrl: 'https://codepen.io/login',
    loginSelectors: { user: '#login-email', pass: '#login-password', submit: '[type="submit"]' },
    postUrl: 'https://codepen.io/pen/',
    postType: 'html',
    postSelectors: {
      title: '#title-field,.pen-name',
      body: '#html-box .CodeMirror-code',
      submit: 'button:has-text("Save")',
      successPattern: /codepen\.io\/[^/]+\/pen\//,
    },
  },

  // ── SOCIAL / BOOKMARKING ─────────────────────────────────────────────────

  'reddit.com': {
    loginUrl: 'https://www.reddit.com/login',
    loginSelectors: { user: '#loginUsername', pass: '#loginPassword', submit: '[type="submit"]' },
    postUrl: 'https://www.reddit.com/submit',
    postType: 'markdown',
    postSelectors: {
      title: 'textarea[name="title"],#post-title',
      body: '.public-DraftEditor-content,[contenteditable]',
      submit: 'button:has-text("Post"),button[type="submit"]:last-of-type',
      successPattern: /reddit\.com\/r\/[^/]+\/comments\//,
    },
    preferApi: true,
  },

  'scoop.it': {
    loginUrl: 'https://www.scoop.it/login',
    loginSelectors: { user: 'input[name="email"],input[type="email"]', pass: 'input[name="password"],input[type="password"]', submit: '[type="submit"]' },
    postUrl: 'https://www.scoop.it/post',
    postType: 'text',
    postSelectors: {
      title: 'input[name="title"]',
      body: 'textarea[name="content"],#post-body',
      submit: 'button:has-text("Publish"),[type="submit"]',
      successPattern: /scoop\.it\/topic\//,
    },
  },

  'folkd.com': {
    loginUrl: 'https://www.folkd.com/user/login',
    loginSelectors: { user: 'input[name="User[login]"]', pass: 'input[name="User[password]"]', submit: '[type="submit"]' },
    postUrl: 'https://www.folkd.com/submit/go',
    postType: 'text',
    postSelectors: {
      title: 'input[name="title"]',
      body: 'textarea[name="description"]',
      submit: '[type="submit"]',
      successPattern: /folkd\.com/,
    },
  },

  'dzone.com': {
    loginUrl: 'https://dzone.com/login',
    loginSelectors: { user: 'input[name="username"],input[name="email"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://dzone.com/articles/new',
    postType: 'markdown',
    postSelectors: {
      title: 'input[name="title"]',
      body: '.CodeMirror-code,.cm-content,[contenteditable]',
      submit: 'button:has-text("Publish"),[type="submit"]',
      successPattern: /dzone\.com\/articles\//,
    },
  },

  'wakelet.com': {
    loginUrl: 'https://wakelet.com/login',
    loginSelectors: { user: 'input[name="email"],input[type="email"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://wakelet.com/create',
    postType: 'text',
    postSelectors: {
      title: 'input[placeholder*="title" i]',
      body: '.ql-editor,[contenteditable]',
      submit: 'button:has-text("Publish"),button:has-text("Save")',
      successPattern: /wakelet\.com\/wake\//,
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  //  NEW SITES (+30) — Playwright profiles for BLP 313→343 expansion
  // ══════════════════════════════════════════════════════════════════════════

  // ── DEV / CODE HOSTING ────────────────────────────────────────────────────

  'replit.com': {
    loginUrl: 'https://replit.com/login',
    loginSelectors: { user: 'input[name="username"],input[type="email"]', pass: 'input[name="password"]', submit: '[data-cy="login-btn"],[type="submit"]' },
    postUrl: 'https://replit.com/new/html',
    postType: 'html',
    postSelectors: {
      body: '.cm-content,[contenteditable="true"]',
      submit: null, // Replit autosaves
      successPattern: /replit\.com\/@[^/]+\//,
    },
    preferApi: true,
  },

  'glitch.com': {
    loginUrl: 'https://glitch.com/signin',
    loginSelectors: { user: 'input[type="email"]', pass: 'input[type="password"]', submit: '[type="submit"]' },
    postUrl: 'https://glitch.com/edit',
    postType: 'html',
    postSelectors: {
      body: '.CodeMirror-scroll,.cm-content',
      successPattern: /glitch\.me/,
    },
    preferApi: true,
  },

  'codesandbox.io': {
    loginUrl: 'https://codesandbox.io/signin',
    loginSelectors: { user: 'input[type="email"]', pass: 'input[type="password"]', submit: '[type="submit"]' },
    postUrl: 'https://codesandbox.io/s/new',
    postType: 'html',
    postSelectors: {
      body: '.cm-content,[contenteditable="true"]',
      successPattern: /codesandbox\.io\/s\//,
    },
    preferApi: true,
  },

  'codeberg.org': {
    loginUrl: 'https://codeberg.org/user/login',
    loginSelectors: { user: '#user_name', pass: '#password', submit: '[type="submit"]' },
    postUrl: 'https://codeberg.org/repo/create',
    postType: 'markdown',
    postSelectors: {
      title: '#repo_name',
      body: 'textarea[name="description"]',
      submit: '[type="submit"]',
      successPattern: /codeberg\.org\/[^/]+\/[^/]+/,
    },
    preferApi: true,
  },

  'neocities.org': {
    loginUrl: 'https://neocities.org/signin',
    loginSelectors: { user: 'input[name="username"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://neocities.org/dashboard',
    postType: 'html',
    postSelectors: {
      successPattern: /neocities\.org/,
    },
    preferApi: true,
  },

  // ── HIGH-DA CONTENT PLATFORMS ─────────────────────────────────────────────

  'producthunt.com': {
    loginUrl: 'https://www.producthunt.com/login',
    loginSelectors: { user: 'input[type="email"]', pass: 'input[type="password"]', submit: '[type="submit"]' },
    postUrl: 'https://www.producthunt.com/posts/new',
    postType: 'text',
    postSelectors: {
      title: 'input[placeholder*="name" i],input[name*="name"]',
      body: 'textarea[placeholder*="tagline" i],textarea[name*="tagline"]',
      submit: '[type="submit"],[data-test="submit-button"]',
      successPattern: /producthunt\.com\/posts\//,
    },
    preferApi: true,
  },

  'sourceforge.net': {
    loginUrl: 'https://sourceforge.net/account/login',
    loginSelectors: { user: 'input[name="username"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://sourceforge.net/register/',
    postType: 'text',
    postSelectors: {
      title: 'input[name="project_name"],input[name="shortname"]',
      body: 'textarea[name="short_description"]',
      submit: '[type="submit"]',
      successPattern: /sourceforge\.net\/projects\//,
    },
    preferApi: true,
  },

  'kaggle.com': {
    loginUrl: 'https://www.kaggle.com/account/login',
    loginSelectors: { user: 'input[name="username"],input[type="email"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://www.kaggle.com/code',
    postType: 'markdown',
    postSelectors: {
      successPattern: /kaggle\.com\/code\//,
    },
    preferApi: true,
  },

  'devpost.com': {
    // devpost has no public REST API for project submission — Playwright only
    loginUrl: 'https://devpost.com/login',
    loginSelectors: { user: 'input[name="user[email]"]', pass: 'input[name="user[password]"]', submit: '[name="commit"],[type="submit"]' },
    postUrl: 'https://devpost.com/software/new',
    postType: 'richtext',
    postSelectors: {
      title: 'input[name="software[name]"],input[placeholder*="project name" i]',
      body: '[contenteditable="true"],.ql-editor,textarea[name*="description"]',
      submit: '[type="submit"][value*="Create"],[data-submit],[type="submit"]',
      successPattern: /devpost\.com\/software\//,
    },
  },

  'paperswithcode.com': {
    loginUrl: 'https://paperswithcode.com/accounts/login/',
    loginSelectors: { user: 'input[name="login"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://paperswithcode.com/paper/arxiv/',
    postType: 'text',
    postSelectors: {
      successPattern: /paperswithcode\.com\/paper\//,
    },
    preferApi: true,
  },

  // ── BLOG / NEWSLETTER ─────────────────────────────────────────────────────

  'micro.blog': {
    loginUrl: 'https://micro.blog/login',
    loginSelectors: { user: 'input[name="email"]', pass: null, submit: '[type="submit"]' },
    postUrl: 'https://micro.blog/new',
    postType: 'markdown',
    postSelectors: {
      body: 'textarea[name="text"],#text',
      submit: '[type="submit"][value*="Post"],[type="submit"]',
      successPattern: /micro\.blog\//,
    },
    preferApi: true,
  },

  'bearblog.dev': {
    loginUrl: 'https://bearblog.dev/login/',
    loginSelectors: { user: 'input[name="email"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://bearblog.dev/dashboard/new/',
    postType: 'markdown',
    postSelectors: {
      title: 'input[name="title"]',
      body: 'textarea[name="content"]',
      submit: '[type="submit"]',
      successPattern: /bearblog\.dev/,
    },
    preferApi: true,
  },

  'mataroa.blog': {
    loginUrl: 'https://mataroa.blog/accounts/login/',
    loginSelectors: { user: 'input[name="username"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://mataroa.blog/blog/create/',
    postType: 'markdown',
    postSelectors: {
      title: 'input[name="title"]',
      body: 'textarea[name="body"]',
      submit: '[type="submit"]',
      successPattern: /mataroa\.blog\/blog\//,
    },
    preferApi: true,
  },

  'buttondown.email': {
    loginUrl: 'https://buttondown.email/login',
    loginSelectors: { user: 'input[type="email"]', pass: 'input[type="password"]', submit: '[type="submit"]' },
    postUrl: 'https://buttondown.email/emails/new',
    postType: 'markdown',
    postSelectors: {
      title: 'input[name="subject"],input[placeholder*="subject" i]',
      body: '.ProseMirror,[contenteditable="true"],textarea',
      submit: 'button:has-text("Send"),button:has-text("Publish"),[type="submit"]',
      successPattern: /buttondown\.email/,
    },
    preferApi: true,
  },

  'typefully.com': {
    loginUrl: 'https://typefully.com/login',
    loginSelectors: { user: 'input[type="email"]', pass: 'input[type="password"]', submit: '[type="submit"]' },
    postUrl: 'https://typefully.com',
    postType: 'text',
    postSelectors: {
      body: '[contenteditable="true"],.ProseMirror',
      submit: 'button:has-text("Schedule"),button:has-text("Publish"),[type="submit"]',
      successPattern: /typefully\.com/,
    },
    preferApi: true,
  },

  'plume.social': {
    loginUrl: 'https://plume.social/login',
    loginSelectors: { user: 'input[name="email_or_name"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://plume.social/new',
    postType: 'markdown',
    postSelectors: {
      title: 'input[name="title"],#title',
      body: 'textarea[name="content"],.editor-content,[contenteditable]',
      submit: 'button:has-text("Publish"),[type="submit"]',
      successPattern: /plume\.social\/@[^/]+\//,
    },
    preferApi: true,
  },

  // ── LINK AGGREGATORS ──────────────────────────────────────────────────────

  'lobste.rs': {
    loginUrl: 'https://lobste.rs/login',
    loginSelectors: { user: 'input[name="username"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://lobste.rs/stories/new',
    postType: 'text',
    postSelectors: {
      title: 'input[name="story[title]"]',
      body: 'textarea[name="story[description]"]',
      submit: '[type="submit"]',
      successPattern: /lobste\.rs\/s\//,
    },
    preferApi: true,
  },

  'lemmy.world': {
    loginUrl: 'https://lemmy.world/login',
    loginSelectors: { user: 'input#login-username,input[name="username"]', pass: 'input#login-password,input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://lemmy.world/create_post',
    postType: 'markdown',
    postSelectors: {
      title: 'input#post-title,input[name="name"]',
      body: 'textarea#post-body,textarea[name="body"]',
      submit: '[type="submit"]',
      successPattern: /lemmy\.world\/post\//,
    },
    preferApi: true,
  },

  'kbin.social': {
    loginUrl: 'https://kbin.social/login',
    loginSelectors: { user: 'input[name="_username"]', pass: 'input[name="_password"]', submit: '[type="submit"]' },
    postUrl: 'https://kbin.social/microblog',
    postType: 'text',
    postSelectors: {
      body: 'textarea[name="body"],[contenteditable]',
      submit: '[type="submit"]',
      successPattern: /kbin\.social/,
    },
    preferApi: true,
  },

  'stacker.news': {
    loginUrl: 'https://stacker.news/login',
    loginSelectors: { user: 'input[type="email"]', pass: null, submit: '[type="submit"]' },
    postUrl: 'https://stacker.news/post',
    postType: 'markdown',
    postSelectors: {
      title: 'input[name="title"]',
      body: 'textarea[name="text"]',
      submit: '[type="submit"]',
      successPattern: /stacker\.news\/items\//,
    },
    preferApi: true,
  },

  // ── SOCIAL / BOOKMARKING ──────────────────────────────────────────────────

  'raindrop.io': {
    loginUrl: 'https://app.raindrop.io/login',
    loginSelectors: { user: 'input[name="email"],input[type="email"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://app.raindrop.io',
    postType: 'text',
    postSelectors: {
      successPattern: /raindrop\.io/,
    },
    preferApi: true,
  },

  'lu.ma': {
    loginUrl: 'https://lu.ma/login',
    loginSelectors: { user: 'input[type="email"]', pass: null, submit: '[type="submit"]' },
    postUrl: 'https://lu.ma/new-event',
    postType: 'text',
    postSelectors: {
      title: 'input[placeholder*="event name" i],input[name="name"]',
      body: '[contenteditable="true"],.ProseMirror',
      submit: 'button:has-text("Create Event"),[type="submit"]',
      successPattern: /lu\.ma\/[a-z0-9-]+/,
    },
    preferApi: true,
  },

  'lottiefiles.com': {
    loginUrl: 'https://lottiefiles.com/login',
    loginSelectors: { user: 'input[type="email"]', pass: 'input[type="password"]', submit: '[type="submit"]' },
    postUrl: 'https://lottiefiles.com/upload',
    postType: 'text',
    postSelectors: {
      successPattern: /lottiefiles\.com/,
    },
    preferApi: true,
  },

  'launchpad.net': {
    loginUrl: 'https://login.launchpad.net/+login',
    loginSelectors: { user: 'input[name="email"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://launchpad.net/projects/+new',
    postType: 'text',
    postSelectors: {
      title: 'input[name="field.name"]',
      body: 'textarea[name="field.summary"]',
      submit: '[type="submit"]',
      successPattern: /launchpad\.net\/[a-z0-9-]+/,
    },
    preferApi: true,
  },

  'sr.ht': {
    loginUrl: 'https://meta.sr.ht/login',
    loginSelectors: { user: 'input[name="username"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://git.sr.ht/create',
    postType: 'markdown',
    postSelectors: {
      title: 'input[name="name"]',
      body: 'textarea[name="description"]',
      submit: '[type="submit"]',
      successPattern: /git\.sr\.ht\/~/,
    },
    preferApi: true,
  },

  // ── OTHER ─────────────────────────────────────────────────────────────────

  'pastery.net': {
    loginUrl: null,
    postUrl: 'https://www.pastery.net',
    postType: 'text',
    postSelectors: {
      title: 'input[name="title"]',
      body: 'textarea[name="content"],#id_content',
      submit: '[type="submit"]',
      successPattern: /pastery\.net\/[a-z0-9]+/,
    },
    anonymous: true,
    preferApi: true,
  },

  'outline.com': {
    loginUrl: 'https://app.getoutline.com',
    loginSelectors: { user: 'input[type="email"]', pass: 'input[type="password"]', submit: '[type="submit"]' },
    postUrl: 'https://app.getoutline.com/doc/new',
    postType: 'markdown',
    postSelectors: {
      title: '[placeholder="Untitled"],[data-slate-placeholder="true"]',
      body: '[contenteditable="true"],.ProseMirror',
      submit: null, // Outline autosaves
      successPattern: /getoutline\.com\/doc\//,
    },
    preferApi: true,
  },

  // wakelet.com profile already exists above — updated with real submitter selectors
  // (the existing entry is kept; no duplicate needed)

  // ── GENERIC FALLBACK ──────────────────────────────────────────────────────
  '__generic__': {
    loginUrl: null,
    postType: 'text',
    strategy: 'form_detect',
    postSelectors: {
      title: 'input[name*="title"],input[placeholder*="title" i],input[name*="headline"]',
      body: 'textarea[name*="content"],textarea[name*="body"],textarea[name*="text"],.ql-editor,[contenteditable="true"]',
      submit: '[type="submit"]:not([value*="Cancel"]):not([value*="Preview"]),button[type="submit"]',
      successPattern: null,
    },
  },
};

/**
 * Returns the profile for a given domain/URL.
 * Falls back to __generic__ if no match found.
 */
function getProfile(urlOrDomain) {
  let domain = urlOrDomain;
  try { domain = new URL(urlOrDomain).hostname.replace(/^www\./, ''); } catch (_) {}
  if (PROFILES[domain]) return { ...PROFILES[domain], _domain: domain };
  for (const key of Object.keys(PROFILES)) {
    if (key === '__generic__') continue;
    if (domain.endsWith(key) || domain.includes(key.split('.')[0])) {
      return { ...PROFILES[key], _domain: key };
    }
  }
  return { ...PROFILES['__generic__'], _domain: domain };
}

/**
 * Given a postType and raw content {title, body, tags, links[]},
 * return content formatted correctly for the platform.
 *
 * KEY FIX: 'text' sites get ALL markup stripped (including markdown syntax)
 *          but URLs are preserved as plain text.
 *          'upload_pdf' sites return {manual: true} — cannot POST a PDF blob.
 *          'html' sites get markdown converted to HTML if body is markdown.
 *          'markdown' sites get HTML stripped to plaintext if body is HTML.
 */
function formatContent(postType, content) {
  const { title = '', body = '', tags = '', links = [] } = content;

  // Build link footer per format
  let linkFooter = '';
  if (links && links.length) {
    if (postType === 'html') {
      linkFooter = '\n<section><h2>Resources</h2><ul>' +
        links.map(l => `<li><a href="${l.url}" target="_blank" rel="noopener">${l.label || l.url}</a></li>`).join('') +
        '</ul></section>';
    } else if (postType === 'markdown') {
      linkFooter = '\n\n## Resources\n\n' + links.map(l => `- [${l.label || l.url}](${l.url})`).join('\n');
    } else {
      linkFooter = '\n\nResources:\n' + links.map(l => `${l.label || l.url}: ${l.url}`).join('\n');
    }
  }

  const isHtml = /<\/?[a-z][\s\S]*>/i.test(body);
  const isMd   = /^#{1,6}\s|\*\*|__|\[.+\]\(.+\)/m.test(body);

  switch (postType) {

    case 'upload_pdf':
    case 'upload_html_pdf':
      // Cannot upload files via REST — signal manual upload required
      return { title, body: '', tags, manual: true,
        note: `${title} — PDF upload required. Download the PDF from the frontend panel and upload manually.` };

    case 'html':
      // Convert markdown body to HTML if needed
      if (isHtml) return { title, body: body + linkFooter, tags };
      if (isMd)   return { title, body: mdToHtml(body) + linkFooter, tags };
      return { title, body: '<p>' + body.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>') + '</p>' + linkFooter, tags };

    case 'markdown':
      // Convert HTML body to plain markdown if needed (strip tags, keep text)
      if (isHtml) return { title, body: toPlainText(body) + linkFooter, tags };
      return { title, body: body + linkFooter, tags };

    case 'text':
      // Strip ALL markup — HTML AND markdown — but preserve URLs as plain text
      if (isHtml) return { title, body: toPlainText(body) + linkFooter, tags };
      if (isMd)   return { title, body: mdToPlain(body) + linkFooter, tags };
      return { title, body: body + linkFooter, tags };

    case 'richtext':
    case 'auto':
    default: {
      // WYSIWYG: plain text only, preserve URLs
      const plain = isHtml ? toPlainText(body) : (isMd ? mdToPlain(body) : body);
      return { title, body: plain + linkFooter, tags };
    }
  }
}

export { PROFILES, getProfile, formatContent, toPlainText, mdToPlain, mdToHtml, slug, isPdfPlatform, PDF_DOMAINS };
