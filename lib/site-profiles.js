/**
 * site-profiles.js
 * Per-platform knowledge base for BLP + Global Blast Playwright post engine.
 * Defines: login flow, post creation selectors, content format, success detection.
 *
 * FORMAT TYPES:
 *  'markdown'  — platform renders Markdown (use raw MD, NO HTML tags)
 *  'html'      — platform accepts raw HTML in editor
 *  'text'      — plain text only (strip all markup)
 *  'richtext'  — WYSIWYG / contenteditable (paste as text, platform handles rendering)
 *  'auto'      — detect at runtime from page content
 */

'use strict';

// ─── SHARED HELPERS ───────────────────────────────────────────────────────────

function slug(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Strip HTML tags → plain text
function toPlainText(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Markdown → plain text (strip markers)
function mdToPlain(md) {
  return (md || '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/>\s*/gm, '')
    .trim();
}

// ─── SITE PROFILE REGISTRY ────────────────────────────────────────────────────

/**
 * Each profile:
 *   loginUrl       — URL to navigate for login
 *   loginSelectors — { user, pass, submit } CSS selectors
 *   postUrl        — URL / function(creds) → URL for creating a post
 *   postType       — 'markdown' | 'html' | 'text' | 'richtext' | 'form' | 'auto'
 *   postSelectors  — { title?, body, tags?, submit, successPattern? }
 *   successPattern — regex or string to detect successful post in final URL or page
 *   needsVerify    — bool: registration needs email verify before posting
 *   notes          — human-readable notes
 */
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
    postType: 'richtext',
    postSelectors: {
      title: 'input[name="title"]',
      body: '.jp-editor [contenteditable]',
      submit: '#save-button,[name="publish"]',
      successPattern: /justpaste\.it\/[A-Za-z0-9]+/,
    },
  },

  'rentry.co': {
    loginUrl: null, // anonymous
    postUrl: 'https://rentry.co',
    postType: 'markdown',
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
      submit: null, // uses Ctrl+S keyboard shortcut
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
    loginSelectors: null, // OAuth-only; handled via API token
    postUrl: 'https://medium.com/new-story',
    postType: 'richtext',
    postSelectors: {
      title: 'h3[data-testid="title"] [data-placeholder]',
      body: '[data-slate-editor] p',
      submit: '[data-testid="publish-button"]',
      successPattern: /medium\.com\/@[^/]+\//,
    },
    preferApi: true, // use API first; Playwright as fallback
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
    postType: 'richtext',
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
    postType: 'richtext',
    postSelectors: {
      title: '.editor-post-title__input',
      body: '.block-editor-rich-text__editable[aria-label="Add text or type"],.editor-blocks-keyboard-shortcut-help__shortcut-list',
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
    postType: 'richtext',
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
    postType: 'richtext',
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
    postType: 'richtext',
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
    postType: 'richtext',
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
    postType: 'richtext',
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
    postType: 'richtext',
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
    postUrl: null, // Weebly is a site builder; post creation requires navigating to blog panel
    postType: 'richtext',
    autoNav: true,
    navFlow: ['go_to_sites', 'open_blog', 'new_post'],
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
    postType: 'richtext',
    autoNav: true,
    navFlow: ['go_to_dashboard', 'open_site', 'blog_new_post'],
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
    postType: 'richtext',
    autoNav: true,
    navFlow: ['open_blog_manager', 'new_post'],
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
    postType: 'richtext',
    autoNav: true,
    navFlow: ['go_to_site', 'add_blog_entry'],
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
    postType: 'richtext',
    autoNav: true,
    navFlow: ['go_to_site', 'edit_page'],
    postSelectors: {
      body: '[contenteditable="true"]',
      submit: 'button:has-text("Save")',
      successPattern: /webnode\.com/,
    },
  },

  'telegra.ph': {
    loginUrl: null,
    postUrl: 'https://telegra.ph',
    postType: 'richtext',
    anonymous: true,
    postSelectors: {
      title: 'h1[contenteditable],input.title_input',
      body: 'p[contenteditable],article [contenteditable]',
      submit: 'button.publish_button',
      successPattern: /telegra\.ph\/[A-Za-z0-9-]+/,
    },
  },

  // ── DOCUMENT / SLIDE ──────────────────────────────────────────────────────

  'scribd.com': {
    loginUrl: 'https://www.scribd.com/login',
    loginSelectors: { user: 'input[name="email"]', pass: 'input[name="password"]', submit: '[type="submit"]' },
    postUrl: 'https://www.scribd.com/upload-document',
    postType: 'upload_html_pdf', // generates PDF and uploads
    postSelectors: {
      upload: 'input[type="file"]',
      submit: '[type="submit"]',
      successPattern: /scribd\.com\/document\//,
    },
  },

  'issuu.com': {
    loginUrl: 'https://issuu.com/login',
    loginSelectors: { user: 'input[type="email"]', pass: 'input[type="password"]', submit: '[type="submit"]' },
    postUrl: 'https://issuu.com/home/drafts',
    postType: 'upload_pdf',
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
    postSelectors: {
      upload: 'input[type="file"]',
      submit: '#btn-upload,[type="submit"]',
      successPattern: /slideshare\.net\/[^/]+\//,
    },
  },

  'notion.so': {
    loginUrl: 'https://www.notion.so/login',
    loginSelectors: { user: 'input[name="email"]', pass: 'input[type="password"]', submit: '[type="submit"]' },
    postUrl: 'https://www.notion.so/new',
    postType: 'richtext',
    postSelectors: {
      title: '[placeholder="Untitled"]',
      body: '[placeholder="Type \'/\' for commands"],[contenteditable="true"]',
      submit: null, // notion auto-saves; make public via Share > toggle
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
    postType: 'richtext',
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

  // ── GENERIC FALLBACK (used when no specific profile matches) ──────────────
  '__generic__': {
    loginUrl: null,
    postType: 'auto',
    strategy: 'form_detect', // auto-detect all forms
    postSelectors: {
      title: 'input[name*="title"],input[placeholder*="title" i],input[name*="headline"]',
      body: 'textarea[name*="content"],textarea[name*="body"],textarea[name*="text"],.ql-editor,[contenteditable="true"]',
      submit: '[type="submit"]:not([value*="Cancel"]):not([value*="Preview"]),button[type="submit"]',
      successPattern: null, // accept any URL change
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

  // Exact match
  if (PROFILES[domain]) return { ...PROFILES[domain], _domain: domain };

  // Partial match (e.g. "substack.com" matches "open.substack.com")
  for (const key of Object.keys(PROFILES)) {
    if (key === '__generic__') continue;
    if (domain.endsWith(key) || domain.includes(key.split('.')[0])) {
      return { ...PROFILES[key], _domain: key };
    }
  }

  return { ...PROFILES['__generic__'], _domain: domain };
}

/**
 * Given a postType and raw content object {title, body, tags},
 * return the content formatted for the target platform.
 */
function formatContent(postType, content) {
  const { title = '', body = '', tags = '', links = [] } = content;

  // Append links as footer
  let linkFooter = '';
  if (links && links.length) {
    if (postType === 'html') {
      linkFooter = '\n<section><h2>Resources</h2><ul>' + links.map(l => `<li><a href="${l.url}" target="_blank" rel="noopener">${l.label || l.url}</a></li>`).join('') + '</ul></section>';
    } else if (postType === 'markdown') {
      linkFooter = '\n\n## Resources\n\n' + links.map(l => `- [${l.label || l.url}](${l.url})`).join('\n');
    } else {
      linkFooter = '\n\nResources:\n' + links.map(l => `${l.label || l.url}: ${l.url}`).join('\n');
    }
  }

  switch (postType) {
    case 'html':
      return { title, body: body + linkFooter, tags };

    case 'markdown':
      // If body appears to be HTML, convert to markdown
      if (/<\/?[a-z][\s\S]*>/i.test(body)) {
        return { title, body: toPlainText(body) + linkFooter, tags };
      }
      return { title, body: body + linkFooter, tags };

    case 'text':
      // Strip ALL markup
      if (/<\/?[a-z][\s\S]*>/i.test(body)) return { title, body: toPlainText(body) + linkFooter, tags };
      if (/^#{1,6}\s/m.test(body)) return { title, body: mdToPlain(body) + linkFooter, tags };
      return { title, body: body + linkFooter, tags };

    case 'richtext':
    case 'auto':
    default:
      // WYSIWYG: send as plain text (browser will handle rich display)
      const plain = /<\/?[a-z][\s\S]*>/i.test(body) ? toPlainText(body) : body;
      return { title, body: plain + linkFooter, tags };
  }
}

module.exports = { PROFILES, getProfile, formatContent, toPlainText, mdToPlain, slug };
