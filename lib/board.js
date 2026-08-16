'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { allPosts, defaultBoardUri } = require('./store');
const { validateBoardUri } = require('./boards');
const {
  cleanText,
  formatBytes,
  hashPassword,
  httpError,
  parseNameAndTrip,
  verifyPassword
} = require('./utils');

function findPost(data, id) {
  const postId = Number.parseInt(id, 10);
  for (const thread of data.threads) {
    if (thread.id === postId) return { post: thread, thread, isThread: true, threadId: thread.id };
    const replyIndex = thread.replies.findIndex(reply => reply.id === postId);
    if (replyIndex >= 0) {
      return { post: thread.replies[replyIndex], thread, replyIndex, isThread: false, threadId: thread.id };
    }
  }
  return null;
}

function sortedThreads(data, boardId = null) {
  const threads = boardId
    ? data.threads.filter(thread => thread.boardId === boardId)
    : data.threads;
  return [...threads].sort((left, right) => {
    if (Boolean(left.sticky) !== Boolean(right.sticky)) return left.sticky ? -1 : 1;
    return Number(right.bumpedAt || right.createdAt) - Number(left.bumpedAt || right.createdAt);
  });
}

function boardStats(threads) {
  const replies = threads.reduce((total, thread) => total + thread.replies.length, 0);
  return {
    threadCount: threads.length,
    replyCount: replies,
    postCount: threads.length + replies,
    line: `${threads.length} thread${threads.length === 1 ? '' : 's'} · ${replies} repl${replies === 1 ? 'y' : 'ies'}`
  };
}

function directorySize(directory) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile()) total += fs.statSync(path.join(directory, entry.name)).size;
    }
  } catch {
    total = 0;
  }
  return total;
}

function siteStats(data, uploadDir) {
  const threads = data.threads;
  const posts = allPosts(data);
  const postCount = posts.length;
  const replyCount = postCount - threads.length;
  const boardCount = data.boards.filter(board => board.enabled).length;
  const activeContent = uploadDir ? directorySize(uploadDir) : 0;
  return {
    threadCount: threads.length,
    replyCount,
    postCount,
    boardCount,
    activeContent,
    activeContentText: formatBytes(activeContent),
    line: `${postCount} post${postCount === 1 ? '' : 's'} · ${boardCount} board${boardCount === 1 ? '' : 's'}`
  };
}

function normalizeSpamText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function formBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 1 || ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function removeImageFields(post) {
  for (const field of ['image', 'imageName', 'imageBytes', 'imageMime', 'width', 'height', 'md5', 'sha256', 'spoiler']) {
    delete post[field];
  }
  post.imageDeleted = true;
}

class BoardService {
  constructor(config, store, uploads) {
    this.config = config;
    this.store = store;
    this.uploads = uploads;
  }

  getData() {
    return this.store.read();
  }

  getBoards(data = this.getData(), includeDisabled = false) {
    return includeDisabled
      ? data.boards
      : data.boards.filter(board => board.enabled);
  }

  getBoard(uri, data = this.getData()) {
    return data.boards.find(board => board.uri === String(uri || '').trim().toLowerCase()) || null;
  }

  getBoardById(id, data = this.getData()) {
    return data.boards.find(board => board.id === String(id || '')) || null;
  }

  getDefaultBoard(data = this.getData()) {
    const configured = this.getBoard(this.config.board?.uri || defaultBoardUri(this.config), data);
    if (configured && configured.enabled) return configured;
    return data.boards.find(board => board.enabled) || data.boards[0];
  }

  boardThreads(data = this.getData(), boardId = null) {
    return boardId ? data.threads.filter(thread => thread.boardId === boardId) : data.threads;
  }

  getSortedThreads(data = this.getData(), boardId = null) {
    return sortedThreads(data, boardId);
  }

  getPage(page = 1, boardUri = null, data = this.getData()) {
    const board = boardUri ? this.getBoard(boardUri, data) : null;
    const boardId = board ? board.id : null;
    const threads = sortedThreads(data, boardId);
    const totalPages = Math.max(1, Math.ceil(threads.length / this.config.limits.threadsPerPage));
    const currentPage = Number.parseInt(page, 10);
    if (!Number.isInteger(currentPage) || currentPage < 1 || currentPage > totalPages) return null;
    const start = (currentPage - 1) * this.config.limits.threadsPerPage;
    return {
      data,
      board,
      threads: threads.slice(start, start + this.config.limits.threadsPerPage),
      allThreads: threads,
      page: currentPage,
      totalPages,
      stats: boardStats(threads)
    };
  }

  getThread(id, data = this.getData()) {
    return data.threads.find(thread => thread.id === Number.parseInt(id, 10)) || null;
  }

  getStats(data = this.getData(), boardUri = null) {
    if (boardUri) {
      const board = this.getBoard(boardUri, data);
      if (!board) return boardStats([]);
      return boardStats(sortedThreads(data, board.id));
    }
    return siteStats(data, this.config.uploadDir);
  }

  getSiteStats(data = this.getData()) {
    return siteStats(data, this.config.uploadDir);
  }

  fingerprint(clientKey, data) {
    return crypto.createHmac('sha256', data.meta.siteSecret).update(`poster:${clientKey}`).digest('base64url');
  }

  posterId(posterKey, threadId, secret) {
    if (!this.config.features.posterIds) return '';
    return crypto.createHmac('sha256', secret).update(`id:${posterKey}:${threadId}`).digest('base64url').slice(0, 8);
  }

  assertNotBanned(data, posterKey) {
    const now = Date.now();
    const ban = data.bans.find(item => item.active !== false
      && item.posterKey === posterKey
      && (!item.expiresAt || Number(item.expiresAt) > now));
    if (ban) throw httpError(403, `Posting is blocked${ban.reason ? `: ${ban.reason}` : '.'}`);
  }

  applyWordFilters(comment) {
    let filtered = comment;
    for (const filter of this.config.wordFilters || []) {
      const find = String(filter?.find || '');
      if (!find) continue;
      filtered = filtered.split(find).join(String(filter.replace ?? ''));
    }
    return filtered;
  }

  isFortuneName(rawName) {
    return Boolean(this.config.features?.fortunes)
      && Array.isArray(this.config.fortunes)
      && this.config.fortunes.length > 0
      && String(rawName || '').toLowerCase() === '#fortune';
  }

  randomFortune() {
    const fortunes = this.config.fortunes;
    return fortunes[Math.floor(Math.random() * fortunes.length)];
  }

  anonymousName() {
    return this.config.board?.anonymousName || this.config.anonymousName || 'Anonymous';
  }

  validateText(input, image, isThread) {
    const limits = this.config.limits;
    const anon = this.anonymousName();
    let rawName = cleanText(input.name, anon);
    const title = cleanText(input.title || input.subject || input.sub || '');
    let comment = this.applyWordFilters(cleanText(input.comment || input.com || ''));

    if (this.isFortuneName(rawName)) {
      rawName = anon;
      const fortuneLine = `>Your fortune: ${this.randomFortune()}`;
      comment = comment ? `${fortuneLine}\n${comment}` : fortuneLine;
    }

    if (rawName.length > limits.maxNameLength) throw httpError(400, `Name is limited to ${limits.maxNameLength} characters.`);
    if (title.length > limits.maxSubjectLength) throw httpError(400, `Subject is limited to ${limits.maxSubjectLength} characters.`);
    if (comment.length > limits.maxCommentLength) throw httpError(400, `Comment is limited to ${limits.maxCommentLength} characters.`);
    if (!comment && !image) throw httpError(400, 'A comment or image is required.');
    if (comment.split('\n').length > limits.maxCommentLines) throw httpError(400, `Comments are limited to ${limits.maxCommentLines} lines.`);

    const linkCount = (comment.match(/https?:\/\//gi) || []).length;
    if (linkCount > limits.maxLinks) throw httpError(400, `Comments are limited to ${limits.maxLinks} links.`);
    const citeCount = (comment.match(/(?:^|[^>])>>\d+/g) || []).length;
    if (citeCount > limits.maxCites) throw httpError(400, `Comments are limited to ${limits.maxCites} citations.`);
    if (isThread && this.config.features.requireImageForThread && !image) {
      throw httpError(400, 'Starting a thread requires an image.');
    }

    return { rawName, title, comment };
  }

  postIdentity(rawName, password, posterKey, threadId, data) {
    const identity = parseNameAndTrip(
      rawName,
      this.anonymousName(),
      data.meta.siteSecret,
      this.config.features.tripcodes
    );
    return {
      ...identity,
      passwordHash: hashPassword(password),
      posterKey,
      posterId: this.posterId(posterKey, threadId, data.meta.siteSecret)
    };
  }

  assertUniqueImage(data, image) {
    if (!image || !this.config.features.rejectDuplicateImages) return;
    if (allPosts(data).some(entry => entry.post.sha256 && entry.post.sha256 === image.sha256)) {
      throw httpError(409, 'That image has already been posted.');
    }
  }

  pruneThreads(data, boardId = null) {
    const pool = boardId ? data.threads.filter(thread => thread.boardId === boardId) : data.threads;
    const removed = [];
    while (pool.length > this.config.limits.maxThreads) {
      const candidates = pool.filter(thread => !thread.sticky);
      if (!candidates.length) break;
      candidates.sort((left, right) => Number(left.bumpedAt) - Number(right.bumpedAt));
      const index = data.threads.findIndex(thread => thread.id === candidates[0].id);
      const [thread] = data.threads.splice(index, 1);
      removed.push(thread);
      pool.splice(pool.findIndex(t => t.id === thread.id), 1);
    }
    if (removed.length) {
      const removedIds = removed.flatMap(thread => [thread.id, ...thread.replies.map(reply => reply.id)]);
      this.removeRelatedReports(data, removedIds);
    }
    return removed;
  }

  async createThread(input, image, context) {
    const fields = this.validateText(input, image, true);
    const removed = [];
    const transaction = await this.store.update(data => {
      const board = this.getBoardById(context.boardId, data);
      if (!board || !board.enabled) throw httpError(404, 'Board not found.');
      const posterKey = this.fingerprint(context.clientKey, data);
      this.assertNotBanned(data, posterKey);
      this.assertUniqueImage(data, image);
      data.lastId += 1;
      const now = Date.now();
      const identity = this.postIdentity(fields.rawName, input.password || input.pwd, posterKey, data.lastId, data);
      const thread = {
        id: data.lastId,
        boardId: board.id,
        ...identity,
        title: fields.title,
        comment: fields.comment,
        createdAt: now,
        bumpedAt: now,
        sticky: false,
        locked: false,
        cyclic: false,
        spoiler: formBoolean(input.spoiler),
        ...(image || {}),
        replies: []
      };
      data.threads.push(thread);
      removed.push(...this.pruneThreads(data, board.id));
      return { id: thread.id, threadId: thread.id };
    });

    for (const thread of removed) {
      this.uploads.removePost(thread);
      for (const reply of thread.replies) this.uploads.removePost(reply);
    }
    return transaction.result;
  }

  async createReply(threadId, input, image, context) {
    const fields = this.validateText(input, image, false);
    const removedReplies = [];
    const transaction = await this.store.update(data => {
      const thread = this.getThread(threadId, data);
      if (!thread) throw httpError(404, 'Thread not found.');
      if (thread.locked) throw httpError(403, 'This thread is locked.');

      if (context.boardUri) {
        const board = this.getBoard(context.boardUri, data);
        if (!board || board.id !== thread.boardId) throw httpError(404, 'Thread not found.');
      }

      const posterKey = this.fingerprint(context.clientKey, data);
      this.assertNotBanned(data, posterKey);
      this.assertUniqueImage(data, image);

      const normalized = normalizeSpamText(fields.comment);
      if (normalized.length >= 8) {
        const duplicates = thread.replies.slice(-20)
          .filter(reply => normalizeSpamText(reply.comment) === normalized).length;
        if (duplicates >= 2) throw httpError(409, 'Duplicate reply detected.');
      }

      if (thread.replies.length >= this.config.limits.replyLimit) {
        if (!thread.cyclic) throw httpError(409, 'This thread has reached the reply limit.');
        const removed = thread.replies.shift();
        if (removed) {
          removedReplies.push(removed);
          this.removeRelatedReports(data, [removed.id]);
        }
      }

      data.lastId += 1;
      const now = Date.now();
      const option = String(input.option || input.email || '').trim().toLowerCase();
      const sage = option === 'sage';
      const bumped = !sage && thread.replies.length + 1 <= this.config.limits.bumpLimit;
      const identity = this.postIdentity(fields.rawName, input.password || input.pwd, posterKey, thread.id, data);
      const reply = {
        id: data.lastId,
        ...identity,
        comment: fields.comment,
        createdAt: now,
        sage,
        bumped,
        email: sage ? 'sage' : '',
        spoiler: formBoolean(input.spoiler),
        ...(image || {})
      };
      thread.replies.push(reply);
      if (bumped) thread.bumpedAt = now;
      return { id: reply.id, threadId: thread.id };
    });

    for (const reply of removedReplies) this.uploads.removePost(reply);
    return transaction.result;
  }

  recalculateBump(thread) {
    const bumpTimes = thread.replies
      .filter((reply, index) => reply.bumped === undefined
        ? (!reply.sage && index + 1 <= this.config.limits.bumpLimit)
        : reply.bumped)
      .map(reply => Number(reply.createdAt) || 0);
    thread.bumpedAt = Math.max(Number(thread.createdAt) || 0, ...bumpTimes);
  }

  removeRelatedReports(data, postIds) {
    const ids = new Set(postIds);
    data.reports = data.reports.filter(report => !ids.has(Number(report.postId)));
  }

  async deleteByPassword(rawIds, password, fileOnly = false) {
    if (!this.config.features.userDeletion) throw httpError(403, 'User deletion is disabled.');
    const ids = [...new Set((Array.isArray(rawIds) ? rawIds : [rawIds])
      .map(id => Number.parseInt(id, 10)).filter(id => id > 0))];
    if (!ids.length) throw httpError(400, 'Select at least one post to delete.');
    const removedPosts = [];

    const transaction = await this.store.update(data => {
      const targets = ids.map(id => findPost(data, id));
      if (targets.some(target => !target)) throw httpError(404, 'One or more selected posts no longer exist.');
      for (const target of targets) {
        if (!verifyPassword(password, target.post.passwordHash)) throw httpError(403, 'Incorrect deletion password.');
        const age = Date.now() - Number(target.post.createdAt);
        if (age < this.config.limits.deleteDelaySeconds * 1000) throw httpError(409, 'That post is too new to delete.');
      }

      if (fileOnly) {
        for (const target of targets) {
          if (!target.post.image) continue;
          removedPosts.push({ ...target.post });
          removeImageFields(target.post);
        }
        return { deleted: ids, fileOnly: true };
      }

      const deletedIds = new Set();
      for (const target of targets.filter(item => item.isThread)) {
        const threadIndex = data.threads.findIndex(thread => thread.id === target.thread.id);
        if (threadIndex < 0) continue;
        const [thread] = data.threads.splice(threadIndex, 1);
        removedPosts.push(thread, ...thread.replies);
        deletedIds.add(thread.id);
        thread.replies.forEach(reply => deletedIds.add(reply.id));
      }
      for (const id of ids) {
        if (deletedIds.has(id)) continue;
        const target = findPost(data, id);
        if (!target || target.isThread) continue;
        const [reply] = target.thread.replies.splice(target.replyIndex, 1);
        removedPosts.push(reply);
        deletedIds.add(reply.id);
        this.recalculateBump(target.thread);
      }
      this.removeRelatedReports(data, deletedIds);
      return { deleted: [...deletedIds], fileOnly: false };
    });

    for (const post of removedPosts) this.uploads.removePost(post);
    return transaction.result;
  }

  async reportPost(postId, reason) {
    if (!this.config.features.reports) throw httpError(404, 'Reports are disabled.');
    const cleanReason = cleanText(reason);
    if (cleanReason.length < 3 || cleanReason.length > 500) throw httpError(400, 'Report reason must be between 3 and 500 characters.');
    return (await this.store.update(data => {
      const target = findPost(data, postId);
      if (!target) throw httpError(404, 'Post not found.');
      const duplicate = data.reports.some(report => Number(report.postId) === target.post.id && report.reason === cleanReason);
      if (duplicate) throw httpError(409, 'That report has already been submitted.');
      const report = {
        id: crypto.randomUUID(),
        postId: target.post.id,
        threadId: target.threadId,
        reason: cleanReason,
        createdAt: Date.now()
      };
      data.reports.push(report);
      return report;
    })).result;
  }

  logModeration(data, action, detail) {
    data.moderationLog.push({ id: crypto.randomUUID(), action, detail, createdAt: Date.now() });
    data.moderationLog = data.moderationLog.slice(-200);
  }

  async adminDelete(postId) {
    const removedPosts = [];
    const transaction = await this.store.update(data => {
      const target = findPost(data, postId);
      if (!target) throw httpError(404, 'Post not found.');
      const deletedIds = [];
      if (target.isThread) {
        const index = data.threads.findIndex(thread => thread.id === target.thread.id);
        const [thread] = data.threads.splice(index, 1);
        removedPosts.push(thread, ...thread.replies);
        deletedIds.push(thread.id, ...thread.replies.map(reply => reply.id));
      } else {
        const [reply] = target.thread.replies.splice(target.replyIndex, 1);
        removedPosts.push(reply);
        deletedIds.push(reply.id);
        this.recalculateBump(target.thread);
      }
      this.removeRelatedReports(data, deletedIds);
      this.logModeration(data, 'delete', `Deleted post No.${Number(postId)}`);
      return { deleted: deletedIds };
    });
    removedPosts.forEach(post => this.uploads.removePost(post));
    return transaction.result;
  }

  async setThreadFlag(threadId, flag, value) {
    if (!['sticky', 'locked', 'cyclic'].includes(flag)) throw httpError(400, 'Unknown thread setting.');
    return (await this.store.update(data => {
      const thread = this.getThread(threadId, data);
      if (!thread) throw httpError(404, 'Thread not found.');
      thread[flag] = Boolean(value);
      this.logModeration(data, 'thread-setting', `Set ${flag}=${Boolean(value)} on No.${thread.id}`);
      return { threadId: thread.id, flag, value: thread[flag] };
    })).result;
  }

  async dismissReport(reportId) {
    return (await this.store.update(data => {
      const index = data.reports.findIndex(report => report.id === reportId);
      if (index < 0) throw httpError(404, 'Report not found.');
      const [report] = data.reports.splice(index, 1);
      this.logModeration(data, 'dismiss-report', `Dismissed report for No.${report.postId}`);
      return report;
    })).result;
  }

  async banPost(postId, durationMs, reason) {
    return (await this.store.update(data => {
      const target = findPost(data, postId);
      if (!target) throw httpError(404, 'Post not found.');
      if (!target.post.posterKey) throw httpError(409, 'This legacy post has no poster fingerprint to ban.');
      const cleanReason = cleanText(reason, 'Rule violation').slice(0, 300);
      const duration = Math.max(0, Number(durationMs) || 0);
      const ban = {
        id: crypto.randomUUID(),
        posterKey: target.post.posterKey,
        reason: cleanReason,
        createdAt: Date.now(),
        expiresAt: duration ? Date.now() + duration : 0,
        active: true
      };
      data.bans.push(ban);
      this.logModeration(data, 'ban', `Banned poster of No.${target.post.id}: ${cleanReason}`);
      return ban;
    })).result;
  }

  async unban(banId) {
    return (await this.store.update(data => {
      const ban = data.bans.find(item => item.id === banId);
      if (!ban) throw httpError(404, 'Ban not found.');
      ban.active = false;
      this.logModeration(data, 'unban', `Lifted ban ${ban.id}`);
      return ban;
    })).result;
  }

  async addBoard(fields) {
    return (await this.store.update(data => {
      const existingUris = new Set(data.boards.map(board => board.uri));
      const uri = validateBoardUri(fields.uri, existingUris);
      const board = {
        id: uri,
        uri,
        name: cleanText(fields.name, uri),
        description: cleanText(fields.description || ''),
        category: cleanText(fields.category || 'Other'),
        createdAt: Date.now(),
        enabled: formBoolean(fields.enabled, true),
        path: `/${uri}/`
      };
      data.boards.push(board);
      this.logModeration(data, 'board-add', `Added board /${uri}/`);
      return board;
    })).result;
  }

  async updateBoard(uri, fields) {
    return (await this.store.update(data => {
      const board = this.getBoard(uri, data);
      if (!board) throw httpError(404, 'Board not found.');
      const existingUris = new Set(data.boards.map(b => b.uri));
      existingUris.delete(board.uri);
      const newUri = fields.uri ? validateBoardUri(fields.uri, existingUris) : board.uri;

      if (newUri !== board.uri) {
        const oldUri = board.uri;
        board.id = newUri;
        board.uri = newUri;
        board.path = `/${newUri}/`;
        for (const thread of data.threads) {
          if (thread.boardId === oldUri) thread.boardId = newUri;
        }
      }

      board.name = cleanText(fields.name, board.name);
      board.description = cleanText(fields.description, board.description);
      board.category = cleanText(fields.category, board.category);
      if (fields.enabled !== undefined && fields.enabled !== null) {
        board.enabled = formBoolean(fields.enabled);
      }
      this.logModeration(data, 'board-edit', `Edited board /${board.uri}/`);
      return board;
    })).result;
  }

  async toggleBoard(uri) {
    return (await this.store.update(data => {
      const board = this.getBoard(uri, data);
      if (!board) throw httpError(404, 'Board not found.');
      board.enabled = !board.enabled;
      this.logModeration(data, 'board-toggle', `${board.enabled ? 'Enabled' : 'Disabled'} board /${board.uri}/`);
      return board;
    })).result;
  }

  async deleteBoard(uri) {
    return (await this.store.update(data => {
      const board = this.getBoard(uri, data);
      if (!board) throw httpError(404, 'Board not found.');
      const defaultBoard = this.getDefaultBoard(data);
      if (board.id === defaultBoard.id) {
        throw httpError(400, 'Cannot delete the default board.');
      }
      for (const thread of data.threads) {
        if (thread.boardId === board.id) thread.boardId = defaultBoard.id;
      }
      data.boards = data.boards.filter(b => b.uri !== uri);
      this.logModeration(data, 'board-delete', `Deleted board /${uri}/; threads moved to /${defaultBoard.uri}/`);
      return board;
    })).result;
  }

  search(query) {
    const displayQuery = cleanText(query).slice(0, 100);
    const term = displayQuery.toLowerCase();
    if (!term) return { query: '', results: [] };
    const data = this.getData();
    const results = [];
    for (const entry of allPosts(data)) {
      const haystack = `${entry.post.title || ''}\n${entry.post.name || ''}\n${entry.post.comment || ''}`.toLowerCase();
      if (haystack.includes(term)) results.push(entry);
      if (results.length >= 100) break;
    }
    return { query: displayQuery, results, data };
  }

  latestPosts(limit = 50, data = this.getData()) {
    const boardMap = new Map(data.boards.map(board => [board.id, board]));
    const entries = allPosts(data)
      .map(entry => ({ ...entry, board: boardMap.get(entry.thread.boardId) }))
      .filter(entry => entry.board && entry.board.enabled)
      .sort((left, right) => Number(right.post.createdAt) - Number(left.post.createdAt));
    return entries.slice(0, limit);
  }
}

module.exports = { BoardService, boardStats, findPost, sortedThreads, siteStats };
