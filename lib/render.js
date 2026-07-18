'use strict';

const path = require('node:path');
const { buildPostIndex, formatComment, quoteHref } = require('./markup');
const { escapeHTML, formatBytes, formatDate, previewText } = require('./utils');

class Renderer {
  constructor(config) {
    this.config = config;
  }

  threadPath(threadId) {
    return `/${this.config.board.uri}/thread/${threadId}`;
  }

  boardNav(stats, active = 'board') {
    const boardName = escapeHTML(this.config.board.path);
    const board = active === 'board' ? `<strong>${boardName}</strong>` : `<a href="/">${boardName}</a>`;
    const catalog = active === 'catalog' ? '<strong>catalog</strong>' : '<a href="/catalog">catalog</a>';
    const search = this.config.features.search
      ? (active === 'search' ? ' / <strong>search</strong>' : ' / <a href="/search">search</a>')
      : '';
    return `
  <nav class="board-list" aria-label="board navigation">
    <span class="board-index">[ ${board} / ${catalog}${search} / <a href="/#post-form">post</a> ] [ <span>${escapeHTML(stats.line)}</span> ]</span>
    <a class="home-link" href="/">[Home]</a>
  </nav>`;
  }

  boardHeader() {
    const announcement = this.config.board.announcement
      ? `<aside class="announcement">${escapeHTML(this.config.board.announcement)}</aside>`
      : '';
    return `
  <header>
    <h1>${escapeHTML(this.config.board.path)} - ${escapeHTML(this.config.board.title)}</h1>
    <p>${escapeHTML(this.config.board.description)}</p>
  </header>
  ${announcement}`;
  }

  shell(title, active, stats, body, options = {}) {
    const attributes = [
      `data-board="${escapeHTML(this.config.board.uri)}"`,
      options.threadId ? `data-thread-id="${Number(options.threadId)}"` : '',
      options.threadId ? 'class="is-thread"' : ''
    ].filter(Boolean).join(' ');
    const feedLink = this.config.features.rss
      ? `<link rel="alternate" type="application/rss+xml" title="${escapeHTML(this.config.board.title)} RSS" href="/feed.xml">`
      : '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${escapeHTML(this.config.board.description)}">
  <title>${escapeHTML(title)}</title>
  <link rel="icon" href="/chikki.ico" type="image/x-icon">
  ${feedLink}
  <link rel="stylesheet" href="/style.css">
</head>
<body ${attributes}>
  ${this.boardNav(stats, active)}
  ${this.boardHeader()}
  ${body}
  <script src="/client.js" defer></script>
</body>
</html>`;
  }

  nameHTML(post) {
    const name = escapeHTML(post.name || this.config.board.anonymousName);
    const trip = post.trip ? ` <span class="trip postertrip">${escapeHTML(post.trip)}</span>` : '';
    const identity = post.posterId ? ` <span class="poster-id posteruid">ID:${escapeHTML(post.posterId)}</span>` : '';
    const sage = post.sage ? ' <span class="sage" title="This reply did not bump the thread">sage</span>' : '';
    return `<span class="nameBlock"><span class="name">${name}</span>${trip}${identity}${sage}</span>`;
  }

  postHeader(post, thread, isOp) {
    const threadUrl = this.threadPath(thread.id);
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
        <time class="date-time dateTime" datetime="${new Date(post.createdAt).toISOString()}">${formatDate(post.createdAt)}</time>
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

  backlinksHTML(post, currentThreadId, postIndex) {
    if (!post.backlinks?.length) return '';
    const links = post.backlinks.map(backlink => {
      const target = postIndex.get(Number(backlink.id));
      if (!target) return '';
      const href = quoteHref(this.config.board.uri, currentThreadId, target);
      return `<a class="backlink quotelink" href="${href}" data-post-id="${target.post.id}">&gt;&gt;${target.post.id}</a>`;
    }).filter(Boolean).join(' ');
    return links ? `<div class="backlinks" aria-label="Replies to this post"><span>Replies:</span> ${links}</div>` : '';
  }

  reportControl(post, threadId) {
    if (!this.config.features.reports) return '';
    return `
      <details class="report-control">
        <summary>Report</summary>
        <form action="/report" method="POST">
          <input type="hidden" name="postId" value="${post.id}">
          <input type="hidden" name="redirectTo" value="${this.threadPath(threadId)}#p${post.id}">
          <label>Reason <input type="text" name="reason" maxlength="500" required></label>
          <button type="submit">Submit report</button>
        </form>
      </details>`;
  }

  replyHTML(reply, thread, postIndex) {
    const comment = formatComment(reply.comment, {
      postIndex,
      boardUri: this.config.board.uri,
      threadId: thread.id
    });
    return `
    <div class="reply-container postContainer replyContainer" id="pc${reply.id}" data-no="${reply.id}">
      <span class="reply-side-prefix">&gt;&gt;</span>
      <div class="reply post" id="p${reply.id}">
        ${this.postHeader(reply, thread, false)}
        ${this.imageHTML(reply, true)}
        <blockquote class="comment postMessage" id="m${reply.id}">${comment}</blockquote>
        ${this.backlinksHTML(reply, thread.id, postIndex)}
        ${this.reportControl(reply, thread.id)}
      </div>
    </div>`;
  }

  replyForm(thread, options = {}) {
    if (thread.locked) return '<p class="thread-locked-message">This thread is locked. No new replies may be posted.</p>';
    const open = options.open ? ' open' : '';
    return `
    <details class="reply-form-container" id="reply-form-${thread.id}"${open}>
      <summary>Reply${thread.replies.length ? ` (${thread.replies.length})` : ''}</summary>
      <form class="reply-form" action="/reply" method="POST" enctype="multipart/form-data">
        <input type="hidden" name="board" value="${escapeHTML(this.config.board.uri)}">
        <input type="hidden" name="mode" value="regist">
        <input type="hidden" name="resto" value="${thread.id}">
        <input type="hidden" name="redirectTo" value="${this.threadPath(thread.id)}">
        <input class="honeypot-field" type="text" name="website" autocomplete="off" tabindex="-1" aria-hidden="true">
        <table class="reply-form-table"><tbody>
          <tr><td class="label"><label for="reply-name-${thread.id}">Name</label></td><td><input type="text" id="reply-name-${thread.id}" name="name" maxlength="${this.config.limits.maxNameLength}" placeholder="${escapeHTML(this.config.board.anonymousName)}"></td></tr>
          <tr><td class="label"><label for="reply-option-${thread.id}">Options</label></td><td><select id="reply-option-${thread.id}" name="email"><option value="">none</option><option value="sage">sage (do not bump)</option></select></td></tr>
          <tr><td class="label"><label for="reply-comment-${thread.id}">Comment</label></td><td><textarea id="reply-comment-${thread.id}" name="com" maxlength="${this.config.limits.maxCommentLength}" placeholder="Write a reply..."></textarea></td></tr>
          <tr><td class="label"><label for="reply-image-${thread.id}">File</label></td><td><input type="file" id="reply-image-${thread.id}" name="upfile" accept="image/jpeg,image/png,image/gif,image/webp"> ${this.config.features.spoilerImages ? '<label class="inline-option"><input type="checkbox" name="spoiler" value="1"> Spoiler</label>' : ''}</td></tr>
          <tr><td class="label"><label for="reply-password-${thread.id}">Password</label></td><td><input class="post-password" type="password" id="reply-password-${thread.id}" name="pwd" maxlength="100" autocomplete="new-password"> <span class="field-hint">for deletion</span></td></tr>
          <tr><td class="label"></td><td><input type="submit" value="Post reply"></td></tr>
        </tbody></table>
      </form>
    </details>`;
  }

  threadHTML(thread, postIndex, options = {}) {
    const replies = thread.replies || [];
    const shown = options.previewReplies && replies.length > options.previewReplies
      ? replies.slice(-options.previewReplies)
      : replies;
    const omitted = replies.length - shown.length;
    const comment = formatComment(thread.comment, {
      postIndex,
      boardUri: this.config.board.uri,
      threadId: thread.id
    });
    return `
    <article class="thread" id="t${thread.id}" data-board="${escapeHTML(this.config.board.uri)}" data-thread-id="${thread.id}">
      <div class="postContainer opContainer" id="pc${thread.id}" data-no="${thread.id}">
        <div class="post op" id="p${thread.id}">
          ${this.postHeader(thread, thread, true)}
          ${this.imageHTML(thread)}
          <blockquote class="comment op-comment postMessage" id="m${thread.id}">${comment}</blockquote>
          ${this.backlinksHTML(thread, thread.id, postIndex)}
          ${this.reportControl(thread, thread.id)}
        </div>
      </div>
      ${omitted ? `<p class="omitted-replies omitted summary desktop">${omitted} repl${omitted === 1 ? 'y' : 'ies'} omitted. <a href="${this.threadPath(thread.id)}">Click here</a> to view.</p>` : ''}
      ${shown.length ? `<div class="replies">${shown.map(reply => this.replyHTML(reply, thread, postIndex)).join('')}</div>` : ''}
      ${this.replyForm(thread, { open: options.replyFormOpen })}
    </article>
    <hr>`;
  }

  newThreadForm() {
    const required = this.config.features.requireImageForThread ? ' required' : '';
    return `
  <div class="post-form-wrapper">
    <form id="post-form" name="post" action="/post" method="POST" enctype="multipart/form-data">
      <input type="hidden" name="board" value="${escapeHTML(this.config.board.uri)}">
      <input type="hidden" name="mode" value="regist">
      <input type="hidden" name="resto" value="0">
      <input class="honeypot-field" type="text" name="website" autocomplete="off" tabindex="-1" aria-hidden="true">
      <table class="post-form-table"><tbody>
        <tr><td class="label"><label for="name">Name</label></td><td><input type="text" id="name" name="name" maxlength="${this.config.limits.maxNameLength}" placeholder="${escapeHTML(this.config.board.anonymousName)}"></td></tr>
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

  pagination(page, totalPages) {
    if (totalPages <= 1) return '';
    const links = [];
    for (let index = 1; index <= totalPages; index += 1) {
      const href = index === 1 ? '/' : `/${this.config.board.uri}/${index}.html`;
      links.push(index === page ? `<strong>[${index}]</strong>` : `<a href="${href}">[${index}]</a>`);
    }
    return `<nav class="pagination" aria-label="Board pages">${links.join(' ')}</nav>`;
  }

  board(pageData) {
    const postIndex = buildPostIndex(pageData.data);
    const threads = pageData.threads.length
      ? pageData.threads.map(thread => this.threadHTML(thread, postIndex, { previewReplies: this.config.limits.previewReplies })).join('')
      : '<div class="empty-state"><p>No threads yet.</p><p>Start the first one above.</p></div><hr>';
    return this.shell(
      pageData.page === 1 ? this.config.board.title : `Page ${pageData.page} - ${this.config.board.title}`,
      'board',
      pageData.stats,
      `${this.newThreadForm()}<main class="threads-container">${threads}${this.pagination(pageData.page, pageData.totalPages)}${this.deletionForm()}</main>`
    );
  }

  thread(thread, data, stats) {
    const postIndex = buildPostIndex(data);
    const title = thread.title || `Thread No.${thread.id}`;
    return this.shell(
      `${title} - ${this.config.board.title}`,
      'thread',
      stats,
      `<main class="threads-container single-thread-page"><div class="thread-page-actions">[ <a href="/">Return</a> ] [ <a href="/catalog">Catalog</a> ]</div>${this.threadHTML(thread, postIndex, { replyFormOpen: true })}${this.deletionForm()}</main>`,
      { threadId: thread.id }
    );
  }

  catalogItem(thread) {
    const threadUrl = this.threadPath(thread.id);
    const image = thread.image
      ? `<img class="catalog-thumb${thread.spoiler ? ' catalog-spoiler' : ''}" src="/${escapeHTML(thread.image)}" alt="${escapeHTML(thread.imageName || 'attached image')}" loading="lazy">`
      : '<span class="catalog-no-thumb">no image</span>';
    return `
      <article class="catalog-card" data-catalog-text="${escapeHTML(`${thread.title || ''} ${thread.name || ''} ${thread.comment || ''}`.toLowerCase())}">
        <a class="catalog-thumb-link" href="${threadUrl}" title="Open thread No.${thread.id}">${image}</a>
        <div class="catalog-card-meta"><a class="catalog-post-id" href="${threadUrl}">No.${thread.id}</a><span>${thread.replies.length} repl${thread.replies.length === 1 ? 'y' : 'ies'}</span></div>
        <a class="catalog-subject" href="${threadUrl}">${escapeHTML(thread.title || 'No subject')}</a>
        <div class="catalog-name">${escapeHTML(thread.name || this.config.board.anonymousName)}</div>
        <div class="catalog-date">${formatDate(thread.createdAt)}</div>
        <p class="catalog-preview"><a href="${threadUrl}">${escapeHTML(previewText(thread.comment))}</a></p>
      </article>`;
  }

  catalog(data, threads, stats) {
    const content = threads.length
      ? `<div class="catalog-grid">${threads.map(thread => this.catalogItem(thread)).join('')}</div>`
      : '<div class="empty-state"><p>No threads in the catalog yet.</p></div>';
    return this.shell(
      `Catalog - ${this.config.board.title}`,
      'catalog',
      stats,
      `<main class="catalog-container"><div class="catalog-header-row"><h2>Catalog</h2><span>${escapeHTML(stats.line)}</span></div><div class="catalog-tools"><label>Filter <input id="catalog-filter" type="search" autocomplete="off"></label></div>${content}</main>`
    );
  }

  search(query, results, data, stats) {
    const postIndex = buildPostIndex(data);
    const cards = results.map(entry => {
      const url = `${this.threadPath(entry.threadId)}#p${entry.post.id}`;
      const formatted = formatComment(previewText(entry.post.comment, 300), {
        postIndex, boardUri: this.config.board.uri, threadId: entry.threadId
      });
      return `<article class="search-result"><a class="post-id-link" href="${url}">No.${entry.post.id}</a> <span class="name">${escapeHTML(entry.post.name || this.config.board.anonymousName)}</span><blockquote class="comment">${formatted}</blockquote></article>`;
    }).join('');
    return this.shell(
      `Search - ${this.config.board.title}`,
      'search',
      stats,
      `<main class="search-page"><form action="/search" method="GET"><label for="search-query">Search posts</label> <input id="search-query" type="search" name="q" maxlength="100" value="${escapeHTML(query)}"> <button type="submit">Search</button></form>${query ? `<p>${results.length} result${results.length === 1 ? '' : 's'} for “${escapeHTML(query)}”.</p>${cards || '<div class="empty-state">No matching posts.</div>'}` : '<p>Search subjects, names, and comments.</p>'}</main>`
    );
  }

  message(title, message, statusStats, returnTo = '/') {
    return this.shell(title, 'board', statusStats, `<div class="error-card"><h2>${escapeHTML(title)}</h2><p>${escapeHTML(message)}</p><p>[ <a href="${escapeHTML(returnTo)}">Continue</a> ]</p></div>`);
  }

  adminShell(title, body) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHTML(title)}</title><link rel="icon" href="/chikki.ico"><link rel="stylesheet" href="/style.css"></head><body><main class="admin-page">${body}</main></body></html>`;
  }

  adminLogin(error = '') {
    return this.adminShell(`Admin - ${this.config.board.title}`, `<section class="admin-panel admin-login-panel"><h1>Admin</h1>${error ? `<p class="admin-error">${escapeHTML(error)}</p>` : ''}<form action="/admin/login" method="POST"><label for="admin-password">Password</label><input type="password" id="admin-password" name="password" autocomplete="current-password" required autofocus><button type="submit">Log in</button></form><p class="admin-muted">[ <a href="/">Return to board</a> ]</p></section>`);
  }

  csrf(token) {
    return `<input type="hidden" name="csrf" value="${escapeHTML(token)}">`;
  }

  adminPost(post, thread, csrf, isOp = false) {
    const controls = isOp ? ['sticky', 'locked', 'cyclic'].map(flag => `
      <form action="/admin/thread-setting" method="POST" class="admin-action-form">${this.csrf(csrf)}<input type="hidden" name="threadId" value="${thread.id}"><input type="hidden" name="flag" value="${flag}"><input type="hidden" name="value" value="${thread[flag] ? '0' : '1'}"><button type="submit">${thread[flag] ? 'Unset' : 'Set'} ${flag}</button></form>`).join('') : '';
    const ban = post.posterKey ? `<form action="/admin/ban" method="POST" class="admin-action-form admin-ban-form">${this.csrf(csrf)}<input type="hidden" name="postId" value="${post.id}"><select name="duration"><option value="3600000">1 hour</option><option value="86400000">1 day</option><option value="604800000">1 week</option><option value="0">Permanent</option></select><input name="reason" maxlength="300" placeholder="Ban reason" required><button type="submit" class="danger-button">Ban poster</button></form>` : '<span class="admin-muted">Legacy post: no poster fingerprint</span>';
    return `<div class="admin-post-summary"><div><strong>No.${post.id}${post.title ? ` — ${escapeHTML(post.title)}` : ''}</strong> <span class="admin-muted">by ${escapeHTML(post.name || this.config.board.anonymousName)} · ${formatDate(post.createdAt)}</span></div><p>${escapeHTML(previewText(post.comment, 240))}</p><div class="admin-post-actions"><form action="/admin/delete" method="POST" class="admin-action-form">${this.csrf(csrf)}<input type="hidden" name="postId" value="${post.id}"><button type="submit" class="danger-button">Delete post</button></form>${controls}${ban}</div></div>`;
  }

  adminDashboard(data, csrf) {
    const activeBans = data.bans.filter(ban => ban.active !== false && (!ban.expiresAt || ban.expiresAt > Date.now()));
    const reports = data.reports.map(report => `<li><a href="${this.threadPath(report.threadId)}#p${report.postId}">No.${report.postId}</a>: ${escapeHTML(report.reason)} <span class="admin-muted">${formatDate(report.createdAt)}</span><form action="/admin/dismiss-report" method="POST" class="admin-action-form">${this.csrf(csrf)}<input type="hidden" name="reportId" value="${escapeHTML(report.id)}"><button type="submit">Dismiss</button></form></li>`).join('');
    const bans = activeBans.map(ban => `<li>${escapeHTML(ban.reason)} — ${ban.expiresAt ? `until ${formatDate(ban.expiresAt)}` : 'permanent'}<form action="/admin/unban" method="POST" class="admin-action-form">${this.csrf(csrf)}<input type="hidden" name="banId" value="${escapeHTML(ban.id)}"><button type="submit">Unban</button></form></li>`).join('');
    const threads = data.threads.map(thread => `<article class="admin-thread"><h2>Thread No.${thread.id}</h2>${this.adminPost(thread, thread, csrf, true)}${thread.replies.length ? `<div class="admin-reply-list">${thread.replies.map(reply => this.adminPost(reply, thread, csrf)).join('')}</div>` : '<p class="admin-muted">No replies.</p>'}</article>`).join('');
    const logs = data.moderationLog.slice(-20).reverse().map(log => `<li>${formatDate(log.createdAt)} — ${escapeHTML(log.detail)}</li>`).join('');
    return this.adminShell(`Admin - ${this.config.board.title}`, `<section class="admin-panel"><div class="admin-toolbar"><div><h1>Admin</h1><p>${escapeHTML(`${data.threads.length} threads · ${data.reports.length} reports`)}</p></div><div class="admin-toolbar-actions"><a href="/">Board</a><form action="/admin/logout" method="POST">${this.csrf(csrf)}<button type="submit">Log out</button></form></div></div><section class="admin-section"><h2>Reports (${data.reports.length})</h2><ul class="admin-list">${reports || '<li>No open reports.</li>'}</ul></section><section class="admin-section"><h2>Active bans (${activeBans.length})</h2><ul class="admin-list">${bans || '<li>No active bans.</li>'}</ul></section><section class="admin-section"><h2>Threads</h2>${threads || '<p>No threads.</p>'}</section><section class="admin-section"><h2>Recent moderation</h2><ul class="admin-list">${logs || '<li>No actions yet.</li>'}</ul></section></section>`);
  }
}

module.exports = { Renderer };
