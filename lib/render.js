'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TURNSTILE_ORIGIN } = require('./anti-abuse');
const { groupBoardsByCategory } = require('./boards');
const { buildPostIndex, formatComment, formatFortune, quoteHref } = require('./markup');
const { postAttachments } = require('./post-media');
const { ROLES, canAssignRole, canManageAccount, roleLabel, staffCan } = require('./staff');
const { Translator } = require('./i18n');
const { escapeHTML, formatBytes, previewText, relativeTime, timestampMilliseconds } = require('./utils');
const MEDIA_PATH_PATTERN = /^src\/[a-z0-9][a-z0-9._-]{0,199}\.(?:jpe?g|png|gif|webp|webm|mp4)$/i;

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil((Number(milliseconds) || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function mediaSource(relativePath) {
  const value = String(relativePath || '');
  return MEDIA_PATH_PATTERN.test(value) ? `/${value}` : '';
}

class Renderer {
  constructor(config, stateProvider = null, translator = null) {
    this.config = config;
    this.stateProvider = stateProvider;
    this.i18n = translator || new Translator(config);
  }

  t(key, variables = {}) {
    return escapeHTML(this.i18n.t(key, variables));
  }

  formatDate(timestamp) {
    return escapeHTML(this.i18n.formatDate(timestamp));
  }

  timeHTML(timestamp, className = '') {
    const milliseconds = timestampMilliseconds(timestamp);
    const safeClass = String(className || '').split(/\s+/)
      .filter(value => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value))
      .join(' ');
    const classAttribute = safeClass ? ` class="${safeClass}"` : '';
    if (milliseconds === null) return `<time${classAttribute}>Unknown time</time>`;
    const exact = this.i18n.formatDate(milliseconds);
    const relative = relativeTime(milliseconds);
    return `<time${classAttribute} datetime="${new Date(milliseconds).toISOString()}" title="${escapeHTML(exact)}" aria-label="${escapeHTML(`${relative}. Exact time: ${exact}`)}">${escapeHTML(relative)}</time>`;
  }

  presentationState() {
    if (!this.stateProvider) return null;
    try {
      return this.stateProvider();
    } catch {
      return null;
    }
  }

  customization() {
    return this.presentationState()?.customization || {};
  }

  hasBanner() {
    return fs.existsSync(path.join(this.config.rootDir, 'banner.png'));
  }

  siteTitle() {
    return this.customization().title
      || this.config.site?.title
      || this.config.board?.title
      || 'ChikoChan';
  }

  siteDescription() {
    return this.customization().description
      || this.config.site?.description
      || this.config.board?.description
      || 'A simple imageboard.';
  }

  siteAnnouncement() {
    return this.customization().announcement
      || this.config.site?.announcement
      || this.config.board?.announcement
      || '';
  }

  sitePages() {
    const pages = Object.fromEntries(Object.entries(this.config.site?.pages || {}).map(([key, page]) => [key, {
      ...page,
      path: `/${key}`
    }]));
    for (const page of this.customization().pages || []) {
      if (!page.showInFooter) continue;
      pages[`custom:${page.slug}`] = { ...page, path: `/pages/${page.slug}` };
    }
    return pages;
  }

  anonymousName(board = null) {
    return board?.settings?.anonymousName
      || this.config.board?.anonymousName
      || this.config.anonymousName
      || 'Anonymous';
  }

  siteBannerHTML() {
    const logoPath = this.customization().logoPath || (this.hasBanner() ? '/banner.png' : '');
    if (!logoPath) return '';
    return `<div class="site-banner"><img class="site-banner-img" src="${escapeHTML(logoPath)}" alt="${escapeHTML(this.siteTitle())} banner"></div>`;
  }

  faviconPath() {
    return this.customization().faviconPath || '/chikki.ico';
  }

  customNavigationHTML() {
    const links = (this.customization().navigation || [])
      .map(link => `<a href="${escapeHTML(link.href)}">${escapeHTML(link.label)}</a>`)
      .join(' ');
    return links ? `<nav class="custom-navigation" aria-label="site navigation">${links}</nav>` : '';
  }

  themeDeclarations(theme = {}) {
    const variables = {
      background: '--bg-color',
      text: '--text-color',
      link: '--link-color',
      linkHover: '--link-hover-color',
      boardTitle: '--board-title-color',
      subject: '--subject-color',
      name: '--name-color',
      formHeader: '--form-label-bg',
      formBackground: '--form-bg',
      formBorder: '--form-border',
      replyBackground: '--reply-bg',
      replyBorder: '--reply-border',
      quote: '--quote-text-color',
      quoteLink: '--quotelink-color',
      panelHeader: '--panel-header-bg'
    };
    const declarations = [];
    for (const [key, variable] of Object.entries(variables)) {
      if (/^#[a-f0-9]{6}$/i.test(String(theme[key] || ''))) declarations.push(`${variable}:${theme[key]}`);
    }
    if (theme.background) declarations.push('--bg-gradient:none');
    return declarations.join(';');
  }

  customStyles() {
    const state = this.presentationState() || {};
    const blocks = [];
    const global = this.themeDeclarations(state.customization?.theme);
    if (global) blocks.push(`:root{${global}}`);
    for (const board of state.boards || []) {
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(String(board.uri || ''))) continue;
      const declarations = this.themeDeclarations(board.appearance?.theme);
      if (declarations) blocks.push(`body[data-board="${board.uri}"]{${declarations}}`);
    }
    return `${blocks.join('\n')}\n`;
  }

  boardPath(board) {
    return `/${board.uri}/`;
  }

  threadPath(board, threadId) {
    return `/${board.uri}/thread/${threadId}`;
  }

  themeToggle() {
    return `<button class="theme-toggle" type="button" aria-label="${this.t('theme.toggle')}">${this.t('theme.dark')}</button>`;
  }

  boardNav(stats, board, active = 'board') {
    const boardHref = this.boardPath(board);
    const boardName = escapeHTML(boardHref);
    const boardLink = active === 'board' ? `<strong>${boardName}</strong>` : `<a href="${boardHref}">${boardName}</a>`;
    const catalogHref = `/${board.uri}/catalog`;
    const catalog = active === 'catalog' ? `<strong>${this.t('nav.catalog')}</strong>` : `<a href="${catalogHref}">${this.t('nav.catalog')}</a>`;
    const archiveHref = `/${board.uri}/archive`;
    const archive = active === 'archive' ? `<strong>${this.t('nav.archive')}</strong>` : `<a href="${archiveHref}">${this.t('nav.archive')}</a>`;
    const rulesHref = `/${board.uri}/rules`;
    const rules = active === 'rules' ? `<strong>${this.t('nav.rules')}</strong>` : `<a href="${rulesHref}">${this.t('nav.rules')}</a>`;
    const search = this.config.features.search
      ? (active === 'search' ? ` / <strong>${this.t('nav.search')}</strong>` : ` / <a href="/search">${this.t('nav.search')}</a>`)
      : '';
    return `
  <nav class="board-list" aria-label="board navigation">
    <span class="board-index">[ ${boardLink} / ${catalog} / ${archive} / ${rules}${search} / <a href="${boardHref}#post-form">${this.t('nav.post')}</a> ] [ <span>${escapeHTML(stats.line)}</span> ]</span>
    <span class="board-extras">${this.themeToggle()} <a class="home-link" href="/">[${this.t('nav.home')}]</a></span>
  </nav>`;
  }

  boardHeader(board) {
    const announcement = this.siteAnnouncement()
      ? `<aside class="announcement">${escapeHTML(this.siteAnnouncement())}</aside>`
      : '';
    const boardBanner = board.appearance?.bannerPath
      ? `<img class="board-banner-img" src="${escapeHTML(board.appearance.bannerPath)}" alt="${escapeHTML(board.name)} board banner">`
      : '';
    const bannerText = board.appearance?.bannerText
      ? `<p class="board-banner-text">${escapeHTML(board.appearance.bannerText)}</p>`
      : '';
    const boardTags = Array.isArray(board.tags) && board.tags.length
      ? `<p class="board-tags">Tags: ${board.tags.map(tag => `<span class="board-tag">${escapeHTML(tag)}</span>`).join(' ')}</p>`
      : '';
    return `
  <header>
    ${boardBanner}
    <h1>${escapeHTML(this.boardPath(board))} - ${escapeHTML(board.name)}</h1>
    <p>${escapeHTML(board.description || this.siteDescription())}</p>
    ${bannerText}
    ${boardTags}
  </header>
  ${announcement}`;
  }

  siteHeader() {
    const banner = this.siteBannerHTML();
    const announcement = this.siteAnnouncement()
      ? `<aside class="site-announcement">${escapeHTML(this.siteAnnouncement())}</aside>`
      : '';
    const boards = this.presentationState()?.boards || [];
    const overboardHref = boards.some(board => board.enabled !== false && board.sfw === false)
      ? '/overboard/sfw'
      : '/overboard';
    return `
  <header class="site-header">
    <div class="site-top-bar"><a href="/">[${this.t('nav.home')}]</a> <a href="${overboardHref}">[${this.t('nav.overboard')}]</a>${this.themeToggle()}</div>
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
    const turnstileScript = this.config.antiAbuse.turnstile.enabled
      && body.includes('data-turnstile-widget')
      ? `<script src="${TURNSTILE_ORIGIN}/turnstile/v0/api.js?render=explicit" defer></script>`
      : '';
    return `<!DOCTYPE html>
<html lang="${escapeHTML(this.i18n.language)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${escapeHTML(board.description || this.siteDescription())}">
  <title>${escapeHTML(title)}</title>
  <link rel="icon" href="${escapeHTML(this.faviconPath())}">
  ${feedLink}
  <link rel="stylesheet" href="/style.css">
  <link rel="stylesheet" href="/custom.css">
</head>
<body ${attributes}>
  ${this.boardNav(stats, board, active)}
  ${this.customNavigationHTML()}
  ${this.boardHeader(board)}
  ${body}
  ${turnstileScript}
  <script src="/client.js" defer></script>
</body>
</html>`;
  }

  siteShell(title, body) {
    const turnstileScript = this.config.antiAbuse.turnstile.enabled
      && body.includes('data-turnstile-widget')
      ? `<script src="${TURNSTILE_ORIGIN}/turnstile/v0/api.js?render=explicit" defer></script>`
      : '';
    return `<!DOCTYPE html>
<html lang="${escapeHTML(this.i18n.language)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${escapeHTML(this.siteDescription())}">
  <title>${escapeHTML(title)}</title>
  <link rel="icon" href="${escapeHTML(this.faviconPath())}">
  <link rel="stylesheet" href="/style.css">
  <link rel="stylesheet" href="/custom.css">
</head>
<body class="site-home">
  ${this.siteHeader()}
  ${this.customNavigationHTML()}
  ${body}
  ${turnstileScript}
  <script src="/client.js" defer></script>
</body>
</html>`;
  }

  boardSetting(board, key, fallback) {
    return Object.hasOwn(board?.settings || {}, key) ? board.settings[key] : fallback;
  }

  captchaFormAttribute(board, threadId = 0) {
    const attributes = [];
    if (this.config.antiAbuse.turnstile.enabled) attributes.push('data-turnstile-form');
    if (this.config.postingAuthorization.enabled) {
      attributes.push('data-posting-authorization');
      attributes.push(`data-board-uri="${escapeHTML(board.uri)}"`);
      attributes.push(`data-thread-id="${Number(threadId) || 0}"`);
    }
    return attributes.length ? ` ${attributes.join(' ')}` : '';
  }

  captchaHTML(board, threadId = 0, returnTo = '') {
    if (!this.config.antiAbuse.turnstile.enabled) return '';
    const fallback = `/posting-authorizations/new?board=${encodeURIComponent(board.uri)}`
      + `&threadId=${Number(threadId) || 0}&returnTo=${encodeURIComponent(returnTo || this.boardPath(board))}`;
    return `<div class="turnstile-widget" data-turnstile-widget data-sitekey="${escapeHTML(this.config.antiAbuse.turnstile.siteKey)}" data-action="post"><span class="captcha-status">${this.t('captcha.loads_on_use')}</span></div><noscript><p class="captcha-noscript">${this.t('captcha.javascript_required')} <a href="${escapeHTML(fallback)}">Open the separate authorization step</a>.</p></noscript>`;
  }

  nameHTML(post, board = null) {
    const name = escapeHTML(post.name || this.anonymousName(board));
    const trip = post.trip ? ` <span class="trip postertrip">${escapeHTML(post.trip)}</span>` : '';
    const identity = post.posterId ? ` <span class="poster-id posteruid">ID:${escapeHTML(post.posterId)}</span>` : '';
    const sage = post.sage ? ' <span class="sage" title="This reply did not bump the thread">sage</span>' : '';
    const capcode = ROLES.includes(post.capcode)
      ? ` <span class="capcode" title="Verified ${escapeHTML(roleLabel(post.capcode))} post">## ${escapeHTML(roleLabel(post.capcode))}</span>`
      : '';
    return `<span class="nameBlock"><span class="name">${name}</span>${trip}${identity}${capcode}${sage}</span>`;
  }

  postMenuHTML(post, thread, board, isOp) {
    const threadUrl = this.threadPath(board, thread.id);
    const report = this.reportControl(post, board, thread.id);
    return `<details class="post-menu">
          <summary aria-label="${this.t('post.actions_for', { id: post.id })}" title="${this.t('post.actions')}"><span aria-hidden="true">▶</span></summary>
          <section class="post-menu-panel" aria-label="${this.t('post.actions_for', { id: post.id })}">
            ${isOp ? `<a class="thread-view-link" href="${threadUrl}">${this.t('post.view_thread')}</a>` : ''}
            <button class="post-hide-button" type="button" data-hide-post="${post.id}">${this.t('post.hide')}</button>
            ${report}
          </section>
        </details>`;
  }

  postHeader(post, thread, board, isOp, postIndex) {
    const threadUrl = this.threadPath(board, thread.id);
    const subject = isOp && post.title
      ? `<a class="subject" href="${threadUrl}">${escapeHTML(post.title)}</a>`
      : '';
    const statuses = isOp
      ? [thread.sticky ? '<span class="post-status" title="Sticky">[Sticky]</span>' : '',
        thread.locked ? '<span class="post-status" title="Locked">[Locked]</span>' : '',
        thread.cyclic ? '<span class="post-status" title="Cyclic">[Cyclic]</span>' : '',
        thread.archived ? '<span class="post-status archived-status" title="Archived read-only thread">[Archived]</span>' : ''].join('')
      : '';
    const quoteTarget = thread.archived
      ? `${threadUrl}#p${post.id}`
      : `${threadUrl}?quote=${post.id}#reply-form-${thread.id}`;
    const edited = post.editedAt
      ? ` <time class="post-edited" datetime="${new Date(post.editedAt).toISOString()}" title="Edited ${this.formatDate(post.editedAt)}">[Edited]</time>`
      : '';
    return `
      <div class="${isOp ? 'thread-header' : 'reply-header'} postInfo desktop" id="pi${post.id}">
        <input class="delete" type="checkbox" name="postIds" value="${post.id}" form="delete-form" aria-label="Select post No.${post.id} for deletion">
        ${this.postMenuHTML(post, thread, board, isOp)}
        ${subject}
        ${this.nameHTML(post, board)}
        ${this.timeHTML(post.createdAt, 'date-time dateTime')}
        <span class="postNum desktop"><a class="post-id-link" href="${threadUrl}#p${post.id}" data-post-id="${post.id}">No.</a><a class="post-id-link post-id" href="${quoteTarget}"${thread.archived ? '' : ` data-thread-id="${thread.id}" data-quote-id="${post.id}"`}>${post.id}</a></span>
        ${this.backlinksHTML(post, board, thread.id, postIndex)}
        ${thread.archived ? '' : `<a class="quote-reply-link replylink" href="${quoteTarget}" data-thread-id="${thread.id}" data-quote-id="${post.id}">${this.t('post.reply')}</a>`}
        ${edited}
        ${statuses}
      </div>`;
  }

  attachmentHTML(attachment, postId, index, isReply = false) {
    const source = mediaSource(attachment.image);
    if (!source) return '<div class="file-info fileText">File unavailable.</div>';
    const thumbnailSource = mediaSource(attachment.thumbnail) || source;
    const safeSource = escapeHTML(source);
    const safeThumbnailSource = escapeHTML(thumbnailSource);
    const name = escapeHTML(attachment.imageName || 'image');
    const size = escapeHTML(attachment.imageBytes ? formatBytes(attachment.imageBytes) : (attachment.imageSize || 'unknown size'));
    const dimensions = attachment.width && attachment.height ? `, ${Number(attachment.width)}x${Number(attachment.height)}` : '';
    const duration = attachment.durationMs ? `, ${formatDuration(attachment.durationMs)}` : '';
    const thumbnailDimensions = (attachment.thumbnailWidth || attachment.width) && (attachment.thumbnailHeight || attachment.height)
      ? ` width="${Number(attachment.thumbnailWidth || attachment.width)}" height="${Number(attachment.thumbnailHeight || attachment.height)}"`
      : '';
    const spoilerClass = attachment.spoiler ? ' spoiler-image' : '';
    const download = `<a class="file-download" href="${safeSource}" download="${name}">Download</a>`;
    const idSuffix = index ? `-${index + 1}` : '';
    if (attachment.mediaKind === 'video' || String(attachment.imageMime || '').startsWith('video/')) {
      const poster = mediaSource(attachment.thumbnail) ? ` poster="${safeThumbnailSource}"` : '';
      const spoilerButton = attachment.spoiler
        ? '<button class="media-spoiler-button" type="button" data-reveal-spoiler>Reveal spoiler</button>'
        : '';
      return `
      <div class="file-info fileText" id="fT${postId}${idSuffix}">File: <a href="${safeSource}" target="_blank" rel="noopener">${name}</a> (${size}${dimensions}${duration}) ${download}${attachment.spoiler ? ' <strong>Spoiler</strong>' : ''}</div>
      <div class="image-box video-box file${isReply ? ' image-box-reply' : ''}${spoilerClass}">
        ${spoilerButton}
        <video class="post-video" controls preload="metadata" playsinline${poster}${thumbnailDimensions}>
          <source src="${safeSource}" type="${escapeHTML(attachment.imageMime || 'video/mp4')}">
          Your browser cannot play this video. <a href="${safeSource}" download="${name}">Download it instead</a>.
        </video>
      </div>`;
    }
    return `
      <div class="file-info fileText" id="fT${postId}${idSuffix}">File: <a href="${safeSource}" target="_blank" rel="noopener">${name}</a> (${size}${dimensions}) ${download}${attachment.spoiler ? ' <strong>Spoiler</strong>' : ''}</div>
      <div class="image-box file${isReply ? ' image-box-reply' : ''}${spoilerClass}">
        <a class="fileThumb" id="f${postId}${idSuffix}" href="${safeSource}" target="_blank" rel="noopener">
          <img class="post-img" src="${safeThumbnailSource}" alt="${attachment.spoiler ? 'spoilered image' : 'attached image'}"${thumbnailDimensions} loading="lazy" decoding="async" data-expand-image data-full-src="${safeSource}" data-thumbnail-src="${safeThumbnailSource}">
        </a>
      </div>`;
  }

  imageHTML(post, isReply = false) {
    if (post.imageDeleted) return '<div class="file-info fileText">File deleted.</div>';
    const attachments = postAttachments(post);
    if (!attachments.length) return '';
    return `<div class="post-attachments${attachments.length > 1 ? ' post-attachments-multiple' : ''}" data-attachment-count="${attachments.length}">${attachments.map((attachment, index) =>
      `<div class="post-attachment">${this.attachmentHTML(attachment, post.id, index, isReply)}</div>`
    ).join('')}</div>`;
  }

  postBodyHTML(post, message, isReply = false) {
    const attachments = this.imageHTML(post, isReply);
    const classes = `post-body${attachments ? ' post-body-with-media' : ''}`;
    const commentClass = `comment${isReply ? '' : ' op-comment'} postMessage`;
    return `<div class="${classes}">${attachments}<blockquote class="${commentClass}" id="m${post.id}">${message}</blockquote></div>`;
  }

  uploadAccept(board = null) {
    const allowVideo = this.boardSetting(board, 'allowVideoUploads', this.config.features.videoUploads);
    return this.config.media.videoAvailable && allowVideo
      ? 'image/jpeg,image/png,image/gif,image/webp,video/webm,video/mp4'
      : 'image/jpeg,image/png,image/gif,image/webp';
  }

  uploadHint(board = null) {
    const imageHint = `JPG, PNG, GIF, WEBP. Max ${formatBytes(this.config.limits.maxFileBytes)}.`;
    const allowVideo = this.boardSetting(board, 'allowVideoUploads', this.config.features.videoUploads);
    const base = this.config.media.videoAvailable && allowVideo
      ? `${imageHint} WEBM or MP4 (VP8/VP9 or H.264), max ${formatBytes(this.config.limits.maxVideoBytes)} and ${this.config.limits.maxVideoDurationSeconds}s.`
      : imageHint;
    const maximum = this.boardSetting(board, 'maxFilesPerPost', this.config.limits.maxFilesPerPost);
    return maximum > 1 ? `Up to ${maximum} files. ${base}` : base;
  }

  uploadMultiple(board = null) {
    return this.boardSetting(board, 'maxFilesPerPost', this.config.limits.maxFilesPerPost) > 1
      ? ' multiple'
      : '';
  }

  backlinksHTML(post, board, currentThreadId, postIndex) {
    if (!post.backlinks?.length) return '';
    const links = post.backlinks.map(backlink => {
      const target = postIndex.get(Number(backlink.id));
      if (!target) return '';
      const href = quoteHref(board.uri, currentThreadId, target);
      return `<a class="backlink quotelink" href="${href}" data-post-id="${target.post.id}">&gt;&gt;${target.post.id}</a>`;
    }).filter(Boolean).join(' ');
    return links ? `<span class="backlinks" aria-label="Replies to this post">${links}</span>` : '';
  }

  reportControl(post, board, threadId) {
    if (!this.config.features.reports) return '';
    const categories = this.config.reports.categories.map(category =>
      `<option value="${escapeHTML(category.id)}"${category.id === this.config.reports.defaultCategory ? ' selected' : ''}>${escapeHTML(category.label)}</option>`
    ).join('');
    return `
      <details class="report-control">
        <summary>${this.t('post.report')}</summary>
        <form action="/report" method="POST">
          <input type="hidden" name="postId" value="${post.id}">
          <input type="hidden" name="redirectTo" value="${this.threadPath(board, threadId)}#p${post.id}">
          <label>${this.t('form.category')} <select name="category">${categories}</select></label>
          <label>${this.t('form.reason')} <input type="text" name="reason" maxlength="500" required></label>
          <button type="submit">${this.t('post.submit_report')}</button>
        </form>
      </details>`;
  }

  replyHTML(reply, thread, postIndex, board) {
    const comment = formatComment(reply.comment, {
      postIndex,
      boardUri: board.uri,
      threadId: thread.id
    });
    const message = [formatFortune(reply.fortune), comment].filter(Boolean).join('<br>');
    return `
    <div class="reply-container postContainer replyContainer" id="pc${reply.id}" data-no="${reply.id}">
      <span class="reply-side-prefix">&gt;&gt;</span>
      <div class="reply post" id="p${reply.id}">
        ${this.postHeader(reply, thread, board, false, postIndex)}
        ${this.postBodyHTML(reply, message, true)}
      </div>
    </div>`;
  }

  replyForm(thread, board, options = {}) {
    if (thread.archived) return '<p class="thread-locked-message archived-message">This thread is archived and read-only.</p>';
    if (thread.locked) return '<p class="thread-locked-message">This thread is locked. No new replies may be posted.</p>';
    const open = options.open ? ' open' : '';
    const allowSage = this.boardSetting(board, 'allowSage', true);
    const allowSpoilers = this.boardSetting(board, 'allowSpoilers', this.config.features.spoilerImages);
    const returnTo = `${this.threadPath(board, thread.id)}#reply-form-${thread.id}`;
    const captcha = this.captchaHTML(board, thread.id, returnTo);
    return `
    <details class="reply-form-container" id="reply-form-${thread.id}"${open}>
      <summary>${this.t('post.reply')}${thread.replies.length ? ` (${thread.replies.length})` : ''}</summary>
      <form class="reply-form" action="/${board.uri}/post?threadId=${thread.id}" method="POST" enctype="multipart/form-data"${this.captchaFormAttribute(board, thread.id)}>
        <input type="hidden" name="board" value="${escapeHTML(board.uri)}">
        <input type="hidden" name="mode" value="regist">
        <input type="hidden" name="resto" value="${thread.id}">
        <input type="hidden" name="redirectTo" value="${this.threadPath(board, thread.id)}">
        <input class="honeypot-field" type="text" name="website" autocomplete="off" tabindex="-1" aria-hidden="true">
        <table class="reply-form-table"><tbody>
          <tr><td class="label"><label for="reply-name-${thread.id}">${this.t('form.name')}</label></td><td><input type="text" id="reply-name-${thread.id}" name="name" maxlength="${this.config.limits.maxNameLength}" placeholder="${escapeHTML(this.anonymousName(board))}"></td></tr>
          ${allowSage ? `<tr><td class="label"><label for="reply-option-${thread.id}">${this.t('form.options')}</label></td><td><select id="reply-option-${thread.id}" name="email"><option value="">${this.t('form.none')}</option><option value="sage">${this.t('form.sage')}</option></select></td></tr>` : ''}
          <tr><td class="label"><label for="reply-comment-${thread.id}">${this.t('form.comment')}</label></td><td><textarea id="reply-comment-${thread.id}" name="com" maxlength="${this.config.limits.maxCommentLength}" placeholder="${this.t('form.write_reply')}"></textarea></td></tr>
          <tr><td class="label"><label for="reply-image-${thread.id}">${this.t('form.file')}</label></td><td><input type="file" id="reply-image-${thread.id}" name="upfile" accept="${this.uploadAccept(board)}"${this.uploadMultiple(board)}> ${allowSpoilers ? `<label class="inline-option"><input type="checkbox" name="spoiler" value="1"> ${this.t('form.spoiler')}</label>` : ''}<span class="field-hint">${this.uploadHint(board)}</span></td></tr>
          ${captcha ? `<tr><td class="label">${this.t('form.verify')}</td><td>${captcha}</td></tr>` : ''}
          <tr><td class="label"><label for="reply-password-${thread.id}">${this.t('form.password')}</label></td><td><input class="post-password" type="password" id="reply-password-${thread.id}" name="pwd" maxlength="100" autocomplete="new-password"> <span class="field-hint">${this.t('form.for_deletion')}</span></td></tr>
          <tr><td class="label"></td><td><input type="submit" value="${this.t('form.post_reply')}"></td></tr>
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
    const message = [formatFortune(thread.fortune), comment].filter(Boolean).join('<br>');
    return `
    <article class="thread" id="t${thread.id}" data-board="${escapeHTML(board.uri)}" data-thread-id="${thread.id}">
      <div class="postContainer opContainer" id="pc${thread.id}" data-no="${thread.id}">
        <div class="post op" id="p${thread.id}">
          ${this.postHeader(thread, thread, board, true, postIndex)}
          ${this.postBodyHTML(thread, message)}
        </div>
      </div>
      ${omitted ? `<p class="omitted-replies omitted summary desktop">${omitted} repl${omitted === 1 ? 'y' : 'ies'} omitted. <a href="${this.threadPath(board, thread.id)}">Click here</a> to view.</p>` : ''}
      ${shown.length ? `<div class="replies">${shown.map(reply => this.replyHTML(reply, thread, postIndex, board)).join('')}</div>` : ''}
      ${this.replyForm(thread, board, { open: options.replyFormOpen })}
    </article>
    <hr>`;
  }

  newThreadForm(board) {
    const required = this.boardSetting(board, 'requireImageForThread', this.config.features.requireImageForThread) ? ' required' : '';
    const allowSpoilers = this.boardSetting(board, 'allowSpoilers', this.config.features.spoilerImages);
    const captcha = this.captchaHTML(board, 0, `${this.boardPath(board)}#post-form`);
    return `
  <div class="post-form-wrapper">
    <form id="post-form" name="post" action="/${board.uri}/post?threadId=0" method="POST" enctype="multipart/form-data"${this.captchaFormAttribute(board, 0)}>
      <input type="hidden" name="board" value="${escapeHTML(board.uri)}">
      <input type="hidden" name="mode" value="regist">
      <input type="hidden" name="resto" value="0">
      <input class="honeypot-field" type="text" name="website" autocomplete="off" tabindex="-1" aria-hidden="true">
      <table class="post-form-table"><tbody>
        <tr><td class="label"><label for="name">${this.t('form.name')}</label></td><td><input type="text" id="name" name="name" maxlength="${this.config.limits.maxNameLength}" placeholder="${escapeHTML(this.anonymousName(board))}"></td></tr>
        <tr><td class="label"><label for="title">${this.t('form.subject')}</label></td><td><input type="text" id="title" name="sub" maxlength="${this.config.limits.maxSubjectLength}" placeholder="${this.t('form.optional')}"> <input type="submit" value="${this.t('form.post')}"></td></tr>
        <tr><td class="label"><label for="comment">${this.t('form.comment')}</label></td><td><textarea id="comment" name="com" maxlength="${this.config.limits.maxCommentLength}" placeholder="${this.t('form.write_something')}"></textarea></td></tr>
        <tr><td class="label"><label for="image">${this.t('form.file')}</label></td><td><input type="file" id="image" name="upfile" accept="${this.uploadAccept(board)}"${this.uploadMultiple(board)}${required}> ${allowSpoilers ? `<label class="inline-option"><input type="checkbox" name="spoiler" value="1"> ${this.t('form.spoiler')}</label>` : ''}<span class="field-hint">${this.uploadHint(board)}</span></td></tr>
        ${captcha ? `<tr><td class="label">${this.t('form.verify')}</td><td>${captcha}</td></tr>` : ''}
        <tr><td class="label"><label for="password">${this.t('form.password')}</label></td><td><input class="post-password" type="password" id="password" name="pwd" maxlength="100" autocomplete="new-password"> <span class="field-hint">${this.t('form.used_to_delete')}</span></td></tr>
      </tbody></table>
    </form>
  </div>`;
  }

  deletionForm() {
    if (!this.config.features.userDeletion) return '';
    return `
    <form class="delete-form" id="delete-form" action="/delete" method="POST">
      <strong>${this.t('form.delete_post')}</strong>
      <label>${this.t('form.password')} <input class="post-password" type="password" name="pwd" maxlength="100" autocomplete="current-password"></label>
      <label><input type="checkbox" name="fileOnly" value="1"> ${this.t('form.attachments_only')}</label>
      <button type="submit">${this.t('form.delete')}</button>
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

  queryPagination(page, totalPages, pathname, params = {}) {
    if (totalPages <= 1) return '';
    const links = [];
    for (let index = 1; index <= totalPages; index += 1) {
      const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== '' && value !== undefined));
      if (index > 1) query.set('page', String(index));
      const href = `${pathname}${query.size ? `?${query}` : ''}`;
      links.push(index === page ? `<strong>[${index}]</strong>` : `<a href="${escapeHTML(href)}">[${index}]</a>`);
    }
    return `<nav class="pagination" aria-label="Result pages">${links.join(' ')}</nav>`;
  }

  adminPagination(page, totalPages, pathname, filters = {}) {
    if (totalPages <= 1) return '';
    const links = [];
    const start = Math.max(1, page - 4);
    const end = Math.min(totalPages, page + 4);
    for (let index = start; index <= end; index += 1) {
      const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== '' && value !== undefined));
      if (index > 1) query.set('page', String(index));
      const href = `${pathname}${query.size ? `?${query}` : ''}`;
      links.push(index === page ? `<strong>[${index}]</strong>` : `<a href="${escapeHTML(href)}">[${index}]</a>`);
    }
    return `<nav class="pagination" aria-label="Administrative result pages">${links.join(' ')}</nav>`;
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
    const previewSource = mediaSource(thread.thumbnail || (thread.mediaKind === 'video' ? '' : thread.image));
    const image = previewSource
      ? `<img class="catalog-thumb${thread.spoiler ? ' catalog-spoiler' : ''}" src="${escapeHTML(previewSource)}" alt="${escapeHTML(thread.mediaKind === 'video' ? 'video poster' : (thread.imageName || 'attached image'))}" loading="lazy">`
      : '<span class="catalog-no-thumb">no image</span>';
    return `
      <article class="catalog-card" data-catalog-text="${escapeHTML(`${thread.title || ''} ${thread.name || ''} ${thread.comment || ''}`.toLowerCase())}">
        <a class="catalog-thumb-link" href="${threadUrl}" title="Open thread No.${thread.id}">${image}</a>
        <div class="catalog-card-meta"><a class="catalog-post-id" href="${threadUrl}">No.${thread.id}</a><span>${thread.replies.length} repl${thread.replies.length === 1 ? 'y' : 'ies'}</span></div>
        <a class="catalog-subject" href="${threadUrl}">${escapeHTML(thread.title || 'No subject')}</a>
        <div class="catalog-name">${escapeHTML(thread.name || this.anonymousName(board))}</div>
        ${this.timeHTML(thread.createdAt, 'catalog-date')}
        <p class="catalog-preview"><a href="${threadUrl}">${escapeHTML(previewText(thread.comment))}</a></p>
      </article>`;
  }

  catalog(data, threads, board, stats, options = {}) {
    const content = threads.length
      ? `<div class="catalog-grid">${threads.map(thread => this.catalogItem(thread, board)).join('')}</div>`
      : '<div class="empty-state"><p>No threads in the catalog yet.</p></div>';
    return this.shell(
      `Catalog - ${board.name}`,
      'catalog',
      board,
      stats,
      `<main class="catalog-container"><div class="catalog-header-row"><h2>Catalog</h2><span>${escapeHTML(stats.line)}</span></div><div class="catalog-tools"><label>Filter this page <input id="catalog-filter" type="search" autocomplete="off"></label></div>${content}${this.queryPagination(Number(options.page) || 1, Number(options.totalPages) || 1, `/${board.uri}/catalog`)}</main>`
    );
  }

  archive(threads, board, stats, options = {}) {
    const rows = threads.map(thread => {
      const url = this.threadPath(board, thread.id);
      return `<tr><td><a href="${url}">No.${thread.id}</a></td><td><a href="${url}">${escapeHTML(thread.title || previewText(thread.comment, 90))}</a></td><td>${thread.replies.length}</td><td><time datetime="${new Date(thread.archivedAt).toISOString()}">${this.formatDate(thread.archivedAt)}</time></td></tr>`;
    }).join('');
    const content = rows
      ? `<div class="archive-table-wrapper"><table class="archive-table"><thead><tr><th>Thread</th><th>Subject</th><th>Replies</th><th>Archived</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<div class="empty-state"><p>No archived threads.</p></div>';
    return this.shell(
      `Archive - ${board.name}`,
      'archive',
      board,
      stats,
      `<main class="archive-container"><div class="catalog-header-row"><h2>Archive</h2><span>Read-only threads</span></div>${content}${this.queryPagination(Number(options.page) || 1, Number(options.totalPages) || 1, `/${board.uri}/archive`)}</main>`
    );
  }

  overboardItem(entry) {
    const { thread, board } = entry;
    const url = this.threadPath(board, thread.id);
    const attachment = entry.media || null;
    const previewSource = attachment
      ? mediaSource(attachment.thumbnail || (attachment.mediaKind === 'video' ? '' : attachment.image))
      : '';
    const label = `/${board.uri}/ thread No.${thread.id}`;
    const thumb = previewSource
      ? `<a class="overboard-thumb-link" href="${url}"><img class="overboard-thumb${attachment.spoiler ? ' overboard-spoiler' : ''}" src="${escapeHTML(previewSource)}" alt="${escapeHTML(`Media from ${label}`)}" loading="lazy" decoding="async"></a>`
      : '';
    const replies = thread.replies.length;
    return `<article class="overboard-thread">${thumb}<div class="overboard-thread-body"><div class="overboard-thread-meta"><a class="overboard-board" href="${this.boardPath(board)}">/${escapeHTML(board.uri)}/</a> <a class="overboard-subject" href="${url}">${escapeHTML(thread.title || 'No subject')}</a> ${this.timeHTML(thread.createdAt, 'overboard-date')} <span class="overboard-replies">${replies} repl${replies === 1 ? 'y' : 'ies'}</span></div><p class="overboard-preview"><a href="${url}">${escapeHTML(previewText(thread.comment, 200))}</a></p></div></article>`;
  }

  overboard(entries, options = {}) {
    const sfw = options.sfw === true;
    const tag = String(options.tag || '');
    const basePath = sfw ? '/overboard/sfw' : '/overboard';
    const tagQuery = tag ? `?tag=${encodeURIComponent(tag)}` : '';
    const toggle = sfw
      ? `<a href="/overboard${escapeHTML(tagQuery)}">Include NSFW boards</a>`
      : `<a href="/overboard/sfw${escapeHTML(tagQuery)}">SFW boards only</a>`;
    const stateBoards = (this.presentationState()?.boards || [])
      .filter(board => board.enabled !== false && (!sfw || board.sfw !== false));
    const tags = [...new Set(stateBoards.flatMap(board => Array.isArray(board.tags) ? board.tags : []))].sort();
    const tagLinks = tags.map(candidate => (candidate === tag
      ? `<strong>${escapeHTML(candidate)}</strong>`
      : `<a href="${basePath}?tag=${encodeURIComponent(candidate)}">${escapeHTML(candidate)}</a>`));
    const tagRow = tags.length
      ? `<p class="overboard-tags">Tags: [ <a href="${basePath}">all</a>${tagLinks.length ? ` / ${tagLinks.join(' / ')}` : ''} ]</p>`
      : '';
    const content = entries.length
      ? `<div class="overboard-list">${entries.map(entry => this.overboardItem(entry)).join('')}</div>`
      : '<div class="empty-state"><p>No threads to show.</p></div>';
    return this.siteShell(
      `${sfw ? 'SFW Overboard' : 'Overboard'} - ${this.siteTitle()}`,
      `<main class="overboard-container"><div class="catalog-header-row"><h2>${sfw ? 'SFW Overboard' : 'Overboard'}</h2><span>[ ${toggle} ]</span></div>${tagRow}${content}${this.queryPagination(Number(options.page) || 1, Number(options.totalPages) || 1, basePath, { tag })}</main>`
    );
  }

  boardRules(board, stats) {
    const items = board.rules.map((rule, index) => {
      const text = escapeHTML(rule.text).replace(/\n/g, '<br>');
      return `<li id="rule-${escapeHTML(rule.id)}"><span class="board-rule-number">${index + 1}.</span> <span>${text}</span></li>`;
    }).join('');
    const globalRules = this.sitePages().rules
      ? '<p class="board-rules-global">These board-specific rules supplement the <a href="/rules">global rules</a>.</p>'
      : '';
    const content = items
      ? `<ol class="board-rules-list">${items}</ol>`
      : '<p class="empty-state">This board has no additional board-specific rules.</p>';
    return this.shell(
      `Rules - ${board.name}`,
      'rules',
      board,
      stats,
      `<main class="board-rules-page"><section class="board-rules-panel"><h2>Rules for /${escapeHTML(board.uri)}/</h2>${globalRules}${content}<p>[ <a href="${this.boardPath(board)}">Return to board</a> ]</p></section></main>`
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
      return `<article class="search-result"><a class="post-id-link" href="${url}">No.${entry.post.id}</a> <span class="name">${escapeHTML(entry.post.name || this.anonymousName(board))}</span><blockquote class="comment">${formatted}</blockquote></article>`;
    }).join('');
    return this.siteShell(
      `Search - ${this.siteTitle()}`,
      `<main class="search-page"><form action="/search" method="GET"><label for="search-query">Search posts</label> <input id="search-query" type="search" name="q" maxlength="100" value="${escapeHTML(query)}"> <button type="submit">Search</button></form>${query ? `<p>${results.length} result${results.length === 1 ? '' : 's'} for “${escapeHTML(query)}”.</p>${cards || '<div class="empty-state">No matching posts.</div>'}` : '<p>Search subjects, names, and comments.</p>'}</main>`
    );
  }

  message(title, message, stats, returnTo = '/', options = {}) {
    const action = options.actionHref
      ? `<p><a href="${escapeHTML(options.actionHref)}">${escapeHTML(options.actionLabel || this.i18n.t('message.continue'))}</a></p>`
      : '';
    return this.siteShell(title, `<div class="error-card"><h2>${escapeHTML(title)}</h2><p>${escapeHTML(message)}</p>${action}<p>[ <a href="${escapeHTML(returnTo)}">${this.t('message.continue')}</a> ]</p></div>`);
  }

  appeal(context) {
    const reason = context.reason
      ? `<p><strong>Public reason:</strong> ${escapeHTML(context.reason)}</p>`
      : '<p>The detailed staff reason is private.</p>';
    const expiry = context.expiresAt
      ? `<p>This restriction expires ${this.formatDate(context.expiresAt)}.</p>`
      : '<p>This restriction has no automatic expiry.</p>';
    let content;
    if (context.status) {
      const note = context.staffNote ? `<p><strong>Staff response:</strong> ${escapeHTML(context.staffNote)}</p>` : '';
      content = `<p>Your appeal status is <strong>${escapeHTML(context.status)}</strong>.</p><blockquote>${escapeHTML(context.message)}</blockquote>${note}`;
    } else if (!context.active) {
      content = '<p>This restriction is no longer active, so no appeal is needed.</p>';
    } else {
      content = `<form action="/appeals/${escapeHTML(context.appealId)}" method="POST" class="appeal-form"><label for="appeal-message">Explain why the restriction should be reconsidered</label><textarea id="appeal-message" name="message" minlength="20" maxlength="2000" rows="8" required></textarea><button type="submit">Submit appeal</button></form>`;
    }
    return this.siteShell(
      `Appeal - ${this.siteTitle()}`,
      `<main class="home-container"><section class="site-info appeal-panel"><h2>Restriction appeal</h2>${reason}${expiry}${content}<p class="admin-muted">This form does not request or expose your IP address or staff account identities.</p></section></main>`
    );
  }

  postingAuthorizationPage(board, threadId, returnTo, error = '') {
    const captcha = this.captchaHTML(board, threadId, returnTo);
    const turnstileAttribute = this.config.antiAbuse.turnstile.enabled ? ' data-turnstile-form' : '';
    return this.siteShell(
      `Authorize posting - ${this.siteTitle()}`,
      `<main class="home-container authorization-page">
        <section class="site-info">
          <h1>Authorize posting on /${escapeHTML(board.uri)}/</h1>
          <p>Complete the short-lived posting check before selecting or uploading media. The authorization is single-use.</p>
          ${error ? `<p class="error-message" role="alert">${escapeHTML(error)}</p>` : ''}
          <form action="/posting-authorizations" method="POST"${turnstileAttribute}>
            <input type="hidden" name="board" value="${escapeHTML(board.uri)}">
            <input type="hidden" name="threadId" value="${Number(threadId) || 0}">
            <input type="hidden" name="returnTo" value="${escapeHTML(returnTo)}">
            ${captcha}
            <p><button type="submit">Authorize this post</button></p>
          </form>
        </section>
      </main>`
    );
  }

  adminShell(title, body) {
    return `<!DOCTYPE html>
<html lang="${escapeHTML(this.i18n.language)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHTML(title)}</title>
  <link rel="icon" href="${escapeHTML(this.faviconPath())}">
  <link rel="stylesheet" href="/style.css">
  <link rel="stylesheet" href="/custom.css">
</head>
<body>
  <div class="admin-top-bar"><a href="/">[${this.t('nav.home')}]</a>${this.themeToggle()}</div>
  <main class="admin-page">${body}</main>
  <script src="/client.js" defer></script>
</body>
</html>`;
  }

  adminLogin(error = '') {
    return this.adminShell(`Admin - ${this.siteTitle()}`, `<section class="admin-panel admin-login-panel"><h1>Staff login</h1>${error ? `<p class="admin-error">${escapeHTML(error)}</p>` : ''}<form action="/admin/login" method="POST"><label for="admin-username">Username <span class="admin-muted">(leave blank for the environment administrator)</span></label><input type="text" id="admin-username" name="username" maxlength="32" autocomplete="username"><label for="admin-password">Password</label><input type="password" id="admin-password" name="password" autocomplete="current-password" required autofocus><label for="admin-mfa-code">Authentication or recovery code <span class="admin-muted">(when enabled)</span></label><input type="text" id="admin-mfa-code" name="mfaCode" maxlength="20" inputmode="numeric" autocomplete="one-time-code"><button type="submit">Log in</button></form><p class="admin-muted">[ <a href="/">Return to site</a> ]</p></section>`);
  }

  csrf(token) {
    return `<input type="hidden" name="csrf" value="${escapeHTML(token)}">`;
  }

  adminPost(post, thread, board, csrf, staff, isOp = false) {
    const controls = isOp && staffCan(staff, 'threads.manage', board.id) ? ['sticky', 'locked', 'cyclic', 'archived'].map(flag => `
      <form action="/admin/thread-setting" method="POST" class="admin-action-form">${this.csrf(csrf)}<input type="hidden" name="threadId" value="${thread.id}"><input type="hidden" name="flag" value="${flag}"><input type="hidden" name="value" value="${thread[flag] ? '0' : '1'}"><button type="submit">${thread[flag] ? 'Unset' : 'Set'} ${flag}</button></form>`).join('') : '';
    const attachments = postAttachments(post);
    const sanctionableFiles = attachments.filter(attachment => attachment.sha256);
    const fileHashSelect = sanctionableFiles.length
      ? `<select name="fileHash" aria-label="Upload to sanction">${sanctionableFiles.map((attachment, index) => `<option value="${escapeHTML(attachment.sha256)}">File ${index + 1}: ${escapeHTML(attachment.imageName || 'image')}</option>`).join('')}</select>`
      : '';
    const sanction = staffCan(staff, 'bans.manage', board.id)
      ? ((post.posterKey || sanctionableFiles.length)
        ? `<form action="/admin/sanction" method="POST" class="admin-action-form admin-ban-form">${this.csrf(csrf)}<input type="hidden" name="postId" value="${post.id}"><select name="kind"><option value="ban">Ban</option><option value="warning">Warning</option></select><select name="target">${post.posterKey ? '<option value="poster">Poster identity</option>' : ''}${sanctionableFiles.length ? '<option value="file">Upload hash</option>' : ''}</select>${fileHashSelect}${staff.scope === 'global' ? '<select name="scope"><option value="board">This board</option><option value="global">Global</option></select>' : '<input type="hidden" name="scope" value="board">'}<select name="duration"><option value="3600000">1 hour</option><option value="86400000">1 day</option><option value="604800000">1 week</option><option value="0">Permanent</option></select><input name="reason" maxlength="300" placeholder="Public reason" required><input name="moderatorNote" maxlength="500" placeholder="Private moderator note"><input type="hidden" name="reasonVisible" value="0"><label><input type="checkbox" name="reasonVisible" value="1" checked> Show reason</label><button type="submit" class="danger-button">Apply</button></form>`
        : '<span class="admin-muted">No sanctionable identity or upload hash</span>')
      : '';
    const fileDeletionControls = attachments.map((attachment, index) =>
      `<form action="/admin/delete" method="POST" class="admin-action-form admin-delete-form">${this.csrf(csrf)}<input type="hidden" name="postId" value="${post.id}"><input type="hidden" name="fileOnly" value="1"><input type="hidden" name="attachmentId" value="${escapeHTML(attachment.id)}"><input name="reason" maxlength="500" placeholder="Attachment removal reason"><button type="submit" class="danger-button">Trash file ${index + 1}: ${escapeHTML(attachment.imageName || 'image')}</button></form>`
    ).join('');
    const deletion = staffCan(staff, 'posts.delete', board.id)
      ? `<form action="/admin/delete" method="POST" class="admin-action-form admin-delete-form">${this.csrf(csrf)}<input type="hidden" name="postId" value="${post.id}"><input name="reason" maxlength="500" placeholder="Trash reason"><button type="submit" class="danger-button">Trash post</button></form>${fileDeletionControls}`
      : '';
    const editing = staffCan(staff, 'posts.edit', board.id)
      ? `<details class="admin-edit-control"><summary>Edit post</summary><form action="/admin/edit" method="POST" class="admin-edit-form">${this.csrf(csrf)}<input type="hidden" name="postId" value="${post.id}">${isOp ? `<label>Subject <input type="text" name="title" maxlength="${this.config.limits.maxSubjectLength}" value="${escapeHTML(post.title || '')}"></label>` : ''}<label>Comment <textarea name="comment" maxlength="${this.config.limits.maxCommentLength}">${escapeHTML(post.comment)}</textarea></label><label>Reason <input type="text" name="reason" minlength="3" maxlength="500" required></label><button type="submit">Save edit</button>${post.editCount ? ` <a href="/admin/revisions?postId=${post.id}">History (${post.editCount})</a>` : ''}</form></details>`
      : '';
    const staffReply = !thread.archived && staffCan(staff, 'posts.capcode', board.id)
      ? `<a class="admin-button-link" href="/admin/post?board=${encodeURIComponent(board.uri)}&threadId=${thread.id}">Staff reply</a>`
      : '';
    return `<div class="admin-post-summary"><div><strong>No.${post.id}${post.title ? ` — ${escapeHTML(post.title)}` : ''}</strong> <span class="admin-muted">by ${escapeHTML(post.name || this.anonymousName(board))}${post.capcode ? ` · ## ${escapeHTML(roleLabel(post.capcode))}` : ''} · ${this.timeHTML(post.createdAt, 'admin-post-date')}${post.editedAt ? ` · edited ${this.formatDate(post.editedAt)}` : ''}</span></div><p>${escapeHTML(previewText(post.comment, 240))}</p><div class="admin-post-actions">${deletion}${controls}${editing}${staffReply}${sanction}</div></div>`;
  }

  adminPostForm(board, thread, csrf, staff) {
    const isReply = Boolean(thread);
    const role = roleLabel(staff.role);
    const required = !isReply && this.boardSetting(board, 'requireImageForThread', this.config.features.requireImageForThread) ? ' required' : '';
    const allowSage = this.boardSetting(board, 'allowSage', true);
    const allowSpoilers = this.boardSetting(board, 'allowSpoilers', this.config.features.spoilerImages);
    return this.adminShell(
      `${isReply ? `Reply to No.${thread.id}` : 'New thread'} - Admin - ${this.siteTitle()}`,
      `<section class="admin-panel"><div class="admin-toolbar"><div><h1>${isReply ? `Reply to No.${thread.id}` : `New thread on /${escapeHTML(board.uri)}/`}</h1><p>Authenticated staff posting. Public posts disclose only the selected role capcode.</p></div><div class="admin-toolbar-actions"><a href="/admin">Dashboard</a><a href="${isReply ? this.threadPath(board, thread.id) : this.boardPath(board)}">View board</a></div></div><form class="admin-staff-post-form" action="/admin/post" method="POST" enctype="multipart/form-data">${this.csrf(csrf)}<input type="hidden" name="board" value="${escapeHTML(board.uri)}"><input type="hidden" name="resto" value="${isReply ? thread.id : 0}"><label>Name <input type="text" name="name" maxlength="${this.config.limits.maxNameLength}" placeholder="${escapeHTML(this.anonymousName(board))}"></label>${isReply ? '' : `<label>Subject <input type="text" name="sub" maxlength="${this.config.limits.maxSubjectLength}"></label>`}<label>Comment <textarea name="com" maxlength="${this.config.limits.maxCommentLength}"></textarea></label><label>File <input type="file" name="upfile" accept="${this.uploadAccept(board)}"${this.uploadMultiple(board)}${required}> <span class="field-hint">${this.uploadHint(board)}</span></label>${isReply && allowSage ? '<label>Options <select name="email"><option value="">none</option><option value="sage">sage (do not bump)</option></select></label>' : ''}<label class="inline-option"><input type="checkbox" name="capcode" value="1" checked> Display verified ## ${escapeHTML(role)} capcode</label>${allowSpoilers ? '<label class="inline-option"><input type="checkbox" name="spoiler" value="1"> Spoiler attachment</label>' : ''}<label>Deletion password <input type="password" name="pwd" maxlength="100" autocomplete="new-password"></label><button type="submit">${isReply ? 'Post staff reply' : 'Create staff thread'}</button></form></section>`
    );
  }

  adminDashboard(data, csrf, staff) {
    const boardMap = new Map(data.boards.map(board => [board.id, board]));
    const activeBans = data.bans.filter(ban => ban.active !== false && (!ban.expiresAt || ban.expiresAt > Date.now()));
    const openReports = data.reports.filter(report => report.status !== 'closed');
    const reports = openReports.slice(0, 20).map(report => {
      const thread = data.threads.find(t => t.id === report.threadId);
      const board = boardMap.get(report.boardId) || (thread ? boardMap.get(thread.boardId) : null) || data.boards[0];
      const target = thread && (thread.id === report.postId || thread.replies.some(reply => reply.id === report.postId));
      const targetHtml = target
        ? `<a href="${this.threadPath(board, report.threadId)}#p${report.postId}">No.${report.postId}</a>`
        : `<span>No.${report.postId} (deleted)</span>`;
      return `<li>${targetHtml}: ${escapeHTML(report.reason)} <span class="admin-muted">${this.formatDate(report.createdAt)}</span><form action="/admin/dismiss-report" method="POST" class="admin-action-form">${this.csrf(csrf)}<input type="hidden" name="reportId" value="${escapeHTML(report.id)}"><button type="submit">Dismiss</button></form></li>`;
    }).join('');
    const bans = activeBans.slice(0, this.config.limits.adminPageSize).map(ban => `<li><strong>${escapeHTML(ban.kind)}</strong> · ${escapeHTML(ban.target)} · ${escapeHTML(ban.scope === 'board' ? `/${ban.boardId}/` : 'global')} — ${escapeHTML(ban.reason)}${ban.moderatorNote ? ` <span class="admin-muted">(${escapeHTML(ban.moderatorNote)})</span>` : ''} — ${ban.kind === 'warning' ? 'pending delivery' : (ban.expiresAt ? `until ${this.formatDate(ban.expiresAt)}` : 'permanent')}<form action="/admin/unban" method="POST" class="admin-action-form">${this.csrf(csrf)}<input type="hidden" name="banId" value="${escapeHTML(ban.id)}"><button type="submit">Lift</button></form></li>`).join('');
    const dashboardThreads = [...data.threads]
      .sort((left, right) => Number(right.bumpedAt) - Number(left.bumpedAt))
      .slice(0, this.config.limits.adminPageSize);
    const threads = dashboardThreads.map(thread => {
      const board = boardMap.get(thread.boardId) || data.boards[0];
      return `<article class="admin-thread"><h2>Thread No.${thread.id} <span class="admin-muted">on /${escapeHTML(board.uri)}/${thread.archived ? ' · archived' : ''}</span></h2>${this.adminPost(thread, thread, board, csrf, staff, true)}${thread.replies.length ? `<div class="admin-reply-list">${thread.replies.map(reply => this.adminPost(reply, thread, board, csrf, staff)).join('')}</div>` : '<p class="admin-muted">No replies.</p>'}</article>`;
    }).join('');
    const logs = data.moderationLog.slice(-20).reverse().map(log => `<li>${this.formatDate(log.createdAt)} — ${escapeHTML(log.detail)}${log.actorName ? ` <span class="admin-muted">by ${escapeHTML(log.actorName)}</span>` : ''}</li>`).join('');
    const tools = [
      data.boards.some(board => staffCan(staff, 'posts.capcode', board.id)) ? `<a href="/admin/post?board=${encodeURIComponent(data.boards.find(board => staffCan(staff, 'posts.capcode', board.id)).uri)}">Staff post</a>` : '',
      staffCan(staff, 'reports.manage') ? '<a href="/admin/reports">Reports</a>' : '',
      staffCan(staff, 'reports.manage') ? '<a href="/admin/appeals">Appeals</a>' : '',
      staffCan(staff, 'posts.delete') ? '<a href="/admin/media">Media safety</a>' : '',
      staffCan(staff, 'posts.delete') ? '<a href="/admin/trash">Trash</a>' : '',
      staffCan(staff, 'posts.edit') ? '<a href="/admin/revisions">Edit history</a>' : '',
      staffCan(staff, 'boards.manage') ? '<a href="/admin/boards">Boards</a>' : '',
      staffCan(staff, 'site.manage') ? '<a href="/admin/customization">Customization</a>' : '',
      staffCan(staff, 'staff.manage') ? '<a href="/admin/staff">Staff</a>' : '',
      '<a href="/admin/account">Account</a>'
    ].filter(Boolean).join('');
    const identity = `${staff.displayName} · ${roleLabel(staff.role)}${staff.scope === 'boards' ? ` · ${staff.boardIds.map(id => `/${id}/`).join(', ')}` : ''}`;
    return this.adminShell(`Admin - ${this.siteTitle()}`, `<section class="admin-panel"><div class="admin-toolbar"><div><h1>Admin</h1><p>${escapeHTML(identity)}</p><p>${escapeHTML(`${data.threads.length} threads · ${openReports.length} open reports · ${data.boards.length} boards`)}</p></div><div class="admin-toolbar-actions">${tools}<a href="/">Site</a><form action="/admin/logout" method="POST">${this.csrf(csrf)}<button type="submit">Log out</button></form></div></div><section class="admin-section"><h2>Open reports (${openReports.length})</h2><ul class="admin-list">${reports || '<li>No open reports.</li>'}</ul>${openReports.length > 20 ? '<p><a href="/admin/reports">View all reports</a></p>' : ''}</section>${staffCan(staff, 'bans.manage') ? `<section class="admin-section"><h2>Active sanctions (${activeBans.length})</h2><ul class="admin-list">${bans || '<li>No active sanctions.</li>'}</ul>${activeBans.length > this.config.limits.adminPageSize ? '<p class="admin-muted">Showing the newest entries.</p>' : ''}</section>` : ''}<section class="admin-section"><h2>Recent threads</h2>${threads || '<p>No threads.</p>'}${data.threads.length > dashboardThreads.length ? `<p class="admin-muted">Showing ${dashboardThreads.length} most recently bumped threads.</p>` : ''}</section><section class="admin-section"><h2>Recent moderation</h2><ul class="admin-list">${logs || '<li>No actions yet.</li>'}</ul></section></section>`);
  }

  adminReports(data, csrf, filters = {}, staff) {
    const allowedStatuses = new Set(['open', 'closed', 'all']);
    const status = allowedStatuses.has(filters.status) ? filters.status : 'open';
    const boardMap = new Map(data.boards.map(board => [board.id, board]));
    const boardId = boardMap.has(filters.boardId) ? filters.boardId : '';
    const categories = new Map(this.config.reports.categories.map(category => [category.id, category.label]));
    const postMap = new Map();
    for (const thread of data.threads) {
      postMap.set(thread.id, { thread, post: thread });
      for (const reply of thread.replies) postMap.set(reply.id, { thread, post: reply });
    }

    const matchingReports = data.reports
      .filter(report => status === 'all' || report.status === status)
      .filter(report => !boardId || report.boardId === boardId)
      .sort((left, right) => Number(right.updatedAt) - Number(left.updatedAt));
    const pageSize = this.config.limits.adminPageSize;
    const pageInfo = filters.pageInfo?.queue === 'reports' ? filters.pageInfo : null;
    const matchingCount = pageInfo ? pageInfo.total : matchingReports.length;
    const totalPages = pageInfo ? pageInfo.totalPages : Math.max(1, Math.ceil(matchingCount / pageSize));
    const page = pageInfo ? pageInfo.page : Math.min(totalPages, Math.max(1, Number.parseInt(filters.page, 10) || 1));
    const reports = pageInfo ? matchingReports : matchingReports.slice((page - 1) * pageSize, page * pageSize);
    const cards = reports.map(report => {
      const target = postMap.get(report.postId);
      const board = boardMap.get(report.boardId) || data.boards[0];
      const targetHtml = target && board
        ? `<a href="${this.threadPath(board, target.thread.id)}#p${report.postId}">No.${report.postId}</a>`
        : `<span>No.${report.postId} (deleted)</span>`;
      const category = categories.get(report.category) || report.category || 'Other';
      const history = report.history.length
        ? `<details class="admin-report-history"><summary>History (${report.history.length})</summary><ul>${report.history.map(entry => `<li>${this.formatDate(entry.createdAt)} — ${escapeHTML(entry.action)}${entry.resolution ? `: ${escapeHTML(entry.resolution)}` : ''}${entry.note ? ` — ${escapeHTML(entry.note)}` : ''}${entry.actorName ? ` <span class="admin-muted">by ${escapeHTML(entry.actorName)}</span>` : ''}</li>`).join('')}</ul></details>`
        : '';
      const controls = report.status === 'closed'
        ? `<div class="admin-report-resolution"><strong>Resolution:</strong> ${escapeHTML(report.resolution || 'closed')} <span class="admin-muted">${this.formatDate(report.closedAt)}</span>${report.moderatorNote ? `<p>${escapeHTML(report.moderatorNote)}</p>` : ''}<form action="/admin/reports/reopen" method="POST" class="admin-action-form">${this.csrf(csrf)}<input type="hidden" name="reportId" value="${escapeHTML(report.id)}"><button type="submit">Reopen</button></form></div>`
        : `<form action="/admin/reports/resolve" method="POST" class="admin-report-resolve-form">${this.csrf(csrf)}<input type="hidden" name="reportId" value="${escapeHTML(report.id)}"><label>Resolution <select name="resolution"><option value="dismissed">Dismissed</option><option value="action-taken">Action taken</option></select></label><label>Moderator note <input type="text" name="note" maxlength="500"></label><button type="submit">Close report</button></form>`;
      return `<article class="admin-report-card"><header><strong>${targetHtml}</strong><span class="admin-report-status admin-report-status-${escapeHTML(report.status)}">${escapeHTML(report.status)}</span></header><p class="admin-report-meta">/${escapeHTML(board?.uri || report.boardId)}/ · ${escapeHTML(category)} · submitted ${this.formatDate(report.createdAt)}</p><blockquote>${escapeHTML(report.reason)}</blockquote>${controls}${history}</article>`;
    }).join('');

    const statusLinks = ['open', 'closed', 'all'].map(value => {
      const query = new URLSearchParams({ status: value });
      if (boardId) query.set('board', boardId);
      return value === status
        ? `<strong>${value}</strong>`
        : `<a href="/admin/reports?${escapeHTML(query.toString())}">${value}</a>`;
    }).join(' / ');
    const boardOptions = data.boards.map(board => `<option value="${escapeHTML(board.id)}"${board.id === boardId ? ' selected' : ''}>/${escapeHTML(board.uri)}/ — ${escapeHTML(board.name)}</option>`).join('');
    const pagination = this.adminPagination(page, totalPages, '/admin/reports', { status, board: boardId });
    return this.adminShell(
      `Reports - Admin - ${this.siteTitle()}`,
      `<section class="admin-panel"><div class="admin-toolbar"><div><h1>Reports</h1><p>${matchingCount} matching report${matchingCount === 1 ? '' : 's'}.</p></div><div class="admin-toolbar-actions"><a href="/admin">Dashboard</a>${staffCan(staff, 'boards.manage') ? '<a href="/admin/boards">Boards</a>' : ''}${staffCan(staff, 'staff.manage') ? '<a href="/admin/staff">Staff</a>' : ''}<form action="/admin/logout" method="POST">${this.csrf(csrf)}<button type="submit">Log out</button></form></div></div><form action="/admin/reports" method="GET" class="admin-report-filters"><span>Status: ${statusLinks}</span><label>Board <select name="board"><option value="">All boards</option>${boardOptions}</select></label><input type="hidden" name="status" value="${escapeHTML(status)}"><button type="submit">Filter</button></form><section class="admin-report-list">${cards || '<p>No matching reports.</p>'}</section>${pagination}</section>`
    );
  }

  adminTrash(data, csrf, staff, filters = {}) {
    const boardMap = new Map(data.boards.map(board => [board.id, board]));
    const matchingEntries = [...data.trash].sort((left, right) => Number(right.deletedAt) - Number(left.deletedAt));
    const pageSize = this.config.limits.adminPageSize;
    const pageInfo = filters.pageInfo?.queue === 'trash' ? filters.pageInfo : null;
    const totalPages = pageInfo ? pageInfo.totalPages : Math.max(1, Math.ceil(matchingEntries.length / pageSize));
    const page = pageInfo ? pageInfo.page : Math.min(totalPages, Math.max(1, Number.parseInt(filters.page, 10) || 1));
    const entries = pageInfo ? matchingEntries : matchingEntries.slice((page - 1) * pageSize, page * pageSize);
    const cards = entries.map(entry => {
      const board = boardMap.get(entry.boardId);
      const attachmentNames = entry.kind === 'attachment'
        ? postAttachments(entry.post).map(attachment => attachment.imageName || 'image').join(', ')
        : '';
      const expired = Number(entry.purgeAt) <= Date.now();
      const restore = expired
        ? '<span class="admin-muted">Expired; awaiting purge</span>'
        : `<form action="/admin/trash/restore" method="POST" class="admin-action-form">${this.csrf(csrf)}<input type="hidden" name="trashId" value="${escapeHTML(entry.id)}"><button type="submit">Restore</button></form>`;
      return `<article class="admin-report-card"><header><strong>${escapeHTML(entry.kind)} · No.${entry.postId}${attachmentNames ? ` · ${escapeHTML(attachmentNames)}` : ''}</strong><span class="admin-report-status">/${escapeHTML(board?.uri || entry.boardId)}/</span></header><p class="admin-report-meta">Deleted ${this.formatDate(entry.deletedAt)}${entry.deletedByName ? ` by ${escapeHTML(entry.deletedByName)}` : ''} · purge after ${this.formatDate(entry.purgeAt)}</p>${entry.reason ? `<p><strong>Reason:</strong> ${escapeHTML(entry.reason)}</p>` : ''}<blockquote>${escapeHTML(previewText(entry.post.comment, 300))}</blockquote>${restore}</article>`;
    }).join('');
    return this.adminShell(
      `Trash - Admin - ${this.siteTitle()}`,
      `<section class="admin-panel"><div class="admin-toolbar"><div><h1>Staff trash</h1><p>Reversible staff deletions retain media for ${this.config.lifecycle.staffTrashRetentionDays} days. User password deletions remain immediate.</p></div><div class="admin-toolbar-actions"><a href="/admin">Dashboard</a><a href="/admin/revisions">Edit history</a><form action="/admin/logout" method="POST">${this.csrf(csrf)}<button type="submit">Log out</button></form></div></div><form action="/admin/trash/purge" method="POST" class="admin-action-form">${this.csrf(csrf)}<button type="submit">Purge expired entries</button></form><section class="admin-report-list">${cards || '<p>Staff trash is empty.</p>'}</section>${this.adminPagination(page, totalPages, '/admin/trash')}</section>`
    );
  }

  adminMedia(data, csrf, filters = {}, staff, system = {}) {
    const allowedStates = new Set([
      'attention', 'all', 'pending', 'scanning', 'approved', 'rejected',
      'quarantined', 'moderator_hold', 'failed'
    ]);
    const state = allowedStates.has(filters.state) ? filters.state : 'attention';
    const boardMap = new Map(data.boards.map(board => [board.id, board]));
    const boardId = boardMap.has(filters.boardId) ? filters.boardId : '';
    const requestedPostId = Number.parseInt(filters.postId, 10) || 0;
    const references = new Map();
    const addReference = (post, referencedBoardId) => {
      for (const attachment of postAttachments(post)) {
        if (!attachment.assetId) continue;
        if (!references.has(attachment.assetId)) references.set(attachment.assetId, { postIds: new Set(), boardIds: new Set() });
        references.get(attachment.assetId).postIds.add(post.id);
        references.get(attachment.assetId).boardIds.add(referencedBoardId);
      }
    };
    for (const thread of data.threads) {
      addReference(thread, thread.boardId);
      for (const reply of thread.replies) addReference(reply, thread.boardId);
    }
    for (const entry of data.trash) {
      addReference(entry.post, entry.boardId);
      if (entry.kind === 'thread') for (const reply of entry.post.replies) addReference(reply, entry.boardId);
    }

    const attentionStates = new Set(['pending', 'scanning', 'rejected', 'quarantined', 'moderator_hold', 'failed']);
    const matching = data.media
      .filter(asset => state === 'all' || (state === 'attention' ? attentionStates.has(asset.state) : asset.state === state))
      .filter(asset => !boardId || references.get(asset.id)?.boardIds.has(boardId))
      .filter(asset => !requestedPostId || references.get(asset.id)?.postIds.has(requestedPostId))
      .sort((left, right) => Number(right.heldAt || right.createdAt) - Number(left.heldAt || left.createdAt));
    const pageSize = this.config.limits.adminPageSize;
    const totalPages = Math.max(1, Math.ceil(matching.length / pageSize));
    const page = Math.min(totalPages, Math.max(1, Number.parseInt(filters.page, 10) || 1));
    const assets = matching.slice((page - 1) * pageSize, page * pageSize);
    const cards = assets.map(asset => {
      const reference = references.get(asset.id) || { postIds: new Set(), boardIds: new Set() };
      const posts = [...reference.postIds].sort((left, right) => left - right);
      const boards = [...reference.boardIds].map(id => boardMap.get(id)?.uri || id);
      const dimensions = asset.width && asset.height ? `${asset.width}×${asset.height}` : 'unknown dimensions';
      const hashes = [asset.sha256, asset.contentSha256]
        .filter((value, index, values) => value && values.indexOf(value) === index)
        .map(value => `<code>${escapeHTML(value)}</code>`).join('<br>');
      return `<article class="admin-report-card"><header><strong>${escapeHTML(asset.kind)} · ${escapeHTML(asset.state)}</strong><span class="admin-report-status">${escapeHTML(asset.holdReason || asset.state)}</span></header><p class="admin-report-meta">${escapeHTML(dimensions)} · ${escapeHTML(formatBytes(asset.bytes))} · created ${this.formatDate(asset.createdAt)}${asset.heldAt ? ` · held ${this.formatDate(asset.heldAt)}` : ''}</p><p><strong>Boards:</strong> ${escapeHTML(boards.length ? boards.map(uri => `/${uri}/`).join(', ') : 'none')} · <strong>Posts:</strong> ${escapeHTML(posts.length ? posts.map(id => `No.${id}`).join(', ') : 'none')}</p>${hashes ? `<details><summary>SHA-256 metadata</summary><p class="admin-breakable">${hashes}</p></details>` : ''}${asset.holdPending ? '<p class="admin-error">Private storage relocation is pending; maintenance will retry it.</p>' : ''}</article>`;
    }).join('');
    const boardOptions = data.boards.map(board => `<option value="${escapeHTML(board.id)}"${board.id === boardId ? ' selected' : ''}>/${escapeHTML(board.uri)}/ — ${escapeHTML(board.name)}</option>`).join('');
    const stateOptions = [...allowedStates].map(value => `<option value="${escapeHTML(value)}"${value === state ? ' selected' : ''}>${escapeHTML(value.replace('_', ' '))}</option>`).join('');
    const pagination = this.adminPagination(page, totalPages, '/admin/media', {
      state,
      board: boardId,
      postId: requestedPostId || ''
    });
    const activeHashBans = data.mediaHashBans
      .filter(entry => entry.active !== false)
      .sort((left, right) => Number(right.updatedAt) - Number(left.updatedAt))
      .slice(0, pageSize)
      .map(entry => `<li><code>${escapeHTML(entry.sha256)}</code> · ${escapeHTML(entry.scope === 'board' ? `/${boardMap.get(entry.boardId)?.uri || entry.boardId}/` : 'global')} — ${escapeHTML(entry.reason || 'No reason recorded')}${staffCan(staff, 'bans.manage', entry.boardId) ? `<form action="/admin/media/hash-unban" method="POST" class="admin-action-form">${this.csrf(csrf)}<input type="hidden" name="hashBanId" value="${escapeHTML(entry.id)}"><button type="submit">Lift</button></form>` : ''}</li>`)
      .join('');
    const decisions = data.mediaDecisions.slice(-20).reverse()
      .map(entry => `<li>${this.formatDate(entry.createdAt)} — <strong>${escapeHTML(entry.decision)}</strong> · ${escapeHTML(entry.reasonCode || 'manual')} · <code>${escapeHTML(entry.sha256)}</code>${entry.actorName ? ` <span class="admin-muted">by ${escapeHTML(entry.actorName)}</span>` : ''}</li>`)
      .join('');
    const worker = system.worker || {};
    const systemLine = `${system.storage?.backend || 'unknown'} storage · ${Number(worker.active) || 0} active jobs · ${Number(worker.queued) || 0} queued · ${Number(worker.failed) || 0} failed`;
    const hashBanForm = staffCan(staff, 'bans.manage')
      ? `<section class="admin-section"><h2>Add media hash ban</h2><form action="/admin/media/hash-ban" method="POST" class="admin-staff-form">${this.csrf(csrf)}<label>SHA-256 <input type="text" name="sha256" pattern="[A-Fa-f0-9]{64}" minlength="64" maxlength="64" required></label>${staff.scope === 'global' ? `<label>Scope <select name="scope"><option value="global">Global and quarantine known matches</option><option value="board">One board</option></select></label>` : '<input type="hidden" name="scope" value="board">'}<label>Board for board scope <select name="boardId">${boardOptions}</select></label><label>Reason <input type="text" name="reason" maxlength="300" required></label><label>Private moderator note <input type="text" name="moderatorNote" maxlength="500"></label><button type="submit" class="danger-button">Create hash ban</button></form></section>`
      : '';
    return this.adminShell(
      `Media safety - Admin - ${this.siteTitle()}`,
      `<section class="admin-panel"><div class="admin-toolbar"><div><h1>Media safety</h1><p>Metadata-first review; quarantined files are never embedded on this page.</p><p class="admin-muted">${escapeHTML(systemLine)}</p></div><div class="admin-toolbar-actions"><a href="/admin">Dashboard</a><a href="/admin/reports">Reports</a><a href="/admin/trash">Trash</a><form action="/admin/logout" method="POST">${this.csrf(csrf)}<button type="submit">Log out</button></form></div></div><form action="/admin/media" method="GET" class="admin-report-filters"><label>Status <select name="state">${stateOptions}</select></label><label>Board <select name="board"><option value="">All permitted boards</option>${boardOptions}</select></label><label>Internal post number <input type="number" name="postId" min="1" value="${requestedPostId || ''}"></label><button type="submit">Filter</button></form><section class="admin-section"><h2>Media records (${matching.length})</h2><div class="admin-report-list">${cards || '<p>No matching media records.</p>'}</div>${pagination}</section>${hashBanForm}<section class="admin-section"><h2>Active media hash bans</h2><ul class="admin-list">${activeHashBans || '<li>No active hash bans in scope.</li>'}</ul></section><section class="admin-section"><h2>Recent media decisions</h2><ul class="admin-list">${decisions || '<li>No media decisions in scope.</li>'}</ul></section></section>`
    );
  }

  adminRevisions(data, csrf, filters = {}, staff) {
    const requestedPostId = Number.parseInt(filters.postId, 10) || 0;
    const matchingRevisions = data.revisions
      .filter(revision => !requestedPostId || revision.postId === requestedPostId)
      .sort((left, right) => Number(right.editedAt) - Number(left.editedAt));
    const pageSize = this.config.limits.adminPageSize;
    const pageInfo = filters.pageInfo?.queue === 'revisions' ? filters.pageInfo : null;
    const matchingCount = pageInfo ? pageInfo.total : matchingRevisions.length;
    const totalPages = pageInfo ? pageInfo.totalPages : Math.max(1, Math.ceil(matchingCount / pageSize));
    const page = pageInfo ? pageInfo.page : Math.min(totalPages, Math.max(1, Number.parseInt(filters.page, 10) || 1));
    const revisions = pageInfo ? matchingRevisions : matchingRevisions.slice((page - 1) * pageSize, page * pageSize);
    const boardMap = new Map(data.boards.map(board => [board.id, board]));
    const cards = revisions.map(revision => {
      const board = boardMap.get(revision.boardId);
      return `<article class="admin-report-card"><header><strong>No.${revision.postId}</strong><span class="admin-report-status">/${escapeHTML(board?.uri || revision.boardId)}/</span></header><p class="admin-report-meta">${this.formatDate(revision.editedAt)}${revision.editedByName ? ` by ${escapeHTML(revision.editedByName)}` : ''} · ${escapeHTML(revision.reason)}</p>${revision.before.title !== revision.after.title ? `<p><strong>Subject:</strong> <del>${escapeHTML(revision.before.title)}</del> → ${escapeHTML(revision.after.title)}</p>` : ''}<details><summary>Content change</summary><div class="admin-revision-columns"><div><strong>Before</strong><pre>${escapeHTML(revision.before.comment)}</pre></div><div><strong>After</strong><pre>${escapeHTML(revision.after.comment)}</pre></div></div></details></article>`;
    }).join('');
    return this.adminShell(
      `Edit history - Admin - ${this.siteTitle()}`,
      `<section class="admin-panel"><div class="admin-toolbar"><div><h1>Edit history</h1><p>${matchingCount} immutable staff revision record${matchingCount === 1 ? '' : 's'}${requestedPostId ? ` for No.${requestedPostId}` : ''}.</p></div><div class="admin-toolbar-actions"><a href="/admin">Dashboard</a><a href="/admin/trash">Trash</a><form action="/admin/logout" method="POST">${this.csrf(csrf)}<button type="submit">Log out</button></form></div></div><form action="/admin/revisions" method="GET" class="admin-report-filters"><label>Post number <input type="number" name="postId" min="1" value="${requestedPostId || ''}"></label><button type="submit">Filter</button></form><section class="admin-report-list">${cards || '<p>No matching revisions.</p>'}</section>${this.adminPagination(page, totalPages, '/admin/revisions', { postId: requestedPostId || '' })}</section>`
    );
  }

  adminAppeals(data, csrf, filters = {}, staff) {
    const allowedStatuses = new Set(['open', 'accepted', 'denied', 'all']);
    const status = allowedStatuses.has(filters.status) ? filters.status : 'open';
    const sanctions = new Map(data.bans.map(sanction => [sanction.id, sanction]));
    const matchingAppeals = data.appeals
      .filter(appeal => status === 'all' || appeal.status === status)
      .sort((left, right) => Number(right.updatedAt) - Number(left.updatedAt));
    const pageSize = this.config.limits.adminPageSize;
    const pageInfo = filters.pageInfo?.queue === 'appeals' ? filters.pageInfo : null;
    const matchingCount = pageInfo ? pageInfo.total : matchingAppeals.length;
    const totalPages = pageInfo ? pageInfo.totalPages : Math.max(1, Math.ceil(matchingCount / pageSize));
    const page = pageInfo ? pageInfo.page : Math.min(totalPages, Math.max(1, Number.parseInt(filters.page, 10) || 1));
    const appeals = pageInfo ? matchingAppeals : matchingAppeals.slice((page - 1) * pageSize, page * pageSize);
    const cards = appeals.map(appeal => {
      const sanction = sanctions.get(appeal.sanctionId);
      if (!sanction) return '';
      const scope = sanction.scope === 'board' ? `/${sanction.boardId}/` : 'global';
      const controls = appeal.status === 'open'
        ? `<form action="/admin/appeals/resolve" method="POST" class="admin-report-resolve-form">${this.csrf(csrf)}<input type="hidden" name="appealId" value="${escapeHTML(appeal.id)}"><label>Decision <select name="decision"><option value="denied">Deny</option><option value="accepted">Accept and lift</option></select></label><label>Response note <input type="text" name="note" maxlength="500"></label><button type="submit">Resolve appeal</button></form>`
        : `<p><strong>${escapeHTML(appeal.status)}</strong>${appeal.staffNote ? ` — ${escapeHTML(appeal.staffNote)}` : ''}${appeal.resolvedByName ? ` <span class="admin-muted">by ${escapeHTML(appeal.resolvedByName)}</span>` : ''}</p>`;
      return `<article class="admin-report-card"><header><strong>${escapeHTML(sanction.kind)} · ${escapeHTML(sanction.target)} · ${escapeHTML(scope)}</strong><span class="admin-report-status admin-report-status-${escapeHTML(appeal.status)}">${escapeHTML(appeal.status)}</span></header><p class="admin-report-meta">Submitted ${this.formatDate(appeal.createdAt)} · sanction reason: ${escapeHTML(sanction.reason)}</p><blockquote>${escapeHTML(appeal.message)}</blockquote>${controls}</article>`;
    }).join('');
    const statusLinks = ['open', 'accepted', 'denied', 'all'].map(value => value === status
      ? `<strong>${value}</strong>`
      : `<a href="/admin/appeals?status=${value}">${value}</a>`).join(' / ');
    return this.adminShell(
      `Appeals - Admin - ${this.siteTitle()}`,
      `<section class="admin-panel"><div class="admin-toolbar"><div><h1>Appeals</h1><p>${matchingCount} matching appeal${matchingCount === 1 ? '' : 's'}.</p></div><div class="admin-toolbar-actions"><a href="/admin">Dashboard</a><a href="/admin/reports">Reports</a>${staffCan(staff, 'staff.manage') ? '<a href="/admin/staff">Staff</a>' : ''}<form action="/admin/logout" method="POST">${this.csrf(csrf)}<button type="submit">Log out</button></form></div></div><p>Status: ${statusLinks}</p><section class="admin-report-list">${cards || '<p>No matching appeals.</p>'}</section>${this.adminPagination(page, totalPages, '/admin/appeals', { status })}</section>`
    );
  }

  adminStaff(accounts, boards, csrf, actor) {
    const boardCheckboxes = (selected = [], prefix = '') => boards.map((board, index) => `<label><input type="checkbox" name="boardIds" value="${escapeHTML(board.id)}"${selected.includes(board.id) || (!selected.length && index === 0 && prefix === 'new') ? ' checked' : ''}> /${escapeHTML(board.uri)}/</label>`).join('');
    const assignableRoles = ROLES.filter(role => canAssignRole(actor, role));
    const roleOptions = (selected, roles = assignableRoles) => roles.map(role => `<option value="${escapeHTML(role)}"${role === selected ? ' selected' : ''}>${escapeHTML(roleLabel(role))}</option>`).join('');

    const rows = accounts.map(account => {
      const self = account.id === actor.id;
      const manageable = self || canManageAccount(actor, account);
      const scopeLabel = account.scope === 'global'
        ? 'Global'
        : account.boardIds.map(boardId => `/${boardId}/`).join(', ');
      if (!manageable) {
        return `<article class="admin-staff-account"><div><strong>${escapeHTML(account.displayName)}</strong> <span class="admin-muted">@${escapeHTML(account.username)}</span></div><p>${escapeHTML(roleLabel(account.role))} · ${escapeHTML(scopeLabel)} · ${account.enabled ? 'enabled' : 'disabled'}</p></article>`;
      }

      const roleAndScope = self
        ? `<input type="hidden" name="role" value="${escapeHTML(account.role)}"><input type="hidden" name="scope" value="${escapeHTML(account.scope)}">${account.boardIds.map(boardId => `<input type="hidden" name="boardIds" value="${escapeHTML(boardId)}">`).join('')}<p class="admin-muted">${escapeHTML(roleLabel(account.role))} · ${escapeHTML(scopeLabel)}</p>`
        : `<label>Role <select name="role">${roleOptions(account.role)}</select></label><label>Scope <select name="scope"><option value="boards"${account.scope === 'boards' ? ' selected' : ''}>Selected boards</option><option value="global"${account.scope === 'global' ? ' selected' : ''}>Global</option></select></label><fieldset><legend>Boards</legend>${boardCheckboxes(account.boardIds)}</fieldset>`;
      const toggle = canManageAccount(actor, account)
        ? `<form action="/admin/staff/toggle" method="POST" class="admin-action-form">${this.csrf(csrf)}<input type="hidden" name="accountId" value="${escapeHTML(account.id)}"><button type="submit" class="${account.enabled ? 'danger-button' : ''}">${account.enabled ? 'Disable' : 'Enable'}</button></form>`
        : '';
      return `<article class="admin-staff-account"><header><div><strong>${escapeHTML(account.displayName)}</strong> <span class="admin-muted">@${escapeHTML(account.username)}${self ? ' · you' : ''}</span></div><span>${account.enabled ? 'Enabled' : 'Disabled'}</span></header><form action="/admin/staff/edit" method="POST" class="admin-staff-form">${this.csrf(csrf)}<input type="hidden" name="accountId" value="${escapeHTML(account.id)}"><label>Display name <input type="text" name="displayName" maxlength="80" value="${escapeHTML(account.displayName)}" required></label>${roleAndScope}<label>New password <input type="password" name="password" minlength="12" maxlength="256" autocomplete="new-password" placeholder="Leave blank to keep current password"></label><button type="submit">Save account</button></form>${toggle}</article>`;
    }).join('');

    const addForm = assignableRoles.length
      ? `<form action="/admin/staff/add" method="POST" class="admin-staff-form">${this.csrf(csrf)}<label>Username <input type="text" name="username" minlength="3" maxlength="32" pattern="[a-z0-9][a-z0-9_.-]{2,31}" required autocomplete="off"></label><label>Display name <input type="text" name="displayName" maxlength="80"></label><label>Password <input type="password" name="password" minlength="12" maxlength="256" required autocomplete="new-password"></label><label>Role <select name="role">${roleOptions(assignableRoles.at(-1))}</select></label><label>Scope <select name="scope"><option value="boards">Selected boards</option><option value="global">Global</option></select></label><fieldset><legend>Boards</legend>${boardCheckboxes([], 'new')}</fieldset><button type="submit">Create staff account</button></form>`
      : '<p>You cannot create additional staff roles.</p>';
    return this.adminShell(
      `Staff - Admin - ${this.siteTitle()}`,
      `<section class="admin-panel"><div class="admin-toolbar"><div><h1>Staff accounts</h1><p>Named accounts use scoped roles and revocable signed sessions.</p></div><div class="admin-toolbar-actions"><a href="/admin">Dashboard</a><a href="/admin/boards">Boards</a><a href="/admin/reports">Reports</a><form action="/admin/logout" method="POST">${this.csrf(csrf)}<button type="submit">Log out</button></form></div></div><section class="admin-section"><h2>Create account</h2>${addForm}</section><section class="admin-section"><h2>Existing named accounts (${accounts.length})</h2><div class="admin-staff-list">${rows || '<p>No named staff accounts yet. The environment administrator can create the first one.</p>'}</div></section></section>`
    );
  }

  adminAccount(staff, csrf) {
    const scope = staff.scope === 'global'
      ? 'Global'
      : staff.boardIds.map(boardId => `/${boardId}/`).join(', ');
    const form = staff.legacy
      ? '<p>The environment administrator password is managed through <code>ADMIN_PASSWORD</code>. Rotate that value and <code>ADMIN_SESSION_SECRET</code> through the deployment environment.</p>'
      : `<form action="/admin/account" method="POST" class="admin-staff-form">${this.csrf(csrf)}<label>Display name <input type="text" name="displayName" maxlength="80" value="${escapeHTML(staff.displayName)}" required></label><label>New password <input type="password" name="password" minlength="12" maxlength="256" autocomplete="new-password" placeholder="Leave blank to keep current password"></label><button type="submit">Update account</button></form>`;
    let mfa = '<p>MFA enrollment requires a named staff account.</p>';
    if (!staff.legacy && staff.mfaEnabled) {
      mfa = `<p><strong>TOTP MFA is enabled.</strong> Disabling it revokes every active session.</p><form action="/admin/account/mfa/disable" method="POST" class="admin-staff-form">${this.csrf(csrf)}<label>Current password <input type="password" name="currentPassword" autocomplete="current-password" required></label><label>Current authentication or recovery code <input type="text" name="mfaCode" maxlength="20" inputmode="numeric" autocomplete="one-time-code" required></label><button type="submit" class="danger-button">Disable MFA</button></form>`;
    } else if (!staff.legacy && this.config.staffMfa.enabled) {
      mfa = `<p>Add a standards-compatible authenticator code to this account. Setup revokes no sessions until confirmed.</p><form action="/admin/account/mfa/setup" method="POST" class="admin-staff-form">${this.csrf(csrf)}<label>Current password <input type="password" name="currentPassword" autocomplete="current-password" required></label><button type="submit">Start MFA setup</button></form>`;
    } else if (!staff.legacy) {
      mfa = '<p>MFA enrollment is disabled by the operator.</p>';
    }
    return this.adminShell(
      `Account - Admin - ${this.siteTitle()}`,
      `<section class="admin-panel"><div class="admin-toolbar"><div><h1>${escapeHTML(staff.displayName)}</h1><p>@${escapeHTML(staff.username)} · ${escapeHTML(roleLabel(staff.role))} · ${escapeHTML(scope)}</p></div><div class="admin-toolbar-actions"><a href="/admin">Dashboard</a><form action="/admin/logout" method="POST">${this.csrf(csrf)}<button type="submit">Log out</button></form></div></div><section class="admin-section"><h2>Account settings</h2>${form}</section><section class="admin-section"><h2>Multi-factor authentication</h2>${mfa}</section></section>`
    );
  }

  adminMfaSetup(staff, csrf, enrollment) {
    const recoveryCodes = enrollment.recoveryCodes
      .map(code => `<li><code>${escapeHTML(code)}</code></li>`)
      .join('');
    return this.adminShell(
      `MFA setup - Admin - ${this.siteTitle()}`,
      `<section class="admin-panel"><div class="admin-toolbar"><div><h1>Set up multi-factor authentication</h1><p>@${escapeHTML(staff.username)}</p></div><div class="admin-toolbar-actions"><a href="/admin/account">Cancel</a></div></div><section class="admin-section"><h2>1. Add the authenticator secret</h2><p>Enter this Base32 secret in a TOTP authenticator:</p><p><code>${escapeHTML(enrollment.secret)}</code></p><details><summary>Show authenticator URI</summary><code class="admin-breakable">${escapeHTML(enrollment.uri)}</code></details></section><section class="admin-section"><h2>2. Save recovery codes now</h2><p>Each code works once. Store them offline; ChikoChan stores only keyed hashes and cannot show them again.</p><ol class="admin-recovery-codes">${recoveryCodes}</ol></section><section class="admin-section"><h2>3. Confirm setup</h2><form action="/admin/account/mfa/confirm" method="POST" class="admin-staff-form">${this.csrf(csrf)}<label>Six-digit authenticator code <input type="text" name="mfaCode" pattern="[0-9]{6}" maxlength="6" inputmode="numeric" autocomplete="one-time-code" required autofocus></label><button type="submit">Enable MFA and revoke sessions</button></form></section></section>`
    );
  }

  themeInputs(theme = {}, prefix = 'theme_') {
    const labels = {
      background: 'Background',
      text: 'Text',
      link: 'Links',
      linkHover: 'Link hover',
      boardTitle: 'Board title',
      subject: 'Subjects',
      name: 'Names',
      formHeader: 'Form headers',
      formBackground: 'Form background',
      formBorder: 'Form border',
      replyBackground: 'Reply background',
      replyBorder: 'Reply border',
      quote: 'Quote text',
      quoteLink: 'Quote links',
      panelHeader: 'Panel headers'
    };
    return Object.entries(labels).map(([key, label]) => `<label>${label} <input type="text" name="${prefix}${key}" pattern="#[A-Fa-f0-9]{6}" maxlength="7" value="${escapeHTML(theme[key] || '')}" placeholder="#rrggbb"></label>`).join('');
  }

  adminCustomization(customization, csrf) {
    const navigation = customization.navigation.map(link => `${link.label} | ${link.href}`).join('\n');
    const pages = customization.pages.map(page => `<article class="admin-custom-page"><form action="/admin/customization/pages/edit" method="POST" class="admin-custom-page-form">${this.csrf(csrf)}<input type="hidden" name="pageId" value="${escapeHTML(page.id)}"><label>Slug <input type="text" name="slug" pattern="[a-z0-9][a-z0-9-]{0,63}" maxlength="64" value="${escapeHTML(page.slug)}" required></label><label>Title <input type="text" name="title" maxlength="120" value="${escapeHTML(page.title)}" required></label><label>Plain-text content <textarea name="content" maxlength="50000" rows="10">${escapeHTML(page.content)}</textarea></label><input type="hidden" name="showInFooter" value="0"><label class="inline-option"><input type="checkbox" name="showInFooter" value="1"${page.showInFooter ? ' checked' : ''}> Show in footer</label><div><button type="submit">Save page</button> <a href="/pages/${escapeHTML(page.slug)}">View</a></div></form><form action="/admin/customization/pages/delete" method="POST" class="admin-action-form" data-confirm="Delete custom page ${escapeHTML(page.title)}?">${this.csrf(csrf)}<input type="hidden" name="pageId" value="${escapeHTML(page.id)}"><button type="submit" class="danger-button">Delete page</button></form></article>`).join('');
    const addPage = `<form action="/admin/customization/pages/add" method="POST" class="admin-custom-page-form">${this.csrf(csrf)}<label>Slug <input type="text" name="slug" pattern="[a-z0-9][a-z0-9-]{0,63}" maxlength="64" required placeholder="faq"></label><label>Title <input type="text" name="title" maxlength="120" required></label><label>Plain-text content <textarea name="content" maxlength="50000" rows="8"></textarea></label><input type="hidden" name="showInFooter" value="0"><label class="inline-option"><input type="checkbox" name="showInFooter" value="1" checked> Show in footer</label><button type="submit">Add page</button></form>`;
    return this.adminShell(
      `Customization - Admin - ${this.siteTitle()}`,
      `<section class="admin-panel"><div class="admin-toolbar"><div><h1>Site customization</h1><p>Structured values only. HTML, JavaScript, server templates, and arbitrary CSS are not accepted.</p></div><div class="admin-toolbar-actions"><a href="/admin">Dashboard</a><a href="/">View site</a><form action="/admin/logout" method="POST">${this.csrf(csrf)}<button type="submit">Log out</button></form></div></div><section class="admin-section"><h2>Branding and navigation</h2><form action="/admin/customization" method="POST" class="admin-customization-form">${this.csrf(csrf)}<label>Site title <input type="text" name="title" maxlength="120" value="${escapeHTML(customization.title)}" placeholder="Use configured default"></label><label>Description <textarea name="description" maxlength="4000" rows="6">${escapeHTML(customization.description)}</textarea></label><label>Announcement <textarea name="announcement" maxlength="1000" rows="3">${escapeHTML(customization.announcement)}</textarea></label><label>Footer text <input type="text" name="footerText" maxlength="500" value="${escapeHTML(customization.footerText)}"></label><label>Logo path <input type="text" name="logoPath" maxlength="240" value="${escapeHTML(customization.logoPath)}" placeholder="/banner.png or /src/image.png"></label><label>Favicon path <input type="text" name="faviconPath" maxlength="240" value="${escapeHTML(customization.faviconPath)}" placeholder="/chikki.ico"></label><label>Navigation, one per line as Label | /path <textarea name="navigation" rows="5" maxlength="6000">${escapeHTML(navigation)}</textarea></label><fieldset class="admin-theme-fields"><legend>Validated color tokens</legend>${this.themeInputs(customization.theme)}</fieldset><button type="submit">Save customization</button></form></section><section class="admin-section"><h2>Add custom page</h2>${addPage}</section><section class="admin-section"><h2>Custom pages (${customization.pages.length})</h2><div class="admin-custom-pages">${pages || '<p>No custom pages.</p>'}</div></section></section>`
    );
  }

  adminBoards(boards, defaultBoardId, csrf) {
    const rows = boards.map((board, index) => {
      const isDefault = board.id === defaultBoardId;
      const moveForm = (direction, label, disabled) => `<form action="/admin/boards/move" method="POST" class="admin-action-form">${this.csrf(csrf)}<input type="hidden" name="uri" value="${escapeHTML(board.uri)}"><input type="hidden" name="direction" value="${direction}"><button type="submit" title="Move /${escapeHTML(board.uri)}/ ${direction}" aria-label="Move /${escapeHTML(board.uri)}/ ${direction}"${disabled ? ' disabled' : ''}>${label}</button></form>`;
      return `<tr>
        <td>/${escapeHTML(board.uri)}/</td>
        <td><form action="/admin/boards/edit" method="POST" class="admin-board-form">${this.csrf(csrf)}<input type="hidden" name="uri" value="${escapeHTML(board.uri)}"><input type="text" name="newUri" value="${escapeHTML(board.uri)}" maxlength="32" required><input type="text" name="name" value="${escapeHTML(board.name)}" maxlength="80" required><input type="text" name="description" value="${escapeHTML(board.description)}" maxlength="200"><input type="text" name="category" value="${escapeHTML(board.category)}" maxlength="80" required><input type="hidden" name="enabled" value="0"><label><input type="checkbox" name="enabled" value="1"${board.enabled ? ' checked' : ''}> Enabled</label><button type="submit">Save</button></form></td>
        <td>${escapeHTML(board.category)}</td>
        <td>${board.enabled ? 'Yes' : 'No'}${isDefault ? ' (default)' : ''}</td>
        <td><div class="admin-board-actions">
          <a class="admin-board-rules-link" href="/admin/boards/${escapeHTML(board.uri)}/rules">Rules (${board.rules.length})</a>
          <a href="/admin/boards/${escapeHTML(board.uri)}/settings">Policies / appearance</a>
          <div class="admin-board-order" aria-label="Board position">${moveForm('up', '↑ Up', index === 0)}${moveForm('down', '↓ Down', index === boards.length - 1)}</div>
          <form action="/admin/boards/toggle" method="POST" class="admin-action-form">${this.csrf(csrf)}<input type="hidden" name="uri" value="${escapeHTML(board.uri)}"><button type="submit">${board.enabled ? 'Disable' : 'Enable'}</button></form>
          ${isDefault ? '' : `<form action="/admin/boards/delete" method="POST" class="admin-action-form" data-confirm="Delete /${escapeHTML(board.uri)}/? Threads will move to the default board.">${this.csrf(csrf)}<input type="hidden" name="uri" value="${escapeHTML(board.uri)}"><button type="submit" class="danger-button">Delete</button></form>`}
        </div></td>
      </tr>`;
    }).join('');

    const addForm = `<section class="admin-section"><h2>Add board</h2><form action="/admin/boards/add" method="POST" class="admin-board-add-form">${this.csrf(csrf)}<label>URI <input type="text" name="uri" maxlength="32" required placeholder="e.g. g"></label><label>Name <input type="text" name="name" maxlength="80" required placeholder="Technology"></label><label>Description <input type="text" name="description" maxlength="200"></label><label>Category <input type="text" name="category" maxlength="80" value="Interests"></label><label><input type="checkbox" name="enabled" value="1" checked> Enabled</label><button type="submit">Add board</button></form></section>`;

    return this.adminShell(`Boards - Admin - ${this.siteTitle()}`, `<section class="admin-panel"><div class="admin-toolbar"><div><h1>Boards</h1><p>Manage imageboard boards and categories.</p></div><div class="admin-toolbar-actions"><a href="/admin">Dashboard</a><a href="/">Site</a><form action="/admin/logout" method="POST">${this.csrf(csrf)}<button type="submit">Log out</button></form></div></div>${addForm}<section class="admin-section"><h2>Existing boards</h2><table class="admin-board-table"><thead><tr><th>URI</th><th>Name / Description / Category</th><th>Category</th><th>Enabled</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No boards.</td></tr>'}</tbody></table></section></section>`);
  }

  adminBoardSettings(board, csrf) {
    const select = (key, globalValue) => {
      const value = Object.hasOwn(board.settings || {}, key) ? String(Number(board.settings[key])) : '';
      return `<select name="${key}"><option value=""${value === '' ? ' selected' : ''}>Inherit (${globalValue ? 'enabled' : 'disabled'})</option><option value="1"${value === '1' ? ' selected' : ''}>Enabled</option><option value="0"${value === '0' ? ' selected' : ''}>Disabled</option></select>`;
    };
    const filters = Array.isArray(board.filters) ? board.filters : [];
    const filterRows = filters.map(filter => `<article class="admin-board-rule" id="filter-${escapeHTML(filter.id)}"><span><strong>${escapeHTML(filter.kind)}</strong> <code>${escapeHTML(filter.value)}</code>${filter.note ? ` — ${escapeHTML(filter.note)}` : ''}</span><form action="/admin/boards/filters/delete" method="POST" class="admin-action-form">${this.csrf(csrf)}<input type="hidden" name="uri" value="${escapeHTML(board.uri)}"><input type="hidden" name="filterId" value="${escapeHTML(filter.id)}"><button type="submit" class="danger-button">Delete</button></form></article>`).join('');
    const filterAddForm = filters.length >= 20
      ? '<p class="admin-muted">This board has reached the limit of 20 filters.</p>'
      : `<form action="/admin/boards/filters/add" method="POST" class="admin-board-rule-add-form">${this.csrf(csrf)}<input type="hidden" name="uri" value="${escapeHTML(board.uri)}"><label>Kind <select name="kind"><option value="literal">Literal text</option><option value="domain">Link domain</option></select></label><label>Value <input type="text" name="value" minlength="1" maxlength="200" required></label><label>Public note <input type="text" name="note" maxlength="200"></label><button type="submit">Add filter</button></form>`;
    const filtersSection = `<section class="admin-section"><h2>Content filters (${filters.length})</h2><p>Literal filters match post names, subjects, and comments case-insensitively. Domain filters match link hostnames and their subdomains. Matching posts are rejected.</p>${filterRows || '<p>No board filters yet.</p>'}${filterAddForm}</section>`;
    return this.adminShell(
      `Policies for /${board.uri}/ - Admin - ${this.siteTitle()}`,
      `<section class="admin-panel"><div class="admin-toolbar"><div><h1>Policies and appearance for /${escapeHTML(board.uri)}/</h1><p>Blank limits and inherited choices continue using global configuration.</p></div><div class="admin-toolbar-actions"><a href="/admin/boards">Boards</a><a href="${this.boardPath(board)}">View board</a><a href="/admin">Dashboard</a></div></div><form action="/admin/boards/edit" method="POST" class="admin-customization-form">${this.csrf(csrf)}<input type="hidden" name="uri" value="${escapeHTML(board.uri)}"><input type="hidden" name="settingsForm" value="1"><fieldset><legend>Posting policies</legend><label>Require image for thread ${select('requireImageForThread', this.config.features.requireImageForThread)}</label><label>Video uploads ${select('allowVideoUploads', this.config.features.videoUploads)}</label><label>Attachment spoilers ${select('allowSpoilers', this.config.features.spoilerImages)}</label><label>Poster IDs ${select('showPosterIds', this.config.features.posterIds)}</label><label>Sage ${select('allowSage', true)}</label><label>Reject duplicate files ${select('rejectDuplicateImages', this.config.features.rejectDuplicateImages)}</label><label>Anonymous name <input type="text" name="anonymousName" maxlength="80" value="${escapeHTML(board.settings?.anonymousName || '')}" placeholder="${escapeHTML(this.anonymousName())}"></label><label>Active thread limit <input type="number" name="maxThreads" min="1" value="${board.settings?.maxThreads || ''}" placeholder="${this.config.limits.maxThreads}"></label><label>Bump limit <input type="number" name="bumpLimit" min="1" value="${board.settings?.bumpLimit || ''}" placeholder="${this.config.limits.bumpLimit}"></label><label>Reply limit <input type="number" name="replyLimit" min="1" value="${board.settings?.replyLimit || ''}" placeholder="${this.config.limits.replyLimit}"></label><label>Attachments per post <input type="number" name="maxFilesPerPost" min="1" max="4" value="${board.settings?.maxFilesPerPost || ''}" placeholder="${this.config.limits.maxFilesPerPost}"></label></fieldset><fieldset><legend>Tags and safety</legend><label>Board tags <input type="text" name="tags" maxlength="240" value="${escapeHTML((Array.isArray(board.tags) ? board.tags : []).join(' '))}" placeholder="anime games"></label><p class="admin-muted">Space-separated, lowercase letters, numbers, and dashes; 1–24 characters each, at most 8 tags.</p><input type="hidden" name="sfw" value="0"><label class="inline-option"><input type="checkbox" name="sfw" value="1"${board.sfw !== false ? ' checked' : ''}> Mark this board SFW</label></fieldset><fieldset><legend>Board appearance</legend><label>Banner image path <input type="text" name="bannerPath" maxlength="240" value="${escapeHTML(board.appearance?.bannerPath || '')}" placeholder="/src/image.png"></label><label>Banner text <input type="text" name="bannerText" maxlength="500" value="${escapeHTML(board.appearance?.bannerText || '')}"></label><div class="admin-theme-fields">${this.themeInputs(board.appearance?.theme, 'boardTheme_')}</div></fieldset><button type="submit">Save board policies</button></form>${filtersSection}</section>`
    );
  }

  adminBoardRules(board, csrf) {
    const maximumLength = this.config.limits.maxBoardRuleLength;
    const maximumRules = this.config.limits.maxBoardRules;
    const rules = board.rules.map((rule, index) => `<article class="admin-board-rule" id="rule-${escapeHTML(rule.id)}">
      <span class="admin-board-rule-number">${index + 1}.</span>
      <form action="/admin/boards/rules/edit" method="POST" class="admin-board-rule-form">${this.csrf(csrf)}<input type="hidden" name="uri" value="${escapeHTML(board.uri)}"><input type="hidden" name="ruleId" value="${escapeHTML(rule.id)}"><textarea name="text" maxlength="${maximumLength}" rows="3" required>${escapeHTML(rule.text)}</textarea><button type="submit">Save</button></form>
      <form action="/admin/boards/rules/delete" method="POST" class="admin-action-form">${this.csrf(csrf)}<input type="hidden" name="uri" value="${escapeHTML(board.uri)}"><input type="hidden" name="ruleId" value="${escapeHTML(rule.id)}"><button type="submit" class="danger-button">Delete</button></form>
    </article>`).join('');
    const addDisabled = board.rules.length >= maximumRules;
    const addForm = addDisabled
      ? `<p class="admin-muted">This board has reached the limit of ${maximumRules} rules.</p>`
      : `<form action="/admin/boards/rules/add" method="POST" class="admin-board-rule-add-form">${this.csrf(csrf)}<input type="hidden" name="uri" value="${escapeHTML(board.uri)}"><label for="new-board-rule">New rule</label><textarea id="new-board-rule" name="text" maxlength="${maximumLength}" rows="4" required></textarea><button type="submit">Add rule</button></form>`;
    const publicLink = board.enabled ? `<a href="/${escapeHTML(board.uri)}/rules">Public rules</a>` : '';
    return this.adminShell(
      `Rules for /${board.uri}/ - Admin - ${this.siteTitle()}`,
      `<section class="admin-panel"><div class="admin-toolbar"><div><h1>Rules for /${escapeHTML(board.uri)}/</h1><p>${board.rules.length} of ${maximumRules} board-specific rules.</p></div><div class="admin-toolbar-actions"><a href="/admin/boards">Boards</a>${publicLink}<a href="/admin">Dashboard</a><form action="/admin/logout" method="POST">${this.csrf(csrf)}<button type="submit">Log out</button></form></div></div><section class="admin-section"><h2>Add rule</h2>${addForm}</section><section class="admin-section"><h2>Existing rules</h2>${rules || '<p>No board-specific rules yet.</p>'}</section></section>`
    );
  }

  home(data, boards, siteStats, latestPosts = [], latestImages = []) {
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
      `<a href="${escapeHTML(page.path || `/${key}`)}">${escapeHTML(page.title || key)}</a>`
    ).join(' | ');

    const latestItems = latestPosts.map(entry => {
      const url = `${this.threadPath(entry.board, entry.threadId)}#p${entry.post.id}`;
      const text = escapeHTML(previewText(entry.post.comment || entry.post.fortune, 110));
      const name = escapeHTML(entry.post.name || this.anonymousName(entry.board));
      const reference = `&gt;&gt;/${escapeHTML(entry.board.uri)}/${entry.post.id}`;
      return `<li><a class="latest-post-reference" href="${url}">${reference}</a> <span class="latest-post-name">${name}</span> <a class="latest-post-snippet" href="${url}">${text}</a></li>`;
    }).join('');
    const latestContent = latestItems
      ? `<ul class="latest-posts-list">${latestItems}</ul>`
      : '<p>No posts yet.</p>';

    const latestImageItems = latestImages.map(entry => {
      const url = `${this.threadPath(entry.board, entry.threadId)}#p${entry.post.id}`;
      const previewSource = mediaSource(entry.post.thumbnail || (entry.post.mediaKind === 'video' ? '' : entry.post.image));
      if (!previewSource) return '';
      const source = escapeHTML(previewSource);
      const previewWidth = entry.post.thumbnailWidth || entry.post.width;
      const previewHeight = entry.post.thumbnailHeight || entry.post.height;
      const dimensions = previewWidth && previewHeight
        ? ` width="${Number(previewWidth)}" height="${Number(previewHeight)}"`
        : '';
      const spoilerClass = entry.post.spoiler ? ' latest-image-spoiler' : '';
      const label = `/${entry.board.uri}/ post No.${entry.post.id}`;
      return `<a class="latest-image-link" href="${url}" title="${escapeHTML(label)}"><img class="latest-image-thumb${spoilerClass}" src="${source}" alt="Media from ${escapeHTML(label)}"${dimensions} loading="lazy" decoding="async"></a>`;
    }).join('');
    const latestImagesContent = latestImageItems
      ? `<div class="latest-images-grid">${latestImageItems}</div>`
      : '<p>No images yet.</p>';

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
        <div class="latest-content-grid">
          <section class="latest-panel latest-images-section">
            <h2>Latest Images</h2>
            ${latestImagesContent}
          </section>
          <section class="latest-panel latest-posts-section">
            <h2>Latest Posts</h2>
            ${latestContent}
          </section>
        </div>
        <section class="site-stats">
          <p>Total posts: ${siteStats.postCount.toLocaleString()}</p>
          <p>Boards: ${siteStats.boardCount}</p>
          <p>Active content: ${escapeHTML(siteStats.activeContentText)}</p>
        </section>
        <footer class="site-footer">
          ${footerLinks}${footerLinks && this.customization().footerText ? '<br>' : ''}${this.customization().footerText ? `<span>${escapeHTML(this.customization().footerText)}</span>` : ''}
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
