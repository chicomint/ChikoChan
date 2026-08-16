'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { groupBoardsByCategory } = require('./boards');
const { buildPostIndex, formatComment, quoteHref } = require('./markup');
const { escapeHTML, formatBytes, formatDate, previewText, relativeTime } = require('./utils');

class Renderer {
  constructor(config) {
    this.config = config;
  }

  hasBanner() {
    return fs.existsSync(path.join(this.config.rootDir, 'banner.png'));
  }

  siteTitle() {
    return this.config.site?.title || this.config.board?.title || 'ChikoChan';
  }

  siteDescription() {
    return this.config.site?.description || this.config.board?.description || 'A simple imageboard.';
  }

  siteAnnouncement() {
    return this.config.site?.announcement || this.config.board?.announcement || '';
  }

  sitePages() {
    return this.config.site?.pages || {};
  }

  anonymousName() {
    return this.config.board?.anonymousName || this.config.anonymousName || 'Anonymous';
  }

  siteBannerHTML() {
    if (!this.hasBanner()) return '';
    return `<div class="site-banner"><img class="site-banner-img" src="/banner.png" alt="${escapeHTML(this.siteTitle())} banner"></div>`;
  }

  boardPath(board) {
    return `/${board.uri}/`;
  }

  threadPath(board, threadId) {
    return `/${board.uri}/thread/${threadId}`;
  }

  themeToggle() {
    return '<button class="theme-toggle" type="button" aria-label="Toggle dark mode">Dark</button>';
  }

  boardNav(stats, board, active = 'board') {
    const boardHref = this.boardPath(board);
    const boardName = escapeHTML(boardHref);
    const boardLink = active === 'board' ? `<strong>${boardName}</strong>` : `<a href="${boardHref}">${boardName}</a>`;
    const catalogHref = `/${board.uri}/catalog`;
    const catalog = active === 'catalog' ? '<strong>catalog</strong>' : `<a href="${catalogHref}">catalog</a>`;
    const search = this.config.features.search
      ? (active === 'search' ? ' / <strong>search</strong>' : ' / <a href="/search">search</a>')
      : '';
    return `
  <nav class="board-list" aria-label="board navigation">
    <span class="board-index">[ ${boardLink} / ${catalog}${search} / <a href="${boardHref}#post-form">post</a> ] [ <span>${escapeHTML(stats.line)}</span> ]</span>
    <span class="board-extras">${this.themeToggle()} <a class="home-link" href="/">[Home]</a></span>
  </nav>`;
  }

  boardHeader(board) {
    const announcement = this.siteAnnouncement()
      ? `<aside class="announcement">${escapeHTML(this.siteAnnouncement())}</aside>`
      : '';
    return `
  <header>
    <h1>${escapeHTML(this.boardPath(board))} - ${escapeHTML(board.name)}</h1>
    <p>${escapeHTML(board.description || this.siteDescription())}</p>
  </header>
  ${announcement}`;
  }

  siteHeader() {
    const banner = this.siteBannerHTML();
    const announcement = this.siteAnnouncement()
      ? `<aside class="site-announcement">${escapeHTML(this.siteAnnouncement())}</aside>`
      : '';
    return `
  <header class="site-header">
    <div class="site-top-bar"><a href="/">[Home]</a>${this.themeToggle()}</div>
    ${banner}
    ${announcement}
  </header>`;
  }

  shell(title, active, board, stats, body, options = {}) {
    const attributes = [
      `data-board="${escapeHTML(board.uri)}"`,
      options.threadId ? `data-thread-id="${Number(options.threadId)}"` : '',
      options.threadId ? 'class="is-thread"' : ''
    ].filter(Boolean).join(' ');
    const feedLink = this.config.features.rss
      ? `<link rel="alternate" type="application/rss+xml" title="${escapeHTML(board.name)} RSS" href="/feed.xml">`
      : '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${escapeHTML(board.description || this.siteDescription())}">
  <title>${escapeHTML(title)}</title>
  <link rel="icon" href="/chikki.ico" type="image/x-icon">
  ${feedLink}
  <link rel="stylesheet" href="/style.css">
</head>
<body ${attributes}>
  ${this.boardNav(stats, board, active)}
  ${this.boardHeader(board)}
  ${body}
  <script src="/client.js" defer></script>
</body>
</html>`;
  }

  siteShell(title, body) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${escapeHTML(this.siteDescription())}">
  <title>${escapeHTML(title)}</title>
  <link rel="icon" href="/chikki.ico" type="image/x-icon">
  <link rel="stylesheet" href="/style.css">
</head>
<body class="site-home">
  ${this.siteHeader()}
  ${body}
  <script src="/client.js" defer></script>
</body>
</html>`;
  }

  nameHTML(post) {
    const name = escapeHTML(post.name || this.anonymousName());
    const trip = post.trip ? ` <span class="trip postertrip">${escapeHTML(post.trip)}</span>` : '';
    const identity = post.posterId ? ` <span class="poster-id posteruid">ID:${escapeHTML(post.posterId)}</span>` : '';
    const sage = post.sage ? ' <span class="sage" title="This reply did not bump the thread">sage</span>' : '';
    return `<span class="nameBlock"><span class="name">${name}</span>${trip}${identity}${sage}</span>`;
  }

  postHeader(post, thread, board, isOp) {
    const threadUrl = this.threadPath(board, thread.id);
    const subject = isOp && post.title
      ? `<a class="subject" href="${threadUrl}">${escapeHTML(post.title)}</a>`
      : '';
    const statuses = isOp
      ? [thread.sticky ? '<span class="post-status" title="Sticky">[Sticky]</span>' : '',
        thread.locked ? '<span class="post-status" title="Locked">[Locked]</span>' : '',
        thread.cyclic ? '<span class="post-status" title="Cyclic">[Cyclic]</span>' : ''].join('')
      : '';
    return `
      <div class="${isOp ? 'thread-header' : 'reply-header'} postInfo desktop" id="pi${post.id}">
        <input class="delete" type="checkbox" name="postIds" value="${post.id}" form="delete-form" aria-label="Select post No.${post.id} for deletion">
        ${subject}
        ${this.nameHTML(post)}
        <time class="date-time dateTime" datetime="${new Date(post.createdAt).toISOString()}" title="${formatDate(post.createdAt)}">${relativeTime(post.createdAt)}</time>
        <span class="postNum desktop"><a class="post-id-link" href="${threadUrl}#p${post.id}" data-post-id="${post.id}">No.</a><a class="post-id-link post-id" href="${threadUrl}?quote=${post.id}#reply-form-${thread.id}" data-thread-id="${thread.id}" data-quote-id="${post.id}">${post.id}</a></span>
        <a class="quote-reply-link replylink" href="${threadUrl}?quote=${post.id}#reply-form-${thread.id}" data-thread-id="${thread.id}" data-quote-id="${post.id}">Reply</a>
        ${isOp ? `<a class="thread-view-link" href="${threadUrl}">View thread</a>` : ''}
        <button class="post-hide-button" type="button" data-hide-post="${post.id}" title="Hide this post">−</button>
        ${statuses}
      </div>`;
  }

  imageHTML(post, isReply = false) {
    if (post.imageDeleted) return '<div class="file-info fileText">File deleted.</div>';
    if (!post.image) return '';
    const source = `/${escapeHTML(post.image)}`;
    const name = escapeHTML(post.imageName || 'image');
    const size = escapeHTML(post.imageBytes ? formatBytes(post.imageBytes) : (post.imageSize || 'unknown size'));
    const dimensions = post.width && post.height ? `, ${Number(post.width)}x${Number(post.height)}` : '';
    const spoilerClass = post.spoiler ? ' spoiler-image' : '';
    return `
      <div class="file-info fileText" id="fT${post.id}">File: <a href="${source}" target="_blank" rel="noopener">${name}</a> (${size}${dimensions})${post.spoiler ? ' <strong>Spoiler</strong>' : ''}</div>
      <div class="image-box file${isReply ? ' image-box-reply' : ''}${spoilerClass}">
        <a class="fileThumb" id="f${post.id}" href="${source}" target="_blank" rel="noopener">
          <img class="post-img" src="${source}" alt="${post.spoiler ? 'spoilered image' : 'attached image'}" loading="lazy" data-expand-image>
        </a>
      </div>`;
  }

  backlinksHTML(post, board, currentThreadId, postIndex) {
    if (!post.backlinks?.length) return '';
    const links = post.backlinks.map(backlink => {
      const target = postIndex.get(Number(backlink.id));
      if (!target) return '';
      const href = quoteHref(board.uri, currentThreadId, target);
      return `<a class="backlink quotelink" href="${href}" data-post-id="${target.post.id}">&gt;&gt;${target.post.id}</a>`;
    }).filter(Boolean).join(' ');
    return links ? `<div class="backlinks" aria-label="Replies to this post"><span>Replies:</span> ${links}</div>` : '';
  }

  reportControl(post, board, threadId) {
    if (!this.config.features.reports) return '';
    return `
      <details class="report-control">
        <summary>Report</summary>
        <form action="/report" method="POST">
          <input type="hidden" name="postId" value="${post.id}">
          <input type="hidden" name="redirectTo" value="${this.threadPath(board, threadId)}#p${post.id}">
          <label>Reason <input type="text" name="reason" maxlength="500" required></label>
          <button type="submit">Submit report</button>
        </form>
      </details>`;
  }

  replyHTML(reply, thread, postIndex, board) {
    const comment = formatComment(reply.comment, {
      postIndex,
      boardUri: board.uri,
      threadId: thread.id
    });
    return `
    <div class="reply-container postContainer replyContainer" id="pc${reply.id}" data-no="${reply.id}">
      <span class="reply-side-prefix">&gt;&gt;</span>
      <div class="reply post" id="p${reply.id}">
        ${this.postHeader(reply, thread, board, false)}
        ${this.imageHTML(reply, true)}
        <blockquote class="comment postMessage" id="m${reply.id}">${comment}</blockquote>
        ${this.backlinksHTML(reply, board, thread.id, postIndex)}
        ${this.reportControl(reply, board, thread.id)}
      </div>
    </div>`;
  }

  replyForm(thread, board, options = {}) {
    if (thread.locked) return '<p class="thread-locked-message">This thread is locked. No new replies may be posted.</p>';
    const open = options.open ? ' open' : '';
    return `
    <details class="reply-form-container" id="reply-form-${thread.id}"${open}>
      <summary>Reply${thread.replies.length ? ` (${thread.replies.length})` : ''}</summary>
      <form class="reply-form" action="/${board.uri}/post" method="POST" enctype="multipart/form-data">
        <input type="hidden" name="board" value="${escapeHTML(board.uri)}">
        <input type="hidden" name="mode" value="regist">
        <input type="hidden" name="resto" value="${thread.id}">
        <input type="hidden" name="redirectTo" value="${this.threadPath(board, thread.id)}">
        <input class="honeypot-field" type="text" name="website" autocomplete="off" tabindex="-1" aria-hidden="true">
        <table class="reply-form-table"><tbody>
          <tr><td class="label"><label for="reply-name-${thread.id}">Name</label></td><td><input type="text" id="reply-name-${thread.id}" name="name" maxlength="${this.config.limits.maxNameLength}" placeholder="${escapeHTML(this.anonymousName())}"></td></tr>
          <tr><td class="label"><label for="reply-option-${thread.id}">Options</label></td><td><select id="reply-option-${thread.id}" name="email"><option value="">none</option><option value="sage">sage (do not bump)</option></select></td></tr>
          <tr><td class="label"><label for="reply-comment-${thread.id}">Comment</label></td><td><textarea id="reply-comment-${thread.id}" name="com" maxlength="${this.config.limits.maxCommentLength}" placeholder="Write a reply..."></textarea></td></tr>
          <tr><td class="label"><label for="reply-image-${thread.id}">File</label></td><td><input type="file" id="reply-image-${thread.id}" name="upfile" accept="image/jpeg,image/png,image/gif,image/webp"> ${this.config.features.spoilerImages ? '<label class="inline-option"><input type="checkbox" name="spoiler" value="1"> Spoiler</label>' : ''}</td></tr>
          <tr><td class="label"><label for="reply-password-${thread.id}">Password</label></td><td><input class="post-password" type="password" id="reply-password-${thread.id}" name="pwd" maxlength="100" autocomplete="new-password"> <span class="field-hint">for deletion</span></td></tr>
          <tr><td class="label"></td><td><input type="submit" value="Post reply"></td></tr>
        </tbody></table>
      </form>
    </details>`;
  }

  threadHTML(thread, postIndex, board, options = {}) {
    const replies = thread.replies || [];
    const shown = options.previewReplies && replies.length > options.previewReplies
      ? replies.slice(-options.previewReplies)
      : replies;
    const omitted = replies.length - shown.length;
    const comment = formatComment(thread.comment, {
      postIndex,
      boardUri: board.uri,
      threadId: thread.id
    });
    return `
    <article class="thread" id="t${thread.id}" data-board="${escapeHTML(board.uri)}" data-thread-id="${thread.id}">
      <div class="postContainer opContainer" id="pc${thread.id}" data-no="${thread.id}">
        <div class="post op" id="p${thread.id}">
          ${this.postHeader(thread, thread, board, true)}
          ${this.imageHTML(thread)}
          <blockquote class="comment op-comment postMessage" id="m${thread.id}">${comment}</blockquote>
          ${this.backlinksHTML(thread, board, thread.id, postIndex)}
          ${this.reportControl(thread, board, thread.id)}
        </div>
      </div>
      ${omitted ? `<p class="omitted-replies omitted summary desktop">${omitted} repl${omitted === 1 ? 'y' : 'ies'} omitted. <a href="${this.threadPath(board, thread.id)}">Click here</a> to view.</p>` : ''}
      ${shown.length ? `<div class="replies">${shown.map(reply => this.replyHTML(reply, thread, postIndex, board)).join('')}</div>` : ''}
      ${this.replyForm(thread, board, { open: options.replyFormOpen })}
    </article>
    <hr>`;
  }

  newThreadForm(board) {
    const required = this.config.features.requireImageForThread ? ' required' : '';
    return `
  <div class="post-form-wrapper">
    <form id="post-form" name="post" action="/${board.uri}/post" method="POST" enctype="multipart/form-data">
      <input type="hidden" name="board" value="${escapeHTML(board.uri)}">
      <input type="hidden" name="mode" value="regist">
      <input type="hidden" name="resto" value="0">
      <input class="honeypot-field" type="text" name="website" autocomplete="off" tabindex="-1" aria-hidden="true">
      <table class="post-form-table"><tbody>
        <tr><td class="label"><label for="name">Name</label></td><td><input type="text" id="name" name="name" maxlength="${this.config.limits.maxNameLength}" placeholder="${escapeHTML(this.anonymousName())}"></td></tr>
        <tr><td class="label"><label for="title">Subject</label></td><td><input type="text" id="title" name="sub" maxlength="${this.config.limits.maxSubjectLength}" placeholder="optional"> <input type="submit" value="Post"></td></tr>
        <tr><td class="label"><label for="comment">Comment</label></td><td><textarea id="comment" name="com" maxlength="${this.config.limits.maxCommentLength}" placeholder="Write something..."></textarea></td></tr>
        <tr><td class="label"><label for="image">File</label></td><td><input type="file" id="image" name="upfile" accept="image/jpeg,image/png,image/gif,image/webp"${required}> ${this.config.features.spoilerImages ? '<label class="inline-option"><input type="checkbox" name="spoiler" value="1"> Spoiler</label>' : ''}<span class="field-hint">JPG, PNG, GIF, WEBP. Max ${formatBytes(this.config.limits.maxFileBytes)}.</span></td></tr>
        <tr><td class="label"><label for="password">Password</label></td><td><input class="post-password" type="password" id="password" name="pwd" maxlength="100" autocomplete="new-password"> <span class="field-hint">used to delete your post</span></td></tr>
      </tbody></table>
    </form>
  </div>`;
  }

  deletionForm() {
    if (!this.config.features.userDeletion) return '';
    return `
    <form class="delete-form" id="delete-form" action="/delete" method="POST">
      <strong>Delete post</strong>
      <label>Password <input class="post-password" type="password" name="pwd" maxlength="100" autocomplete="current-password"></label>
      <label><input type="checkbox" name="fileOnly" value="1"> File only</label>
      <button type="submit">Delete</button>
    </form>`;
  }

  pagination(page, totalPages, board) {
    if (totalPages <= 1) return '';
    const links = [];
    for (let index = 1; index <= totalPages; index += 1) {
      const href = index === 1 ? this.boardPath(board) : `/${board.uri}/${index}.html`;
      links.push(index === page ? `<strong>[${index}]</strong>` : `<a href="${href}">[${index}]</a>`);
    }
    return `<nav class="pagination" aria-label="Board pages">${links.join(' ')}</nav>`;
  }

  board(pageData) {
    const board = pageData.board;
    const postIndex = buildPostIndex(pageData.data);
    const threads = pageData.threads.length
      ? pageData.threads.map(thread => this.threadHTML(thread, postIndex, board, { previewReplies: this.config.limits.previewReplies })).join('')
      : '<div class="empty-state"><p>No threads yet.</p><p>Start the first one above.</p></div><hr>';
    return this.shell(
      pageData.page === 1 ? board.name : `Page ${pageData.page} - ${board.name}`,
      'board',
      board,
      pageData.stats,
      `${this.newThreadForm(board)}<main class="threads-container">${threads}${this.pagination(pageData.page, pageData.totalPages, board)}${this.deletionForm()}</main>`
    );
  }

  thread(thread, data, board, stats) {
    const postIndex = buildPostIndex(data);
    const title = thread.title || `Thread No.${thread.id}`;
    return this.shell(
      `${title} - ${board.name}`,
      'thread',
      board,
      stats,
      `<main class="threads-container single-thread-page"><div class="thread-page-actions">[ <a href="${this.boardPath(board)}">Return</a> ] [ <a href="/${board.uri}/catalog">Catalog</a> ]</div>${this.threadHTML(thread, postIndex, board, { replyFormOpen: true })}${this.deletionForm()}</main>`,
      { threadId: thread.id }
    );
  }

  catalogItem(thread, board) {
    const threadUrl = this.threadPath(board, thread.id);
    const image = thread.image
      ? `<img class="catalog-thumb${thread.spoiler ? ' catalog-spoiler' : ''}" src="/${escapeHTML(thread.image)}" alt="${escapeHTML(thread.imageName || 'attached image')}" loading="lazy">`
      : '<span class="catalog-no-thumb">no image</span>';
    return `
      <article class="catalog-card" data-catalog-text="${escapeHTML(`${thread.title || ''} ${thread.name || ''} ${thread.comment || ''}`.toLowerCase())}">
        <a class="catalog-thumb-link" href="${threadUrl}" title="Open thread No.${thread.id}">${image}</a>
        <div class="catalog-card-meta"><a class="catalog-post-id" href="${threadUrl}">No.${thread.id}</a><span>${thread.replies.length} repl${thread.replies.length === 1 ? 'y' : 'ies'}</span></div>
        <a class="catalog-subject" href="${threadUrl}">${escapeHTML(thread.title || 'No subject')}</a>
        <div class="catalog-name">${escapeHTML(thread.name || this.anonymousName())}</div>
        <div class="catalog-date">${formatDate(thread.createdAt)}</div>
        <p class="catalog-preview"><a href="${threadUrl}">${escapeHTML(previewText(thread.comment))}</a></p>
      </article>`;
  }

  catalog(data, threads, board, stats) {
    const content = threads.length
      ? `<div class="catalog-grid">${threads.map(thread => this.catalogItem(thread, board)).join('')}</div>`
      : '<div class="empty-state"><p>No threads in the catalog yet.</p></div>';
    return this.shell(
      `Catalog - ${board.name}`,
      'catalog',
      board,
      stats,
      `<main class="catalog-container"><div class="catalog-header-row"><h2>Catalog</h2><span>${escapeHTML(stats.line)}</span></div><div class="catalog-tools"><label>Filter <input id="catalog-filter" type="search" autocomplete="off"></label></div>${content}</main>`
    );
  }

  search(query, results, data, stats) {
    const postIndex = buildPostIndex(data);
    const boardMap = new Map(data.boards.map(board => [board.id, board]));
    const threadBoardMap = new Map(data.threads.map(thread => [thread.id, thread.boardId]));
    const cards = results.map(entry => {
      const boardId = threadBoardMap.get(entry.threadId);
      const board = boardMap.get(boardId) || data.boards[0];
      const url = `${this.threadPath(board, entry.threadId)}#p${entry.post.id}`;
      const formatted = formatComment(previewText(entry.post.comment, 300), {
        postIndex, boardUri: board.uri, threadId: entry.threadId
      });
      return `<article class="search-result"><a class="post-id-link" href="${url}">No.${entry.post.id}</a> <span class="name">${escapeHTML(entry.post.name || this.anonymousName())}</span><blockquote class="comment">${formatted}</blockquote></article>`;
    }).join('');
    return this.siteShell(
      `Search - ${this.siteTitle()}`,
      `<main class="search-page"><form action="/search" method="GET"><label for="search-query">Search posts</label> <input id="search-query" type="search" name="q" maxlength="100" value="${escapeHTML(query)}"> <button type="submit">Search</button></form>${query ? `<p>${results.length} result${results.length === 1 ? '' : 's'} for “${escapeHTML(query)}”.</p>${cards || '<div class="empty-state">No matching posts.</div>'}` : '<p>Search subjects, names, and comments.</p>'}</main>`
    );
  }

  message(title, message, stats, returnTo = '/') {
    return this.siteShell(title, `<div class="error-card"><h2>${escapeHTML(title)}</h2><p>${escapeHTML(message)}</p><p>[ <a href="${escapeHTML(returnTo)}">Continue</a> ]</p></div>`);
  }

  adminShell(title, body) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHTML(title)}</title>
  <link rel="icon" href="/chikki.ico">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div class="admin-top-bar"><a href="/">[Home]</a>${this.themeToggle()}</div>
  <main class="admin-page">${body}</main>
  <script src="/client.js" defer></script>
</body>
</html>`;
  }

  adminLogin(error = '') {
    return this.adminShell(`Admin - ${this.siteTitle()}`, `<section class="admin-panel admin-login-panel"><h1>Admin</h1>${error ? `<p class="admin-error">${escapeHTML(error)}</p>` : ''}<form action="/admin/login" method="POST"><label for="admin-password">Password</label><input type="password" id="admin-password" name="password" autocomplete="current-password" required autofocus><button type="submit">Log in</button></form><p class="admin-muted">[ <a href="/">Return to site</a> ]</p></section>`);
  }

  csrf(token) {
    return `<input type="hidden" name="csrf" value="${escapeHTML(token)}">`;
  }

  adminPost(post, thread, board, csrf, isOp = false) {
    const controls = isOp ? ['sticky', 'locked', 'cyclic'].map(flag => `
      <form action="/admin/thread-setting" method="POST" class="admin-action-form">${this.csrf(csrf)}<input type="hidden" name="threadId" value="${thread.id}"><input type="hidden" name="flag" value="${flag}"><input type="hidden" name="value" value="${thread[flag] ? '0' : '1'}"><button type="submit">${thread[flag] ? 'Unset' : 'Set'} ${flag}</button></form>`).join('') : '';
    const ban = post.posterKey ? `<form action="/admin/ban" method="POST" class="admin-action-form admin-ban-form">${this.csrf(csrf)}<input type="hidden" name="postId" value="${post.id}"><select name="duration"><option value="3600000">1 hour</option><option value="86400000">1 day</option><option value="604800000">1 week</option><option value="0">Permanent</option></select><input name="reason" maxlength="300" placeholder="Ban reason" required><button type="submit" class="danger-button">Ban poster</button></form>` : '<span class="admin-muted">Legacy post: no poster fingerprint</span>';
    return `<div class="admin-post-summary"><div><strong>No.${post.id}${post.title ? ` — ${escapeHTML(post.title)}` : ''}</strong> <span class="admin-muted">by ${escapeHTML(post.name || this.anonymousName())} · ${formatDate(post.createdAt)}</span></div><p>${escapeHTML(previewText(post.comment, 240))}</p><div class="admin-post-actions"><form action="/admin/delete" method="POST" class="admin-action-form">${this.csrf(csrf)}<input type="hidden" name="postId" value="${post.id}"><button type="submit" class="danger-button">Delete post</button></form>${controls}${ban}</div></div>`;
  }

  adminDashboard(data, csrf) {
    const boardMap = new Map(data.boards.map(board => [board.id, board]));
    const activeBans = data.bans.filter(ban => ban.active !== false && (!ban.expiresAt || ban.expiresAt > Date.now()));
    const reports = data.reports.map(report => {
      const thread = data.threads.find(t => t.id === report.threadId);
      const board = thread ? (boardMap.get(thread.boardId) || data.boards[0]) : data.boards[0];
      return `<li><a href="${this.threadPath(board, report.threadId)}#p${report.postId}">No.${report.postId}</a>: ${escapeHTML(report.reason)} <span class="admin-muted">${formatDate(report.createdAt)}</span><form action="/admin/dismiss-report" method="POST" class="admin-action-form">${this.csrf(csrf)}<input type="hidden" name="reportId" value="${escapeHTML(report.id)}"><button type="submit">Dismiss</button></form></li>`;
    }).join('');
    const bans = activeBans.map(ban => `<li>${escapeHTML(ban.reason)} — ${ban.expiresAt ? `until ${formatDate(ban.expiresAt)}` : 'permanent'}<form action="/admin/unban" method="POST" class="admin-action-form">${this.csrf(csrf)}<input type="hidden" name="banId" value="${escapeHTML(ban.id)}"><button type="submit">Unban</button></form></li>`).join('');
    const threads = data.threads.map(thread => {
      const board = boardMap.get(thread.boardId) || data.boards[0];
      return `<article class="admin-thread"><h2>Thread No.${thread.id} <span class="admin-muted">on /${escapeHTML(board.uri)}/</span></h2>${this.adminPost(thread, thread, board, csrf, true)}${thread.replies.length ? `<div class="admin-reply-list">${thread.replies.map(reply => this.adminPost(reply, thread, board, csrf)).join('')}</div>` : '<p class="admin-muted">No replies.</p>'}</article>`;
    }).join('');
    const logs = data.moderationLog.slice(-20).reverse().map(log => `<li>${formatDate(log.createdAt)} — ${escapeHTML(log.detail)}</li>`).join('');
    return this.adminShell(`Admin - ${this.siteTitle()}`, `<section class="admin-panel"><div class="admin-toolbar"><div><h1>Admin</h1><p>${escapeHTML(`${data.threads.length} threads · ${data.reports.length} reports · ${data.boards.length} boards`)}</p></div><div class="admin-toolbar-actions"><a href="/admin/boards">Boards</a><a href="/">Site</a><form action="/admin/logout" method="POST">${this.csrf(csrf)}<button type="submit">Log out</button></form></div></div><section class="admin-section"><h2>Reports (${data.reports.length})</h2><ul class="admin-list">${reports || '<li>No open reports.</li>'}</ul></section><section class="admin-section"><h2>Active bans (${activeBans.length})</h2><ul class="admin-list">${bans || '<li>No active bans.</li>'}</ul></section><section class="admin-section"><h2>Threads</h2>${threads || '<p>No threads.</p>'}</section><section class="admin-section"><h2>Recent moderation</h2><ul class="admin-list">${logs || '<li>No actions yet.</li>'}</ul></section></section>`);
  }

  adminBoards(boards, defaultBoardId, csrf) {
    const rows = boards.map(board => {
      const isDefault = board.id === defaultBoardId;
      return `<tr>
        <td>/${escapeHTML(board.uri)}/</td>
        <td><form action="/admin/boards/edit" method="POST" class="admin-board-form">${this.csrf(csrf)}<input type="hidden" name="uri" value="${escapeHTML(board.uri)}"><input type="text" name="newUri" value="${escapeHTML(board.uri)}" maxlength="32" required><input type="text" name="name" value="${escapeHTML(board.name)}" maxlength="80" required><input type="text" name="description" value="${escapeHTML(board.description)}" maxlength="200"><input type="text" name="category" value="${escapeHTML(board.category)}" maxlength="80" required><input type="hidden" name="enabled" value="0"><label><input type="checkbox" name="enabled" value="1"${board.enabled ? ' checked' : ''}> Enabled</label><button type="submit">Save</button></form></td>
        <td>${escapeHTML(board.category)}</td>
        <td>${board.enabled ? 'Yes' : 'No'}${isDefault ? ' (default)' : ''}</td>
        <td>
          <form action="/admin/boards/toggle" method="POST" class="admin-action-form">${this.csrf(csrf)}<input type="hidden" name="uri" value="${escapeHTML(board.uri)}"><button type="submit">${board.enabled ? 'Disable' : 'Enable'}</button></form>
          ${isDefault ? '' : `<form action="/admin/boards/delete" method="POST" class="admin-action-form" onsubmit="return confirm('Delete /${escapeHTML(board.uri)}/? Threads will move to the default board.')">${this.csrf(csrf)}<input type="hidden" name="uri" value="${escapeHTML(board.uri)}"><button type="submit" class="danger-button">Delete</button></form>`}
        </td>
      </tr>`;
    }).join('');

    const addForm = `<section class="admin-section"><h2>Add board</h2><form action="/admin/boards/add" method="POST" class="admin-board-add-form">${this.csrf(csrf)}<label>URI <input type="text" name="uri" maxlength="32" required placeholder="e.g. g"></label><label>Name <input type="text" name="name" maxlength="80" required placeholder="Technology"></label><label>Description <input type="text" name="description" maxlength="200"></label><label>Category <input type="text" name="category" maxlength="80" value="Interests"></label><label><input type="checkbox" name="enabled" value="1" checked> Enabled</label><button type="submit">Add board</button></form></section>`;

    return this.adminShell(`Boards - Admin - ${this.siteTitle()}`, `<section class="admin-panel"><div class="admin-toolbar"><div><h1>Boards</h1><p>Manage imageboard boards and categories.</p></div><div class="admin-toolbar-actions"><a href="/admin">Dashboard</a><a href="/">Site</a><form action="/admin/logout" method="POST">${this.csrf(csrf)}<button type="submit">Log out</button></form></div></div>${addForm}<section class="admin-section"><h2>Existing boards</h2><table class="admin-board-table"><thead><tr><th>URI</th><th>Name / Description / Category</th><th>Category</th><th>Enabled</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No boards.</td></tr>'}</tbody></table></section></section>`);
  }

  home(data, boards, siteStats, latestPosts) {
    const categories = groupBoardsByCategory(boards);
    const categoryHtml = [...categories.entries()].map(([category, categoryBoards]) => `
      <div class="board-category">
        <h3>${escapeHTML(category)}</h3>
        <ul>
          ${categoryBoards.map(board => `<li><a href="${this.boardPath(board)}">/${escapeHTML(board.uri)}/</a> - <a href="${this.boardPath(board)}">${escapeHTML(board.name)}</a></li>`).join('')}
        </ul>
      </div>
    `).join('');

    const footerLinks = Object.entries(this.sitePages()).map(([key, page]) =>
      `<a href="/${escapeHTML(key)}">${escapeHTML(page.title || key)}</a>`
    ).join(' | ');

    const latestItems = latestPosts.map(entry => {
      const url = `${this.threadPath(entry.board, entry.threadId)}#p${entry.post.id}`;
      const text = escapeHTML(previewText(entry.post.comment, 90));
      const name = escapeHTML(entry.post.name || this.anonymousName());
      return `<li><span class="latest-post-name">${name}:</span> <a href="${url}">${text}</a></li>`;
    }).join('');
    const latestContent = latestItems
      ? `<ul class="latest-posts-list">${latestItems}</ul>`
      : '<p>No posts yet.</p>';

    return this.siteShell(
      this.siteTitle(),
      `<main class="home-container">
        <section class="site-info">
          <h2>${escapeHTML(this.siteTitle())}?</h2>
          <p>${escapeHTML(this.siteDescription())}</p>
        </section>
        <section class="board-directory">
          <h2>Boards</h2>
          <div class="board-categories">
            ${categoryHtml || '<p>No boards available.</p>'}
          </div>
        </section>
        <section class="latest-posts-section">
          <h2>Latest Posts</h2>
          ${latestContent}
        </section>
        <section class="site-stats">
          <p>Total posts: ${siteStats.postCount.toLocaleString()}</p>
          <p>Boards: ${siteStats.boardCount}</p>
          <p>Active content: ${escapeHTML(siteStats.activeContentText)}</p>
        </section>
        <footer class="site-footer">
          ${footerLinks}
        </footer>
      </main>`
    );
  }

  page(pageKey, page) {
    const content = String(page.content || '')
      .split('\n')
      .map(line => escapeHTML(line))
      .join('<br>');

    return this.siteShell(
      `${page.title} - ${this.siteTitle()}`,
      `<main class="home-container"><section class="site-info"><h2>${escapeHTML(page.title)}</h2><div class="site-page-content">${content}</div></section></main>`
    );
  }
}

module.exports = { Renderer };
