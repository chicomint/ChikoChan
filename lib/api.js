'use strict';

const path = require('node:path');
const { buildPostIndex, formatComment, formatFortune } = require('./markup');
const { formatDate } = require('./utils');

function imageCount(thread) {
  return Number(Boolean(thread.image)) + thread.replies.reduce((count, reply) => count + Number(Boolean(reply.image)), 0);
}

function apiFile(post) {
  if (!post.image) return {};
  const storedName = path.basename(post.image);
  const extension = path.extname(storedName).toLowerCase();
  const timeName = storedName.slice(0, -extension.length);
  const originalName = path.basename(post.imageName || 'image', path.extname(post.imageName || ''));
  const numericTime = /^\d+$/.test(timeName) && Number.isSafeInteger(Number(timeName)) ? Number(timeName) : timeName;
  return {
    tim: numericTime,
    filename: originalName,
    ext: extension,
    fsize: Number(post.imageBytes) || 0,
    md5: post.md5 || '',
    w: Number(post.width) || 0,
    h: Number(post.height) || 0,
    tn_w: Number(post.width) || 0,
    tn_h: Number(post.height) || 0,
    spoiler: post.spoiler ? 1 : 0
  };
}

function apiPost(post, thread, context) {
  const isOp = post.id === thread.id;
  const fortune = formatFortune(post.fortune);
  const comment = formatComment(post.comment, {
    postIndex: context.postIndex,
    boardUri: context.boardUri,
    threadId: thread.id
  });
  const translated = {
    no: Number(post.id),
    resto: isOp ? 0 : Number(thread.id),
    now: formatDate(post.createdAt),
    time: Math.floor(Number(post.createdAt) / 1000),
    name: post.name || context.anonymousName,
    com: [fortune, comment].filter(Boolean).join('<br>'),
    ...apiFile(post)
  };

  if (post.trip) translated.trip = post.trip;
  if (post.posterId) translated.id = post.posterId;
  if (post.email) translated.email = post.email;
  if (post.title) translated.sub = post.title;
  if (post.fortune) translated.fortune = post.fortune;
  if (post.imageDeleted) translated.filedeleted = 1;
  if (post.references?.length) translated.references = [...post.references];
  if (post.backlinks?.length) translated.backlinks = post.backlinks.map(link => link.id);

  if (isOp) {
    translated.replies = thread.replies.length;
    translated.images = imageCount(thread);
    translated.last_modified = Math.floor(Number(thread.bumpedAt || thread.createdAt) / 1000);
    if (thread.sticky) translated.sticky = 1;
    if (thread.locked) translated.closed = 1;
    if (thread.cyclic) translated.cyclical = 1;
  }

  return translated;
}

function apiThread(thread, data, config, board, preview = false) {
  const postIndex = buildPostIndex(data);
  const context = {
    boardUri: board.uri,
    anonymousName: board.name,
    postIndex
  };
  let replies = thread.replies;
  let omitted = 0;
  if (preview && replies.length > config.limits.previewReplies) {
    const limit = config.limits.previewReplies;
    omitted = replies.length - limit;
    replies = replies.slice(-limit);
  }
  const op = apiPost(thread, thread, context);
  if (omitted) {
    op.omitted_posts = omitted;
    op.omitted_images = thread.replies.slice(0, omitted).filter(reply => reply.image).length;
  }
  return { posts: [op, ...replies.map(reply => apiPost(reply, thread, context))] };
}

function apiCatalog(service, data, board) {
  const threads = service.getSortedThreads(data, board.id);
  const perPage = service.config.limits.threadsPerPage;
  const postIndex = buildPostIndex(data);
  const context = { boardUri: board.uri, anonymousName: board.name, postIndex };
  const pages = [];
  for (let offset = 0; offset < threads.length || offset === 0; offset += perPage) {
    const pageThreads = threads.slice(offset, offset + perPage);
    pages.push({
      page: Math.floor(offset / perPage) + 1,
      threads: pageThreads.map(thread => apiPost(thread, thread, context))
    });
    if (!threads.length) break;
  }
  return pages;
}

function apiThreads(service, data, board) {
  return apiCatalog(service, data, board).map(page => ({
    page: page.page,
    threads: page.threads.map(thread => ({
      no: thread.no,
      last_modified: thread.last_modified,
      replies: thread.replies
    }))
  }));
}

function apiBoards(config, data) {
  const boards = (data.boards || [])
    .filter(board => board.enabled)
    .map(board => ({
      board: board.uri,
      title: board.name,
      meta_description: board.description,
      ws_board: 1,
      per_page: config.limits.threadsPerPage,
      pages: Math.ceil(config.limits.maxThreads / config.limits.threadsPerPage),
      max_filesize: config.limits.maxFileBytes,
      max_webm_filesize: 0,
      max_comment_chars: config.limits.maxCommentLength,
      bump_limit: config.limits.bumpLimit,
      image_limit: config.limits.replyLimit,
      cooldowns: {
        threads: Math.ceil(config.limits.postRateWindowMs / 1000),
        replies: Math.ceil(config.limits.postRateWindowMs / 1000),
        images: Math.ceil(config.limits.postRateWindowMs / 1000)
      }
    }));
  return { boards };
}

module.exports = { apiBoards, apiCatalog, apiPost, apiThread, apiThreads };
