'use strict';

const path = require('node:path');
const { buildPostIndex, formatComment, formatFortune } = require('./markup');
const { postAttachments } = require('./post-media');
const { formatDate } = require('./utils');

function imageCount(thread) {
  return postAttachments(thread).length
    + thread.replies.reduce((count, reply) => count + postAttachments(reply).length, 0);
}

function apiFile(post) {
  if (!post?.image) return {};
  const storedName = path.basename(post.image);
  const extension = path.extname(storedName).toLowerCase();
  const timeName = storedName.slice(0, -extension.length);
  const originalName = path.basename(post.imageName || 'image', path.extname(post.imageName || ''));
  const numericTime = /^\d+$/.test(timeName) && Number.isSafeInteger(Number(timeName)) ? Number(timeName) : timeName;
  const file = {
    tim: numericTime,
    filename: originalName,
    ext: extension,
    fsize: Number(post.imageBytes) || 0,
    md5: post.md5 || '',
    w: Number(post.width) || 0,
    h: Number(post.height) || 0,
    tn_w: Number(post.thumbnailWidth || post.width) || 0,
    tn_h: Number(post.thumbnailHeight || post.height) || 0,
    spoiler: post.spoiler ? 1 : 0
  };
  if (post.id) file.attachment_id = post.id;
  if (post.assetId) file.asset_id = post.assetId;
  if (post.mediaKind) file.media_type = post.mediaKind;
  if (/^src\/[a-z0-9][a-z0-9._-]{0,199}\.(?:jpe?g|png|gif|webp)$/i.test(String(post.thumbnail || ''))) {
    file.thumbnail = `/${post.thumbnail}`;
  }
  if (post.durationMs) file.duration = Number((post.durationMs / 1000).toFixed(3));
  if (post.videoCodec) file.video_codec = post.videoCodec;
  if (post.audioCodec) file.audio_codec = post.audioCodec;
  return file;
}

function apiPost(post, thread, context) {
  const isOp = post.id === thread.id;
  const fortune = formatFortune(post.fortune);
  const comment = formatComment(post.comment, {
    postIndex: context.postIndex,
    boardUri: context.boardUri,
    threadId: thread.id
  });
  const attachments = postAttachments(post);
  const translated = {
    no: Number(post.id),
    resto: isOp ? 0 : Number(thread.id),
    now: formatDate(post.createdAt),
    time: Math.floor(Number(post.createdAt) / 1000),
    name: post.name || context.anonymousName,
    com: [fortune, comment].filter(Boolean).join('<br>'),
    ...apiFile(attachments[0])
  };
  if (attachments.length > 1) translated.extra_files = attachments.slice(1).map(apiFile);

  if (post.trip) translated.trip = post.trip;
  if (post.capcode) translated.capcode = post.capcode;
  if (post.posterId) translated.id = post.posterId;
  if (post.email) translated.email = post.email;
  if (post.title) translated.sub = post.title;
  if (post.fortune) translated.fortune = post.fortune;
  if (post.editedAt) {
    translated.edited = 1;
    translated.last_edited = Math.floor(Number(post.editedAt) / 1000);
  }
  if (post.imageDeleted) translated.filedeleted = 1;
  if (post.references?.length) translated.references = [...post.references];
  if (post.backlinks?.length) translated.backlinks = post.backlinks.map(link => link.id);

  if (isOp) {
    translated.replies = thread.replies.length;
    translated.images = imageCount(thread);
    translated.last_modified = Math.floor(Number(thread.bumpedAt || thread.createdAt) / 1000);
    if (thread.sticky) translated.sticky = 1;
    if (thread.locked || thread.archived) translated.closed = 1;
    if (thread.cyclic) translated.cyclical = 1;
    if (thread.archived) translated.archived = 1;
  }

  return translated;
}

function apiThread(thread, data, config, board, preview = false) {
  const postIndex = buildPostIndex(data);
  const context = {
    boardUri: board.uri,
    anonymousName: board.settings?.anonymousName || config.anonymousName || 'Anonymous',
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
    op.omitted_images = thread.replies.slice(0, omitted)
      .reduce((count, reply) => count + postAttachments(reply).length, 0);
  }
  return { posts: [op, ...replies.map(reply => apiPost(reply, thread, context))] };
}

function apiCatalog(service, data, board) {
  const threads = service.getSortedThreads(data, board.id);
  const perPage = service.config.limits.threadsPerPage;
  const postIndex = buildPostIndex(data);
  const context = { boardUri: board.uri, anonymousName: service.anonymousName(board), postIndex };
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
      ws_board: board.sfw !== false ? 1 : 0,
      sfw: board.sfw !== false,
      tags: (Array.isArray(board.tags) ? board.tags : []).map(String),
      per_page: config.limits.threadsPerPage,
      pages: Math.ceil(config.limits.maxThreads / config.limits.threadsPerPage),
      max_filesize: config.limits.maxFileBytes,
      max_webm_filesize: config.media.videoAvailable
        && (board.settings?.allowVideoUploads ?? config.features.videoUploads)
        ? config.limits.maxVideoBytes
        : 0,
      max_files_per_post: board.settings?.maxFilesPerPost || config.limits.maxFilesPerPost,
      max_comment_chars: config.limits.maxCommentLength,
      bump_limit: board.settings?.bumpLimit || config.limits.bumpLimit,
      image_limit: board.settings?.replyLimit || config.limits.replyLimit,
      spoilers: (board.settings?.allowSpoilers ?? config.features.spoilerImages) ? 1 : 0,
      user_ids: (board.settings?.showPosterIds ?? config.features.posterIds) ? 1 : 0,
      cooldowns: {
        threads: Math.ceil(config.limits.postRateWindowMs / 1000),
        replies: Math.ceil(config.limits.postRateWindowMs / 1000),
        images: Math.ceil(config.limits.postRateWindowMs / 1000)
      }
    }));
  return { boards };
}

module.exports = { apiBoards, apiCatalog, apiPost, apiThread, apiThreads };
