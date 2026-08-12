'use strict';

const crypto = require('node:crypto');
const { allPosts } = require('./store');
const {
  cleanText,
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

function sortedThreads(data) {
  return [...data.threads].sort((left, right) => {
    if (Boolean(left.sticky) !== Boolean(right.sticky)) return left.sticky ? -1 : 1;
    return Number(right.bumpedAt || right.createdAt) - Number(left.bumpedAt || left.createdAt);
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

function normalizeSpamText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function formBoolean(value) {
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

  getSortedThreads(data = this.getData()) {
    return sortedThreads(data);
  }

  getPage(page = 1, data = this.getData()) {
    const threads = sortedThreads(data);
    const totalPages = Math.max(1, Math.ceil(threads.length / this.config.limits.threadsPerPage));
    const currentPage = Number.parseInt(page, 10);
    if (!Number.isInteger(currentPage) || currentPage < 1 || currentPage > totalPages) return null;
    const start = (currentPage - 1) * this.config.limits.threadsPerPage;
    return {
      data,
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

  getStats(data = this.getData()) {
    return boardStats(sortedThreads(data));
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

  validateText(input, image, isThread) {
    const limits = this.config.limits;
    let rawName = cleanText(input.name, this.config.board.anonymousName);
    const title = cleanText(input.title || input.subject || input.sub || '');
    let comment = this.applyWordFilters(cleanText(input.comment || input.com || ''));

    if (this.isFortuneName(rawName)) {
      rawName = this.config.board.anonymousName;
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
      this.config.board.anonymousName,
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

  pruneThreads(data) {
    const removed = [];
    while (data.threads.length > this.config.limits.maxThreads) {
      const candidates = data.threads.filter(thread => !thread.sticky);
      if (!candidates.length) break;
      candidates.sort((left, right) => Number(left.bumpedAt) - Number(right.bumpedAt));
      const index = data.threads.findIndex(thread => thread.id === candidates[0].id);
      removed.push(...data.threads.splice(index, 1));
    }
    if (removed.length) {
      const removedIds = removed.flatMap(thread => [thread.id, ...thread.replies.map(reply => reply.id)]);
      this.removeRelatedReports(data, removedIds);
    }
    return removed;
  }

  createThread(input, image, context) {
    const fields = this.validateText(input, image, true);
    const removed = [];
    const transaction = this.store.update(data => {
      const posterKey = this.fingerprint(context.clientKey, data);
      this.assertNotBanned(data, posterKey);
      this.assertUniqueImage(data, image);
      data.lastId += 1;
      const now = Date.now();
      const identity = this.postIdentity(fields.rawName, input.password || input.pwd, posterKey, data.lastId, data);
      const thread = {
        id: data.lastId,
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
      removed.push(...this.pruneThreads(data));
      return { id: thread.id, threadId: thread.id };
    });

    for (const thread of removed) {
      this.uploads.removePost(thread);
      for (const reply of thread.replies) this.uploads.removePost(reply);
    }
    return transaction.result;
  }

  createReply(threadId, input, image, context) {
    const fields = this.validateText(input, image, false);
    const removedReplies = [];
    const transaction = this.store.update(data => {
      const thread = this.getThread(threadId, data);
      if (!thread) throw httpError(404, 'Thread not found.');
      if (thread.locked) throw httpError(403, 'This thread is locked.');
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

  deleteByPassword(rawIds, password, fileOnly = false) {
    if (!this.config.features.userDeletion) throw httpError(403, 'User deletion is disabled.');
    const ids = [...new Set((Array.isArray(rawIds) ? rawIds : [rawIds])
      .map(id => Number.parseInt(id, 10)).filter(id => id > 0))];
    if (!ids.length) throw httpError(400, 'Select at least one post to delete.');
    const removedPosts = [];

    const transaction = this.store.update(data => {
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

  reportPost(postId, reason) {
    if (!this.config.features.reports) throw httpError(404, 'Reports are disabled.');
    const cleanReason = cleanText(reason);
    if (cleanReason.length < 3 || cleanReason.length > 500) throw httpError(400, 'Report reason must be between 3 and 500 characters.');
    return this.store.update(data => {
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
    }).result;
  }

  logModeration(data, action, detail) {
    data.moderationLog.push({ id: crypto.randomUUID(), action, detail, createdAt: Date.now() });
    data.moderationLog = data.moderationLog.slice(-200);
  }

  adminDelete(postId) {
    const removedPosts = [];
    const transaction = this.store.update(data => {
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

  setThreadFlag(threadId, flag, value) {
    if (!['sticky', 'locked', 'cyclic'].includes(flag)) throw httpError(400, 'Unknown thread setting.');
    return this.store.update(data => {
      const thread = this.getThread(threadId, data);
      if (!thread) throw httpError(404, 'Thread not found.');
      thread[flag] = Boolean(value);
      this.logModeration(data, 'thread-setting', `Set ${flag}=${Boolean(value)} on No.${thread.id}`);
      return { threadId: thread.id, flag, value: thread[flag] };
    }).result;
  }

  dismissReport(reportId) {
    return this.store.update(data => {
      const index = data.reports.findIndex(report => report.id === reportId);
      if (index < 0) throw httpError(404, 'Report not found.');
      const [report] = data.reports.splice(index, 1);
      this.logModeration(data, 'dismiss-report', `Dismissed report for No.${report.postId}`);
      return report;
    }).result;
  }

  banPost(postId, durationMs, reason) {
    return this.store.update(data => {
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
    }).result;
  }

  unban(banId) {
    return this.store.update(data => {
      const ban = data.bans.find(item => item.id === banId);
      if (!ban) throw httpError(404, 'Ban not found.');
      ban.active = false;
      this.logModeration(data, 'unban', `Lifted ban ${ban.id}`);
      return ban;
    }).result;
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
}

module.exports = { BoardService, boardStats, findPost, sortedThreads };
