const express = require('express');
const multer = require('multer');
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
const UPLOAD_DIR = path.join(DATA_DIR, 'src');
const FAVICON_FILE = path.join(__dirname, 'chikki.ico');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ lastId: 0, threads: [] }, null, 2), 'utf8');
}

app.use(express.urlencoded({ extended: true }));
app.use('/src', express.static(UPLOAD_DIR));
app.use('/style.css', express.static(path.join(__dirname, 'style.css')));

app.get('/chikki.ico', (req, res) => {
  res.sendFile(FAVICON_FILE);
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const allowedExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
    const ext = path.extname(file.originalname).toLowerCase();
    const safeExt = allowedExts.has(ext) ? ext : '.img';
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${uniqueSuffix}${safeExt}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedTypes.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only standard image files are allowed: .jpg, .jpeg, .png, .gif, .webp'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }
});

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
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function cleanText(value, fallback = '') {
  const text = String(value || '').trim();
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
  <script>
    function quotePost(postId, threadId) {
      const details = document.getElementById('reply-form-' + threadId);
      if (details && details.tagName.toLowerCase() === 'details') {
        details.open = true;
      }

      const textarea = document.getElementById('reply-comment-' + threadId);
      if (!textarea) return true;

      const quoteText = '>>' + postId + '\\n';
      if (textarea.value && !textarea.value.endsWith('\\n')) {
        textarea.value += '\\n';
      }
      textarea.value += quoteText;
      textarea.focus();
      location.hash = 'reply-form-' + threadId;
      return false;
    }

    document.addEventListener('click', function(event) {
      const link = event.target.closest('[data-quote-id][data-thread-id]');
      if (!link) return;
      if (quotePost(link.dataset.quoteId, link.dataset.threadId) === false) {
        event.preventDefault();
      }
    });

    document.addEventListener('DOMContentLoaded', function() {
      const params = new URLSearchParams(window.location.search);
      const quoteId = params.get('quote');
      const threadId = document.body.dataset.threadId;
      if (quoteId && threadId) {
        quotePost(quoteId, threadId);
      }
    });
  </script>`;
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

app.post('/post', upload.single('image'), (req, res, next) => {
  try {
    const name = cleanText(req.body.name, 'Anonymous');
    const title = cleanText(req.body.title);
    const comment = cleanText(req.body.comment);

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
    next(err);
  }
});

app.post('/reply', upload.single('image'), (req, res, next) => {
  try {
    const threadId = parseInt(req.body.threadId, 10);
    const name = cleanText(req.body.name, 'Anonymous');
    const comment = cleanText(req.body.comment);

    if (!comment) {
      throw new Error('Comment field is required.');
    }

    const data = loadPosts();
    const thread = data.threads.find(item => item.id === threadId);

    if (!thread) {
      throw new Error('Thread not found.');
    }

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

    if (!Array.isArray(thread.replies)) {
      thread.replies = [];
    }

    thread.replies.push(reply);

    if (thread.replies.length <= 500) {
      thread.bumpedAt = Date.now();
    }

    const newReplyId = reply.id;

    savePosts(data);
    generateHTML();
    generateCatalogHTML();
    res.redirect(`/thread/${threadId}#p${newReplyId}`);
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  res.status(400).send(`<!DOCTYPE html>
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
    <button onclick="window.history.back()">Go back</button>
  </div>
</body>
</html>`);
});

generateHTML();
generateCatalogHTML();

app.listen(PORT, () => {
  console.log(`Server started successfully on http://localhost:${PORT}`);
});
