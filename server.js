const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const BOARD_PATH = '/chiko/';
const BOARD_TITLE = 'ChikoChan';
const BOARD_DESCRIPTION = 'Welcome to ChikoChan, (off topic) Talk about any! ,no nsfw';

const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'posts.json');
const HTML_FILE = path.join(__dirname, 'index.html');
const CATALOG_FILE = path.join(__dirname, 'catalog.html');
const CLIENT_FILE = path.join(__dirname, 'client.js');
const UPLOAD_DIR = path.join(DATA_DIR, 'src');
const FAVICON_FILE = path.join(__dirname, 'chikki.ico');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_NAME_LENGTH = 80;
const MAX_TITLE_LENGTH = 120;
const MAX_COMMENT_LENGTH = 4000;
const MAX_REPLIES_PER_THREAD = 500;
const DUPLICATE_REPLY_LOOKBACK = 20;
const POST_RATE_WINDOW_MS = Number(process.env.POST_RATE_WINDOW_MS) || 60 * 1000;
const POST_RATE_LIMIT = Number(process.env.POST_RATE_LIMIT) || 5;
const POST_RATE_BUCKET_MAX = 1000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || ADMIN_PASSWORD;
const ADMIN_COOKIE_NAME = 'chikochan_admin';
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const ADMIN_LOGIN_WINDOW_MS = 5 * 60 * 1000;
const ADMIN_LOGIN_LIMIT = 5;
const ALLOWED_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const UPLOAD_FILE_PATTERN = /^\d+-(?:\d+|[a-f0-9]{16})\.(?:jpe?g|png|gif|webp)$/i;
const postRateBuckets = new Map();
const adminLoginBuckets = new Map();

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ lastId: 0, threads: [] }, null, 2), 'utf8');
}

app.disable('x-powered-by');

if (process.env.TRUST_PROXY) {
  app.set('trust proxy', process.env.TRUST_PROXY);
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'"
  ].join('; '));
  next();
});

app.use(express.urlencoded({ extended: true, limit: '16kb', parameterLimit: 20 }));
app.get('/style.css', (req, res) => {
  res.type('text/css');
  res.sendFile(path.join(__dirname, 'style.css'));
});

app.get('/client.js', (req, res) => {
  res.type('application/javascript');
  res.sendFile(CLIENT_FILE);
});

app.get('/chikki.ico', (req, res) => {
  res.sendFile(FAVICON_FILE);
});

app.get('/src/:filename', (req, res) => {
  const filename = String(req.params.filename || '');

  if (!UPLOAD_FILE_PATTERN.test(filename)) {
    res.status(404).send('Not found');
    return;
  }

  const filePath = path.join(UPLOAD_DIR, filename);
  const imageType = detectImageFile(filePath);

  if (!imageType) {
    res.status(404).send('Not found');
    return;
  }

  res.type(imageType.mime);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(filePath);
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeExt = ALLOWED_IMAGE_EXTS.has(ext) ? ext : '.img';
    const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
    cb(null, `${uniqueSuffix}${safeExt}`);
  }
});

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();

  if (ALLOWED_IMAGE_EXTS.has(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only standard image files are allowed: .jpg, .jpeg, .png, .gif, .webp'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_IMAGE_BYTES,
    files: 1,
    fields: 10,
    fieldNameSize: 40,
    fieldSize: MAX_COMMENT_LENGTH + 1024,
    parts: 12
  }
});

function getClientKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function pruneRateBuckets(now) {
  if (postRateBuckets.size <= POST_RATE_BUCKET_MAX) return;

  for (const [key, bucket] of postRateBuckets) {
    if (now - bucket.windowStart > POST_RATE_WINDOW_MS) {
      postRateBuckets.delete(key);
    }
  }
}

function postRateLimit(req, res, next) {
  const now = Date.now();
  const key = getClientKey(req);
  const current = postRateBuckets.get(key);
  const bucket = current && now - current.windowStart < POST_RATE_WINDOW_MS
    ? current
    : { windowStart: now, count: 0 };

  if (bucket.count >= POST_RATE_LIMIT) {
    const err = new Error('Too many posts from this address. Wait a minute and try again.');
    err.status = 429;
    next(err);
    return;
  }

  bucket.count += 1;
  postRateBuckets.set(key, bucket);
  pruneRateBuckets(now);
  next();
}

function safeUnlink(filePath) {
  if (!filePath) return;

  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`Could not remove upload ${filePath}: ${err.message}`);
    }
  }
}

function removeUploadedFile(req) {
  if (req.file?.path) {
    safeUnlink(req.file.path);
  }
}

function imageTypeFromBuffer(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', extensions: ['.jpg', '.jpeg'] };
  }

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mime: 'image/png', extensions: ['.png'] };
  }

  const header = buffer.toString('ascii', 0, Math.min(buffer.length, 12));

  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
    return { mime: 'image/gif', extensions: ['.gif'] };
  }

  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') {
    return { mime: 'image/webp', extensions: ['.webp'] };
  }

  return null;
}

function detectImageFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    return imageTypeFromBuffer(buffer.subarray(0, bytesRead));
  } catch (err) {
    return null;
  }
}

function validateUploadedImage(file) {
  if (!file) return;

  const ext = path.extname(file.originalname).toLowerCase();
  const imageType = detectImageFile(file.path);

  if (!imageType || !imageType.extensions.includes(ext)) {
    safeUnlink(file.path);
    throw new Error('Uploaded file contents do not match a standard image type.');
  }
}

function readField(body, name, fallback, maxLength, label) {
  const text = cleanText(body[name], fallback);

  if (text.length > maxLength) {
    throw new Error(`${label} is too long. Maximum is ${maxLength} characters.`);
  }

  return text;
}

function assertHoneypotEmpty(body) {
  if (String(body.website || '').trim()) {
    throw new Error('Post rejected.');
  }
}

function normalizeForSpam(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function assertNotDuplicateReply(thread, comment) {
  const normalized = normalizeForSpam(comment);
  if (normalized.length < 8) return;

  const replies = Array.isArray(thread.replies) ? thread.replies : [];
  const duplicateCount = replies
    .slice(-DUPLICATE_REPLY_LOOKBACK)
    .filter(reply => normalizeForSpam(reply.comment) === normalized)
    .length;

  if (duplicateCount >= 2) {
    throw new Error('Duplicate reply detected. Please do not post the same message repeatedly.');
  }
}

function isAdminConfigured() {
  return Boolean(ADMIN_PASSWORD && ADMIN_SESSION_SECRET);
}

function timingSafeEqualStrings(a, b) {
  const aBuffer = Buffer.from(String(a || ''));
  const bBuffer = Buffer.from(String(b || ''));

  if (aBuffer.length !== bBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};

  header.split(';').forEach(part => {
    const index = part.indexOf('=');
    if (index === -1) return;

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) return;

    try {
      cookies[key] = decodeURIComponent(value);
    } catch (err) {
      cookies[key] = '';
    }
  });

  return cookies;
}

function signAdminValue(value) {
  return crypto
    .createHmac('sha256', ADMIN_SESSION_SECRET)
    .update(value)
    .digest('base64url');
}

function createAdminSessionToken() {
  const payload = {
    exp: Date.now() + ADMIN_SESSION_TTL_MS,
    nonce: crypto.randomBytes(18).toString('base64url')
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${signAdminValue(encoded)}`;
}

function readAdminSession(req) {
  if (!isAdminConfigured()) return null;

  const token = parseCookies(req)[ADMIN_COOKIE_NAME];
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [encoded, signature] = parts;
  if (!timingSafeEqualStrings(signAdminValue(encoded), signature)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > Number(payload.exp)) {
      return null;
    }

    if (!payload.nonce) {
      return null;
    }

    return payload;
  } catch (err) {
    return null;
  }
}

function adminCsrfToken(session) {
  return crypto
    .createHmac('sha256', ADMIN_SESSION_SECRET)
    .update(`csrf:${session.nonce}`)
    .digest('base64url');
}

function isSecureRequest(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production';
}

function setAdminCookie(req, res, token) {
  const parts = [
    `${ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/admin',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}`
  ];

  if (isSecureRequest(req)) {
    parts.push('Secure');
  }

  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearAdminCookie(req, res) {
  const parts = [
    `${ADMIN_COOKIE_NAME}=`,
    'Path=/admin',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0'
  ];

  if (isSecureRequest(req)) {
    parts.push('Secure');
  }

  res.setHeader('Set-Cookie', parts.join('; '));
}

function requireAdmin(req, res, next) {
  if (!isAdminConfigured()) {
    res.status(404).send('Not found');
    return;
  }

  const session = readAdminSession(req);
  if (!session) {
    res.redirect('/admin/login');
    return;
  }

  req.adminSession = session;
  res.setHeader('Cache-Control', 'no-store');
  next();
}

function requireAdminCsrf(req) {
  const expected = adminCsrfToken(req.adminSession);
  const provided = String(req.body.csrf || '');

  if (!timingSafeEqualStrings(expected, provided)) {
    const err = new Error('Invalid admin form token.');
    err.status = 403;
    throw err;
  }
}

function checkAdminLoginRate(req) {
  const now = Date.now();
  const key = getClientKey(req);
  const current = adminLoginBuckets.get(key);
  const bucket = current && now - current.windowStart < ADMIN_LOGIN_WINDOW_MS
    ? current
    : { windowStart: now, count: 0 };

  if (bucket.count >= ADMIN_LOGIN_LIMIT) {
    const err = new Error('Too many admin login attempts. Try again later.');
    err.status = 429;
    throw err;
  }

  bucket.count += 1;
  adminLoginBuckets.set(key, bucket);
}

function clearAdminLoginRate(req) {
  adminLoginBuckets.delete(getClientKey(req));
}

function uploadPathFromPost(post) {
  const image = String(post?.image || '');
  if (!image.startsWith('src/')) return null;

  const filename = image.slice('src/'.length);
  if (!UPLOAD_FILE_PATTERN.test(filename)) return null;

  return path.join(UPLOAD_DIR, filename);
}

function deletePostUpload(post) {
  const filePath = uploadPathFromPost(post);
  if (filePath) {
    safeUnlink(filePath);
  }
}

function recalculateThreadBump(thread) {
  const replyTimes = Array.isArray(thread.replies)
    ? thread.replies.map(reply => Number(reply.createdAt) || 0)
    : [];
  thread.bumpedAt = Math.max(Number(thread.createdAt) || Date.now(), ...replyTimes);
}

function loadPosts() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    return {
      lastId: Number(parsed.lastId) || 0,
      threads: Array.isArray(parsed.threads) ? parsed.threads : []
    };
  } catch (err) {
    return { lastId: 0, threads: [] };
  }
}

function savePosts(data) {
  const tempFile = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempFile, DATA_FILE);
}

function cleanText(value, fallback = '') {
  const text = String(value || '').replace(/\0/g, '').trim();
  return text || fallback;
}

function escapeHTML(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatComment(comment, threadId = null) {
  if (!comment) return '';

  const escaped = escapeHTML(comment).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const quoteBase = threadId ? `/thread/${threadId}` : '';

  return escaped
    .split('\n')
    .map(line => {
      const linkedLine = line.replace(/&gt;&gt;(\d+)/g, `<a class="quotelink" href="${quoteBase}#p$1">&gt;&gt;$1</a>`);

      if (line.trim().startsWith('&gt;')) {
        return `<span class="greentext">${linkedLine}</span>`;
      }

      return linkedLine;
    })
    .join('<br>');
}

function formatDate(timestamp) {
  const pad = n => String(n).padStart(2, '0');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const d = new Date(Number(timestamp) || Date.now());
  const yy = String(d.getFullYear()).slice(-2);
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const day = days[d.getDay()];
  const hh = pad(d.getHours());
  const min = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return `${yy}/${mm}/${dd}(${day})${hh}:${min}:${ss}`;
}

function formatBytes(bytes) {
  const size = Number(bytes) || 0;
  if (size === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(size) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((size / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function getSortedThreads() {
  const data = loadPosts();
  return [...data.threads].sort((a, b) => {
    const aTime = Number(a.bumpedAt || a.createdAt || 0);
    const bTime = Number(b.bumpedAt || b.createdAt || 0);
    return bTime - aTime;
  });
}

function getBoardStats(threads) {
  const totalReplies = threads.reduce((sum, thread) => {
    return sum + (Array.isArray(thread.replies) ? thread.replies.length : 0);
  }, 0);

  const threadCount = threads.length;

  return {
    threadCount,
    totalReplies,
    line: `${threadCount} thread${threadCount === 1 ? '' : 's'} · ${totalReplies} repl${totalReplies === 1 ? 'y' : 'ies'}`
  };
}

function previewText(text, maxLength = 150) {
  const cleaned = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return 'No comment.';
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength).trim()}...`;
}

function boardNavHTML(statsLine, activePage = 'board') {
  const boardLabel = escapeHTML(BOARD_PATH);
  const boardLink = activePage === 'board' ? `<strong>${boardLabel}</strong>` : `<a href="/">${boardLabel}</a>`;
  const catalogLink = activePage === 'catalog' ? '<strong>catalog</strong>' : '<a href="/catalog">catalog</a>';
  const threadLink = activePage === 'thread' ? ' / <strong>thread</strong>' : '';

  return `
  <nav class="board-list" aria-label="board navigation">
    <span class="board-index">[ ${boardLink} / ${catalogLink} / <a href="/#post-form">post</a>${threadLink} ] [ <span>${escapeHTML(statsLine)}</span> ]</span>
    <a class="home-link" href="/">[Home]</a>
  </nav>`;
}

function boardHeaderHTML() {
  return `
  <header>
    <h1>${escapeHTML(BOARD_PATH)} - ${escapeHTML(BOARD_TITLE)}</h1>
    <p>${escapeHTML(BOARD_DESCRIPTION)}</p>
  </header>`;
}

function imageHTML(post, isReply = false) {
  if (!post.image) return '';

  const imagePath = escapeHTML(post.image);
  const fileName = escapeHTML(post.imageName || 'image');
  const fileSize = escapeHTML(post.imageSize || 'unknown size');

  return `
    <div class="file-info">File: <a href="/${imagePath}" target="_blank">${fileName}</a> (${fileSize})</div>
    <div class="image-box${isReply ? ' image-box-reply' : ''}">
      <a href="/${imagePath}" target="_blank">
        <img class="post-img" src="/${imagePath}" alt="attached image">
      </a>
    </div>
  `;
}

function replyHTML(reply, threadId) {
  const replyName = escapeHTML(cleanText(reply.name, 'Anonymous'));
  const replyDate = formatDate(reply.createdAt);
  const replyComment = formatComment(reply.comment, threadId);
  const threadPath = `/thread/${threadId}`;

  return `
    <div class="reply-container" id="p${reply.id}">
      <span class="reply-side-prefix">&gt;&gt;</span>
      <div class="reply">
        <div class="reply-header">
          <span class="name">${replyName}</span>
          <span class="date-time">${replyDate}</span>
          <a class="post-id-link" href="${threadPath}#p${reply.id}">No.${reply.id}</a>
          <a class="quote-reply-link" href="${threadPath}?quote=${reply.id}#reply-form-${threadId}" data-thread-id="${threadId}" data-quote-id="${reply.id}">Reply</a>
        </div>
        ${imageHTML(reply, true)}
        <blockquote class="comment">${replyComment}</blockquote>
      </div>
    </div>
  `;
}

function replyFormHTML(threadId, replyCount, options = {}) {
  const openAttribute = options.open ? ' open' : '';
  const redirectTo = escapeHTML(options.redirectTo || `/thread/${threadId}`);

  return `
    <details class="reply-form-container" id="reply-form-${threadId}"${openAttribute}>
      <summary>Reply${replyCount ? ` (${replyCount})` : ''}</summary>
      <form action="/reply" method="POST" enctype="multipart/form-data">
        <input type="hidden" name="threadId" value="${threadId}">
        <input type="hidden" name="redirectTo" value="${redirectTo}">
        <input class="honeypot-field" type="text" name="website" autocomplete="off" tabindex="-1" aria-hidden="true">
        <table class="reply-form-table">
          <tbody>
            <tr>
              <td class="label"><label for="reply-name-${threadId}">Name</label></td>
              <td><input type="text" id="reply-name-${threadId}" name="name" placeholder="Anonymous"></td>
            </tr>
            <tr>
              <td class="label"><label for="reply-comment-${threadId}">Comment</label></td>
              <td><textarea id="reply-comment-${threadId}" name="comment" required placeholder="Write a reply..."></textarea></td>
            </tr>
            <tr>
              <td class="label"><label for="reply-image-${threadId}">File</label></td>
              <td><input type="file" id="reply-image-${threadId}" name="image"></td>
            </tr>
            <tr>
              <td class="label"></td>
              <td><input type="submit" value="Post reply"></td>
            </tr>
          </tbody>
        </table>
      </form>
    </details>
  `;
}

function threadHTML(thread, options = {}) {
  const replies = Array.isArray(thread.replies) ? thread.replies : [];
  const subject = escapeHTML(cleanText(thread.title));
  const name = escapeHTML(cleanText(thread.name, 'Anonymous'));
  const created = formatDate(thread.createdAt);
  const comment = formatComment(thread.comment, thread.id);
  const threadPath = `/thread/${thread.id}`;
  const shownReplies = options.previewReplies ? replies.slice(-options.previewReplies) : replies;
  const hiddenReplyCount = replies.length - shownReplies.length;

  return `
    <article class="thread" id="thread-${thread.id}">
      <div class="thread-header" id="p${thread.id}">
        ${subject ? `<a class="subject" href="${threadPath}">${subject}</a>` : ''}
        <span class="name">${name}</span>
        <span class="date-time">${created}</span>
        <a class="post-id-link" href="${threadPath}#p${thread.id}">No.${thread.id}</a>
        <a class="quote-reply-link" href="${threadPath}?quote=${thread.id}#reply-form-${thread.id}" data-thread-id="${thread.id}" data-quote-id="${thread.id}">Reply</a>
        <a class="thread-view-link" href="${threadPath}">View thread</a>
      </div>
      ${imageHTML(thread)}
      <blockquote class="comment op-comment">${comment}</blockquote>

      ${hiddenReplyCount > 0 ? `<p class="omitted-replies">${hiddenReplyCount} repl${hiddenReplyCount === 1 ? 'y' : 'ies'} omitted. <a href="${threadPath}">Click here</a> to view.</p>` : ''}
      ${shownReplies.length ? `<div class="replies">${shownReplies.map(reply => replyHTML(reply, thread.id)).join('')}</div>` : ''}
      ${replyFormHTML(thread.id, replies.length, { open: options.replyFormOpen, redirectTo: threadPath })}
    </article>
    <hr>
  `;
}

function newThreadFormHTML() {
  return `
  <div class="post-form-wrapper">
    <form id="post-form" action="/post" method="POST" enctype="multipart/form-data">
      <input class="honeypot-field" type="text" name="website" autocomplete="off" tabindex="-1" aria-hidden="true">
      <table class="post-form-table">
        <tbody>
          <tr>
            <td class="label"><label for="name">Name</label></td>
            <td><input type="text" id="name" name="name" placeholder="Anonymous"></td>
          </tr>
          <tr>
            <td class="label"><label for="title">Subject</label></td>
            <td>
              <input type="text" id="title" name="title" placeholder="optional">
              <input type="submit" value="Post">
            </td>
          </tr>
          <tr>
            <td class="label"><label for="comment">Comment</label></td>
            <td><textarea id="comment" name="comment" required placeholder="Write something..."></textarea></td>
          </tr>
          <tr>
            <td class="label"><label for="image">File</label></td>
            <td>
              <input type="file" id="image" name="image" required>
              <span class="field-hint">JPG, PNG, GIF, WEBP. Max 5 MB.</span>
            </td>
          </tr>
        </tbody>
      </table>
    </form>
  </div>`;
}

function quoteScriptHTML() {
  return `
  <script src="/client.js" defer></script>`;
}

function pageShell(title, activePage, statsLine, bodyHTML, options = {}) {
  const bodyAttributes = options.threadId ? ` data-thread-id="${escapeHTML(options.threadId)}"` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHTML(title)}</title>
  <link rel="icon" href="/chikki.ico" type="image/x-icon">
  <link rel="stylesheet" href="/style.css">
</head>
<body${bodyAttributes}>
  ${boardNavHTML(statsLine, activePage)}
  ${boardHeaderHTML()}
  ${bodyHTML}
  ${quoteScriptHTML()}
</body>
</html>`;
}

function generateHTML() {
  const sortedThreads = getSortedThreads();
  const stats = getBoardStats(sortedThreads);

  const threadsHTML = sortedThreads.map(thread => threadHTML(thread, { previewReplies: 3 })).join('') || `
    <div class="empty-state">
      <p>No threads yet.</p>
      <p>Start the first one above — it needs a comment and an image.</p>
    </div>
    <hr>
  `;

  const fullHTML = pageShell(
    BOARD_TITLE,
    'board',
    stats.line,
    `${newThreadFormHTML()}

  <main class="threads-container">
    ${threadsHTML}
  </main>`
  );

  fs.writeFileSync(HTML_FILE, fullHTML, 'utf8');
}

function catalogItemHTML(thread) {
  const replies = Array.isArray(thread.replies) ? thread.replies : [];
  const subject = escapeHTML(cleanText(thread.title, 'No subject'));
  const name = escapeHTML(cleanText(thread.name, 'Anonymous'));
  const created = formatDate(thread.createdAt);
  const comment = escapeHTML(previewText(thread.comment));
  const replyCount = replies.length;
  const imagePath = thread.image ? escapeHTML(thread.image) : '';
  const imageName = escapeHTML(thread.imageName || 'attached image');
  const threadPath = `/thread/${thread.id}`;

  return `
    <article class="catalog-card">
      <a class="catalog-thumb-link" href="${threadPath}" title="Open thread No.${thread.id}">
        ${imagePath ? `<img class="catalog-thumb" src="/${imagePath}" alt="${imageName}">` : '<span class="catalog-no-thumb">no image</span>'}
      </a>
      <div class="catalog-card-meta">
        <a class="catalog-post-id" href="${threadPath}">No.${thread.id}</a>
        <span>${replyCount} repl${replyCount === 1 ? 'y' : 'ies'}</span>
      </div>
      <a class="catalog-subject" href="${threadPath}">${subject}</a>
      <div class="catalog-name">${name}</div>
      <div class="catalog-date">${created}</div>
      <p class="catalog-preview"><a href="${threadPath}">${comment}</a></p>
    </article>
  `;
}

function generateCatalogHTML() {
  const sortedThreads = getSortedThreads();
  const stats = getBoardStats(sortedThreads);

  const catalogHTML = sortedThreads.length ? `
    <div class="catalog-grid">
      ${sortedThreads.map(catalogItemHTML).join('')}
    </div>
  ` : `
    <div class="empty-state">
      <p>No threads in the catalog yet.</p>
      <p>Go back to the board and start the first thread.</p>
    </div>
  `;

  const fullHTML = pageShell(
    `Catalog - ${BOARD_TITLE}`,
    'catalog',
    stats.line,
    `<main class="catalog-container">
    <div class="catalog-header-row">
      <h2>Catalog</h2>
      <span>${escapeHTML(stats.line)}</span>
    </div>
    ${catalogHTML}
  </main>`
  );

  fs.writeFileSync(CATALOG_FILE, fullHTML, 'utf8');
  return fullHTML;
}

function generateThreadPageHTML(threadId) {
  const sortedThreads = getSortedThreads();
  const stats = getBoardStats(sortedThreads);
  const thread = sortedThreads.find(item => item.id === threadId);

  if (!thread) {
    return null;
  }

  const subject = cleanText(thread.title, `Thread No.${thread.id}`);
  return pageShell(
    `${subject} - ${BOARD_TITLE}`,
    'thread',
    stats.line,
    `<main class="threads-container single-thread-page">
      <div class="thread-page-actions">[ <a href="/">Return</a> ] [ <a href="/catalog">Catalog</a> ]</div>
      ${threadHTML(thread, { replyFormOpen: true })}
    </main>`,
    { threadId: thread.id }
  );
}

function adminShell(title, bodyHTML) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHTML(title)}</title>
  <link rel="icon" href="/chikki.ico" type="image/x-icon">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <main class="admin-page">
    ${bodyHTML}
  </main>
</body>
</html>`;
}

function adminLoginHTML(errorMessage = '') {
  return adminShell(`Admin - ${BOARD_TITLE}`, `
    <section class="admin-panel admin-login-panel">
      <h1>Admin</h1>
      ${errorMessage ? `<p class="admin-error">${escapeHTML(errorMessage)}</p>` : ''}
      <form action="/admin/login" method="POST">
        <label for="admin-password">Password</label>
        <input type="password" id="admin-password" name="password" autocomplete="current-password" autofocus required>
        <button type="submit">Log in</button>
      </form>
      <p class="admin-muted">[ <a href="/">Return to board</a> ]</p>
    </section>
  `);
}

function csrfField(csrfToken) {
  return `<input type="hidden" name="csrf" value="${escapeHTML(csrfToken)}">`;
}

function adminPostSummary(post) {
  const name = escapeHTML(cleanText(post.name, 'Anonymous'));
  const title = escapeHTML(cleanText(post.title));
  const comment = escapeHTML(previewText(post.comment, 220));
  const imageName = post.imageName ? `<span>File: ${escapeHTML(post.imageName)}</span>` : '';

  return `
    <div class="admin-post-summary">
      <div>
        ${title ? `<strong>${title}</strong>` : '<strong>No subject</strong>'}
        <span class="admin-muted">by ${name} · ${formatDate(post.createdAt)}</span>
      </div>
      <p>${comment}</p>
      ${imageName}
    </div>
  `;
}

function adminReplyHTML(reply, threadId, csrfToken) {
  const name = escapeHTML(cleanText(reply.name, 'Anonymous'));
  const comment = escapeHTML(previewText(reply.comment, 180));

  return `
    <li class="admin-reply">
      <div>
        <strong>No.${reply.id}</strong>
        <span class="admin-muted">by ${name} · ${formatDate(reply.createdAt)}</span>
        <p>${comment}</p>
      </div>
      <form action="/admin/delete-reply" method="POST" class="admin-action-form">
        ${csrfField(csrfToken)}
        <input type="hidden" name="threadId" value="${threadId}">
        <input type="hidden" name="replyId" value="${reply.id}">
        <button type="submit" class="danger-button">Delete reply</button>
      </form>
    </li>
  `;
}

function adminThreadHTML(thread, csrfToken) {
  const replies = Array.isArray(thread.replies) ? thread.replies : [];

  return `
    <article class="admin-thread">
      <div class="admin-thread-header">
        <div>
          <h2>No.${thread.id}</h2>
          <span class="admin-muted">${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}</span>
        </div>
        <form action="/admin/delete-thread" method="POST" class="admin-action-form admin-delete-thread-form">
          ${csrfField(csrfToken)}
          <input type="hidden" name="threadId" value="${thread.id}">
          <label><input type="checkbox" name="confirm" value="yes" required> confirm</label>
          <button type="submit" class="danger-button">Delete thread</button>
        </form>
      </div>
      ${adminPostSummary(thread)}
      ${replies.length ? `<ol class="admin-reply-list">${replies.map(reply => adminReplyHTML(reply, thread.id, csrfToken)).join('')}</ol>` : '<p class="admin-muted">No replies.</p>'}
    </article>
  `;
}

function adminDashboardHTML(session) {
  const threads = getSortedThreads();
  const stats = getBoardStats(threads);
  const csrfToken = adminCsrfToken(session);

  return adminShell(`Admin - ${BOARD_TITLE}`, `
    <section class="admin-panel">
      <div class="admin-toolbar">
        <div>
          <h1>Admin</h1>
          <p>${escapeHTML(stats.line)}</p>
        </div>
        <div class="admin-toolbar-actions">
          <a href="/">Board</a>
          <form action="/admin/logout" method="POST">
            ${csrfField(csrfToken)}
            <button type="submit">Log out</button>
          </form>
        </div>
      </div>
      ${threads.length ? threads.map(thread => adminThreadHTML(thread, csrfToken)).join('') : '<p class="admin-muted">No threads.</p>'}
    </section>
  `);
}

app.get('/admin/login', (req, res) => {
  if (!isAdminConfigured()) {
    res.status(404).send('Not found');
    return;
  }

  if (readAdminSession(req)) {
    res.redirect('/admin');
    return;
  }

  res.setHeader('Cache-Control', 'no-store');
  res.send(adminLoginHTML());
});

app.post('/admin/login', (req, res, next) => {
  try {
    if (!isAdminConfigured()) {
      res.status(404).send('Not found');
      return;
    }

    checkAdminLoginRate(req);

    if (!timingSafeEqualStrings(req.body.password, ADMIN_PASSWORD)) {
      res.status(401);
      res.setHeader('Cache-Control', 'no-store');
      res.send(adminLoginHTML('Wrong password.'));
      return;
    }

    clearAdminLoginRate(req);
    setAdminCookie(req, res, createAdminSessionToken());
    res.redirect('/admin');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/logout', requireAdmin, (req, res, next) => {
  try {
    requireAdminCsrf(req);
    clearAdminCookie(req, res);
    res.redirect('/admin/login');
  } catch (err) {
    next(err);
  }
});

app.get('/admin', requireAdmin, (req, res) => {
  res.send(adminDashboardHTML(req.adminSession));
});

app.post('/admin/delete-thread', requireAdmin, (req, res, next) => {
  try {
    requireAdminCsrf(req);

    if (req.body.confirm !== 'yes') {
      throw new Error('Thread delete requires confirmation.');
    }

    const threadId = parseInt(req.body.threadId, 10);
    const data = loadPosts();
    const threadIndex = data.threads.findIndex(item => item.id === threadId);

    if (threadIndex === -1) {
      throw new Error('Thread not found.');
    }

    const [thread] = data.threads.splice(threadIndex, 1);
    deletePostUpload(thread);
    (thread.replies || []).forEach(deletePostUpload);

    savePosts(data);
    generateHTML();
    generateCatalogHTML();
    res.redirect('/admin');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/delete-reply', requireAdmin, (req, res, next) => {
  try {
    requireAdminCsrf(req);

    const threadId = parseInt(req.body.threadId, 10);
    const replyId = parseInt(req.body.replyId, 10);
    const data = loadPosts();
    const thread = data.threads.find(item => item.id === threadId);

    if (!thread || !Array.isArray(thread.replies)) {
      throw new Error('Thread not found.');
    }

    const replyIndex = thread.replies.findIndex(reply => reply.id === replyId);
    if (replyIndex === -1) {
      throw new Error('Reply not found.');
    }

    const [reply] = thread.replies.splice(replyIndex, 1);
    deletePostUpload(reply);
    recalculateThreadBump(thread);

    savePosts(data);
    generateHTML();
    generateCatalogHTML();
    res.redirect('/admin');
  } catch (err) {
    next(err);
  }
});

app.get('/', (req, res) => {
  generateHTML();
  res.sendFile(HTML_FILE);
});

app.get('/catalog', (req, res) => {
  res.send(generateCatalogHTML());
});

app.get('/thread/:id', (req, res) => {
  const threadId = parseInt(req.params.id, 10);
  const threadHTMLPage = generateThreadPageHTML(threadId);

  if (!threadHTMLPage) {
    res.status(404).send(pageShell(
      `Thread not found - ${BOARD_TITLE}`,
      'thread',
      getBoardStats(getSortedThreads()).line,
      `<div class="error-card">
        <h2>Thread not found</h2>
        <p>That thread may have been deleted or never existed.</p>
        <p>[ <a href="/">Back to board</a> ] [ <a href="/catalog">Catalog</a> ]</p>
      </div>`
    ));
    return;
  }

  res.send(threadHTMLPage);
});

app.post('/post', postRateLimit, upload.single('image'), (req, res, next) => {
  try {
    assertHoneypotEmpty(req.body);
    validateUploadedImage(req.file);

    const name = readField(req.body, 'name', 'Anonymous', MAX_NAME_LENGTH, 'Name');
    const title = readField(req.body, 'title', '', MAX_TITLE_LENGTH, 'Subject');
    const comment = readField(req.body, 'comment', '', MAX_COMMENT_LENGTH, 'Comment');

    if (!comment) {
      throw new Error('Comment field is required.');
    }

    if (!req.file) {
      throw new Error('Starting a thread requires uploading an image.');
    }

    const data = loadPosts();
    data.lastId += 1;

    const now = Date.now();
    data.threads.push({
      id: data.lastId,
      name,
      title,
      comment,
      createdAt: now,
      bumpedAt: now,
      image: `src/${req.file.filename}`,
      imageName: req.file.originalname,
      imageSize: formatBytes(req.file.size),
      replies: []
    });

    const newThreadId = data.lastId;

    savePosts(data);
    generateHTML();
    generateCatalogHTML();
    res.redirect(`/thread/${newThreadId}#p${newThreadId}`);
  } catch (err) {
    removeUploadedFile(req);
    next(err);
  }
});

app.post('/reply', postRateLimit, upload.single('image'), (req, res, next) => {
  try {
    assertHoneypotEmpty(req.body);
    validateUploadedImage(req.file);

    const threadId = parseInt(req.body.threadId, 10);
    const name = readField(req.body, 'name', 'Anonymous', MAX_NAME_LENGTH, 'Name');
    const comment = readField(req.body, 'comment', '', MAX_COMMENT_LENGTH, 'Comment');

    if (!comment) {
      throw new Error('Comment field is required.');
    }

    const data = loadPosts();
    const thread = data.threads.find(item => item.id === threadId);

    if (!thread) {
      throw new Error('Thread not found.');
    }

    if (!Array.isArray(thread.replies)) {
      thread.replies = [];
    }

    if (thread.replies.length >= MAX_REPLIES_PER_THREAD) {
      throw new Error('This thread has reached the reply limit.');
    }

    assertNotDuplicateReply(thread, comment);

    data.lastId += 1;
    const reply = {
      id: data.lastId,
      name,
      comment,
      createdAt: Date.now()
    };

    if (req.file) {
      reply.image = `src/${req.file.filename}`;
      reply.imageName = req.file.originalname;
      reply.imageSize = formatBytes(req.file.size);
    }

    thread.replies.push(reply);

    if (thread.replies.length <= MAX_REPLIES_PER_THREAD) {
      thread.bumpedAt = Date.now();
    }

    const newReplyId = reply.id;

    savePosts(data);
    generateHTML();
    generateCatalogHTML();
    res.redirect(`/thread/${threadId}#p${newReplyId}`);
  } catch (err) {
    removeUploadedFile(req);
    next(err);
  }
});

app.use((err, req, res, next) => {
  const status = Number(err.status) || 400;

  res.status(status).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error - ${escapeHTML(BOARD_TITLE)}</title>
  <link rel="icon" href="/chikki.ico" type="image/x-icon">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <nav class="board-list">[ <a href="/">Back to board</a> ] [ <a href="/catalog">Catalog</a> ]</nav>
  <div class="error-card">
    <h2>Post failed</h2>
    <p>${escapeHTML(err.message)}</p>
    <p>[ <a href="/">Back to board</a> ] [ <a href="/catalog">Catalog</a> ]</p>
  </div>
</body>
</html>`);
});

generateHTML();
generateCatalogHTML();

app.listen(PORT, () => {
  console.log(`Server started successfully on http://localhost:${PORT}`);
});
