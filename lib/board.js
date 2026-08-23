'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  allPosts,
  defaultBoardUri,
  normalizeBoardAppearance,
  normalizeBoardSettings,
  normalizeCustomization
} = require('./store');
const { validateBoardUri } = require('./boards');
const {
  ROLES,
  USERNAME_PATTERN,
  canAssignRole,
  canManageAccount,
  normalizeUsername,
  staffCan
} = require('./staff');
const {
  cleanText,
  formatBytes,
  hashPassword,
  httpError,
  parseNameAndTrip,
  verifyPassword
} = require('./utils');
const {
  postAttachments,
  removePostAttachments,
  restorePostAttachments,
  syncPrimaryAttachment
} = require('./post-media');

const DUMMY_STAFF_PASSWORD_HASH = 'scrypt$BwcHBwcHBwcHBwcHBwcHBw$GKYWtQJHPAUWMYDDM64Z3uAtYBUxFuquueA16wVbm9M';

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
  const threads = data.threads.filter(thread => !thread.archived && (!boardId || thread.boardId === boardId));
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
  const threads = data.threads.filter(thread => !thread.archived);
  const posts = threads.flatMap(thread => [thread, ...thread.replies]);
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
  if (Array.isArray(value)) return formBoolean(value.at(-1), fallback);
  return value === true || value === 1 || ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function uploadCandidates(value) {
  return (Array.isArray(value) ? value : [value]).filter(Boolean);
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

  publicStaffAccount(account) {
    if (!account) return null;
    const { passwordHash, ...publicAccount } = account;
    return structuredClone(publicAccount);
  }

  getStaffAccounts(data = this.getData()) {
    return data.staff
      .map(account => this.publicStaffAccount(account))
      .sort((left, right) => left.username.localeCompare(right.username));
  }

  resolveStaffSession(session, data = this.getData()) {
    if (!session) return null;
    if (!session.accountId) {
      if (!this.config.adminPassword) return null;
      return {
        id: 'legacy-root',
        username: 'environment-admin',
        displayName: 'Environment administrator',
        role: 'root',
        scope: 'global',
        boardIds: [],
        enabled: true,
        sessionVersion: 1,
        legacy: true
      };
    }
    const account = data.staff.find(item => item.id === session.accountId);
    if (!account || account.enabled === false) return null;
    if (Number(session.sessionVersion) !== account.sessionVersion) return null;
    return this.publicStaffAccount(account);
  }

  moderationDataFor(staff, data = this.getData()) {
    const withoutAccounts = { ...data, staff: [] };
    if (!staff || staff.scope === 'global') return withoutAccounts;
    const boardIds = new Set(staff.boardIds);
    return {
      ...withoutAccounts,
      boards: data.boards.filter(board => boardIds.has(board.id)),
      threads: data.threads.filter(thread => boardIds.has(thread.boardId)),
      reports: data.reports.filter(report => boardIds.has(report.boardId)),
      bans: data.bans.filter(sanction => sanction.scope === 'board' && boardIds.has(sanction.boardId)),
      appeals: data.appeals.filter(appeal => appeal.boardId && boardIds.has(appeal.boardId)),
      trash: data.trash.filter(entry => boardIds.has(entry.boardId)),
      revisions: data.revisions.filter(revision => boardIds.has(revision.boardId)),
      moderationLog: data.moderationLog.filter(entry => entry.boardId && boardIds.has(entry.boardId))
    };
  }

  async authenticateStaff(username, password) {
    const normalizedUsername = normalizeUsername(username);
    const snapshot = this.getData();
    const candidate = snapshot.staff.find(account => account.username === normalizedUsername);
    const valid = verifyPassword(password, candidate?.passwordHash || DUMMY_STAFF_PASSWORD_HASH);
    if (!candidate || candidate.enabled === false || !valid) return null;

    return (await this.store.update(data => {
      const account = data.staff.find(item => item.id === candidate.id);
      if (!account || account.enabled === false || account.passwordHash !== candidate.passwordHash) return null;
      account.lastLoginAt = Date.now();
      return this.publicStaffAccount(account);
    })).result;
  }

  cleanStaffPassword(value, required = true) {
    const password = String(value || '');
    if (!password && !required) return '';
    if (password.length < 12 || password.length > 256) {
      throw httpError(400, 'Staff passwords must be between 12 and 256 characters.');
    }
    return password;
  }

  normalizeStaffScope(role, scope, rawBoardIds, data) {
    if (['root', 'admin'].includes(role) || scope === 'global') {
      return { scope: 'global', boardIds: [] };
    }
    if (scope !== 'boards') throw httpError(400, 'Unknown staff scope.');
    const values = Array.isArray(rawBoardIds) ? rawBoardIds : [rawBoardIds];
    const validBoardIds = new Set(data.boards.map(board => board.id));
    const boardIds = [...new Set(values.map(value => String(value || '')).filter(value => validBoardIds.has(value)))];
    if (!boardIds.length) throw httpError(400, 'Board-scoped staff need at least one board.');
    return { scope: 'boards', boardIds };
  }

  async addStaffAccount(fields, actor) {
    const username = normalizeUsername(fields.username);
    if (!USERNAME_PATTERN.test(username)) {
      throw httpError(400, 'Staff usernames must be 3–32 lowercase letters, numbers, dots, underscores, or hyphens.');
    }
    const displayName = cleanText(fields.displayName, username).slice(0, 80);
    const role = String(fields.role || 'janitor');
    if (!ROLES.includes(role) || !canAssignRole(actor, role)) throw httpError(403, 'You cannot assign that staff role.');
    const passwordHash = hashPassword(this.cleanStaffPassword(fields.password));

    return (await this.store.update(data => {
      const currentActor = this.currentStaffActor(actor, data);
      if (!canAssignRole(currentActor, role)) throw httpError(403, 'You cannot assign that staff role.');
      if (data.staff.length >= this.config.limits.maxStaffAccounts) {
        throw httpError(409, `Staff accounts are limited to ${this.config.limits.maxStaffAccounts}.`);
      }
      if (data.staff.some(account => account.username === username)) {
        throw httpError(409, 'That staff username already exists.');
      }
      const assignment = this.normalizeStaffScope(role, fields.scope, fields.boardIds, data);
      const now = Date.now();
      const account = {
        id: crypto.randomUUID(),
        username,
        displayName,
        passwordHash,
        role,
        ...assignment,
        enabled: formBoolean(fields.enabled, true),
        sessionVersion: 1,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: 0
      };
      data.staff.push(account);
      this.logModeration(data, 'staff-add', `Created ${role} account ${username}`, { actor: currentActor });
      return this.publicStaffAccount(account);
    })).result;
  }

  async updateStaffAccount(accountId, fields, actor) {
    const password = this.cleanStaffPassword(fields.password, false);
    return (await this.store.update(data => {
      const currentActor = this.currentStaffActor(actor, data);
      if (!currentActor) throw httpError(403, 'Your staff session is no longer valid.');
      const account = data.staff.find(item => item.id === String(accountId || ''));
      if (!account) throw httpError(404, 'Staff account not found.');
      const selfUpdate = currentActor.id === account.id;
      if (!selfUpdate && !canManageAccount(currentActor, account)) {
        throw httpError(403, 'You cannot manage that staff account.');
      }

      const role = String(fields.role || account.role);
      if (!ROLES.includes(role)) throw httpError(400, 'Unknown staff role.');
      if (selfUpdate && role !== account.role) throw httpError(403, 'You cannot change your own role.');
      if (!selfUpdate && !canAssignRole(currentActor, role)) throw httpError(403, 'You cannot assign that staff role.');
      const assignment = this.normalizeStaffScope(role, fields.scope || account.scope, fields.boardIds, data);
      if (selfUpdate && (assignment.scope !== account.scope
        || assignment.boardIds.join('\0') !== account.boardIds.join('\0'))) {
        throw httpError(403, 'You cannot change your own scope.');
      }

      const sensitiveChange = role !== account.role
        || assignment.scope !== account.scope
        || assignment.boardIds.join('\0') !== account.boardIds.join('\0')
        || Boolean(password);
      account.displayName = cleanText(fields.displayName, account.displayName).slice(0, 80);
      account.role = role;
      account.scope = assignment.scope;
      account.boardIds = assignment.boardIds;
      if (password) account.passwordHash = hashPassword(password);
      if (sensitiveChange) account.sessionVersion += 1;
      account.updatedAt = Date.now();
      this.logModeration(data, 'staff-edit', `Updated staff account ${account.username}`, { actor: currentActor });
      return this.publicStaffAccount(account);
    })).result;
  }

  async toggleStaffAccount(accountId, actor) {
    return (await this.store.update(data => {
      const currentActor = this.currentStaffActor(actor, data);
      if (!currentActor) throw httpError(403, 'Your staff session is no longer valid.');
      const account = data.staff.find(item => item.id === String(accountId || ''));
      if (!account) throw httpError(404, 'Staff account not found.');
      if (!canManageAccount(currentActor, account)) throw httpError(403, 'You cannot manage that staff account.');
      account.enabled = !account.enabled;
      account.sessionVersion += 1;
      account.updatedAt = Date.now();
      this.logModeration(
        data,
        'staff-toggle',
        `${account.enabled ? 'Enabled' : 'Disabled'} staff account ${account.username}`,
        { actor: currentActor }
      );
      return this.publicStaffAccount(account);
    })).result;
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
    return data.threads.filter(thread => !thread.archived && (!boardId || thread.boardId === boardId));
  }

  getSortedThreads(data = this.getData(), boardId = null) {
    return sortedThreads(data, boardId);
  }

  getArchivedThreads(data = this.getData(), boardId = null) {
    return data.threads
      .filter(thread => thread.archived && (!boardId || thread.boardId === boardId))
      .sort((left, right) => Number(right.archivedAt) - Number(left.archivedAt));
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

  reporterFingerprint(clientKey, data) {
    if (!clientKey) return '';
    return crypto.createHmac('sha256', data.meta.siteSecret).update(`reporter:${clientKey}`).digest('base64url');
  }

  boardSetting(board, key, fallback) {
    return Object.hasOwn(board?.settings || {}, key) ? board.settings[key] : fallback;
  }

  posterId(posterKey, threadId, secret, enabled = this.config.features.posterIds) {
    if (!enabled) return '';
    return crypto.createHmac('sha256', secret).update(`id:${posterKey}:${threadId}`).digest('base64url').slice(0, 8);
  }

  sanctionMatches(sanction, posterKey, boardId, upload) {
    if (sanction.active === false) return false;
    const now = Date.now();
    if (sanction.kind === 'ban' && sanction.expiresAt && Number(sanction.expiresAt) <= now) return false;
    if (sanction.scope === 'board' && sanction.boardId !== boardId) return false;
    if (sanction.target === 'file') {
      return uploadCandidates(upload).some(candidate => candidate.sha256 && sanction.fileHash === candidate.sha256);
    }
    return Boolean(posterKey) && sanction.posterKey === posterKey;
  }

  postingRestriction(data, posterKey, boardId, upload) {
    const matches = data.bans.filter(sanction => this.sanctionMatches(sanction, posterKey, boardId, upload));
    return matches.find(sanction => sanction.kind === 'ban')
      || matches.find(sanction => sanction.kind === 'warning')
      || null;
  }

  banError(sanction) {
    const visibleReason = sanction.reasonVisible && sanction.reason ? `: ${sanction.reason}` : '.';
    const error = httpError(403, `Posting is blocked${visibleReason}`);
    error.appealUrl = `/appeals/${encodeURIComponent(sanction.appealId)}`;
    return error;
  }

  consumeWarning(sanction) {
    const now = Date.now();
    sanction.active = false;
    sanction.deliveredAt = now;
    sanction.updatedAt = now;
    return {
      warning: true,
      message: sanction.reasonVisible && sanction.reason
        ? `Staff warning: ${sanction.reason} Retry your post after reviewing this warning.`
        : 'Staff issued a warning for this posting identity. Retry your post after reviewing it.'
    };
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

  anonymousName(board = null) {
    return board?.settings?.anonymousName
      || this.config.board?.anonymousName
      || this.config.anonymousName
      || 'Anonymous';
  }

  validateText(input, image, isThread, board = null) {
    const limits = this.config.limits;
    const anon = this.anonymousName(board);
    let rawName = cleanText(input.name, anon);
    const title = cleanText(input.title || input.subject || input.sub || '');
    const comment = this.applyWordFilters(cleanText(input.comment || input.com || ''));
    let fortune = '';

    if (this.isFortuneName(rawName)) {
      rawName = anon;
      fortune = this.randomFortune();
    }

    if (rawName.length > limits.maxNameLength) throw httpError(400, `Name is limited to ${limits.maxNameLength} characters.`);
    if (title.length > limits.maxSubjectLength) throw httpError(400, `Subject is limited to ${limits.maxSubjectLength} characters.`);
    if (comment.length > limits.maxCommentLength) throw httpError(400, `Comment is limited to ${limits.maxCommentLength} characters.`);
    const hasAttachment = uploadCandidates(image).length > 0;
    if (!comment && !fortune && !hasAttachment) throw httpError(400, 'A comment or attachment is required.');
    if (comment.split('\n').length > limits.maxCommentLines) throw httpError(400, `Comments are limited to ${limits.maxCommentLines} lines.`);

    const linkCount = (comment.match(/https?:\/\//gi) || []).length;
    if (linkCount > limits.maxLinks) throw httpError(400, `Comments are limited to ${limits.maxLinks} links.`);
    const citeCount = (comment.match(/(?:^|[^>])>>\d+/g) || []).length;
    if (citeCount > limits.maxCites) throw httpError(400, `Comments are limited to ${limits.maxCites} citations.`);
    const requireImage = this.boardSetting(board, 'requireImageForThread', this.config.features.requireImageForThread);
    if (isThread && requireImage && !hasAttachment) {
      throw httpError(400, 'Starting a thread requires an image.');
    }

    return { rawName, title, comment, fortune };
  }

  postIdentity(rawName, password, posterKey, threadId, data, board = null) {
    const identity = parseNameAndTrip(
      rawName,
      this.anonymousName(board),
      data.meta.siteSecret,
      this.config.features.tripcodes
    );
    return {
      ...identity,
      passwordHash: hashPassword(password),
      posterKey,
      posterId: this.posterId(
        posterKey,
        threadId,
        data.meta.siteSecret,
        this.boardSetting(board, 'showPosterIds', this.config.features.posterIds)
      )
    };
  }

  capcodeFor(context, boardId, data) {
    if (!context?.capcode) return '';
    const actor = this.currentStaffActor(context.actor, data);
    if (!actor || !staffCan(actor, 'posts.capcode', boardId)) {
      throw httpError(403, 'A current staff session with posting permission is required for a capcode.');
    }
    return actor.role;
  }

  assertUniqueImage(data, image, board = null) {
    const reject = this.boardSetting(board, 'rejectDuplicateImages', this.config.features.rejectDuplicateImages);
    const uploads = uploadCandidates(image);
    if (!uploads.length || !reject) return;
    const uploadHashes = uploads.map(upload => upload.sha256).filter(Boolean);
    if (new Set(uploadHashes).size !== uploadHashes.length
      || allPosts(data).some(entry => postAttachments(entry.post)
        .some(attachment => attachment.sha256 && uploadHashes.includes(attachment.sha256)))) {
      throw httpError(409, 'That file has already been posted.');
    }
  }

  assertBoardMediaPolicy(board, image, input) {
    const uploads = uploadCandidates(image);
    const maximum = this.boardSetting(board, 'maxFilesPerPost', this.config.limits.maxFilesPerPost);
    if (uploads.length > maximum) {
      throw httpError(400, `This board allows at most ${maximum} attachment${maximum === 1 ? '' : 's'} per post.`);
    }
    if (uploads.some(upload => upload.mediaKind === 'video')
      && !this.boardSetting(board, 'allowVideoUploads', this.config.features.videoUploads)) {
      throw httpError(403, 'Video uploads are disabled on this board.');
    }
    if (formBoolean(input.spoiler)
      && !this.boardSetting(board, 'allowSpoilers', this.config.features.spoilerImages)) {
      throw httpError(403, 'Attachment spoilers are disabled on this board.');
    }
  }

  registerUpload(data, upload) {
    if (!upload?._asset) return {};
    let asset = data.media.find(item => item.id === upload._asset.id)
      || data.media.find(item => item.sha256 && item.sha256 === upload._asset.sha256);
    if (asset) {
      upload._deduplicated = true;
    } else {
      asset = { ...upload._asset, refCount: 0 };
      data.media.push(asset);
    }
    asset.refCount = Math.max(0, Number(asset.refCount) || 0) + 1;

    return {
      id: crypto.randomUUID(),
      assetId: asset.id,
      image: asset.path,
      imageName: upload.imageName,
      imageBytes: asset.bytes,
      imageMime: asset.mime,
      mediaKind: asset.kind,
      width: asset.width,
      height: asset.height,
      ...(asset.durationMs ? { durationMs: asset.durationMs } : {}),
      ...(asset.frameRate ? { frameRate: asset.frameRate } : {}),
      ...(asset.videoCodec ? { videoCodec: asset.videoCodec } : {}),
      ...(asset.audioCodec ? { audioCodec: asset.audioCodec } : {}),
      ...(asset.thumbnail ? {
        thumbnail: asset.thumbnail,
        thumbnailWidth: asset.thumbnailWidth,
        thumbnailHeight: asset.thumbnailHeight
      } : {}),
      md5: asset.md5,
      sha256: asset.sha256
    };
  }

  registerUploads(data, uploads, spoiler = false) {
    return uploadCandidates(uploads).map(upload => ({
      ...this.registerUpload(data, upload),
      spoiler: Boolean(spoiler)
    }));
  }

  releasePostMedia(data, post, releasedAssets, legacyPosts) {
    for (const attachment of postAttachments(post)) {
      const assetIndex = attachment.assetId
        ? data.media.findIndex(asset => asset.id === attachment.assetId)
        : -1;
      if (assetIndex < 0) {
        legacyPosts.push({ ...attachment });
        continue;
      }
      const asset = data.media[assetIndex];
      asset.refCount = Math.max(0, (Number(asset.refCount) || 0) - 1);
      if (asset.refCount === 0) {
        data.media.splice(assetIndex, 1);
        releasedAssets.push(asset);
      }
    }
  }

  cleanupReleasedMedia(releasedAssets, legacyPosts) {
    for (const asset of releasedAssets) this.uploads.removeAsset(asset);
    for (const post of legacyPosts) this.uploads.removePost(post);
  }

  pruneThreads(data, boardId = null, now = Date.now()) {
    const board = boardId ? this.getBoardById(boardId, data) : null;
    const maximum = this.boardSetting(board, 'maxThreads', this.config.limits.maxThreads);
    const pool = data.threads.filter(thread => !thread.archived && (!boardId || thread.boardId === boardId));
    const archived = [];
    while (pool.length > maximum) {
      const candidates = pool.filter(thread => !thread.sticky);
      if (!candidates.length) break;
      candidates.sort((left, right) => Number(left.bumpedAt) - Number(right.bumpedAt));
      const thread = candidates[0];
      thread.archived = true;
      thread.archivedAt = Number(now);
      archived.push(thread);
      pool.splice(pool.findIndex(t => t.id === thread.id), 1);
    }
    return archived;
  }

  async createThread(input, image, context) {
    const uploads = uploadCandidates(image);
    const transaction = await this.store.update(data => {
      const board = this.getBoardById(context.boardId, data);
      if (!board || !board.enabled) throw httpError(404, 'Board not found.');
      const fields = this.validateText(input, uploads, true, board);
      this.assertBoardMediaPolicy(board, uploads, input);
      const posterKey = this.fingerprint(context.clientKey, data);
      const restriction = this.postingRestriction(data, posterKey, board.id, uploads);
      if (restriction?.kind === 'ban') throw this.banError(restriction);
      if (restriction?.kind === 'warning') return this.consumeWarning(restriction);
      this.assertUniqueImage(data, uploads, board);
      data.lastId += 1;
      const now = Date.now();
      const identity = this.postIdentity(fields.rawName, input.password || input.pwd, posterKey, data.lastId, data, board);
      const capcode = this.capcodeFor(context, board.id, data);
      const attachments = this.registerUploads(data, uploads, formBoolean(input.spoiler));
      const thread = {
        id: data.lastId,
        boardId: board.id,
        ...identity,
        ...(capcode ? { capcode } : {}),
        title: fields.title,
        comment: fields.comment,
        ...(fields.fortune ? { fortune: fields.fortune } : {}),
        createdAt: now,
        bumpedAt: now,
        sticky: false,
        locked: false,
        cyclic: false,
        attachments,
        replies: []
      };
      syncPrimaryAttachment(thread, attachments);
      data.threads.push(thread);
      if (context.actor) {
        this.logModeration(data, 'staff-post', `Posted thread No.${thread.id}${capcode ? ` with ${capcode} capcode` : ''}`, {
          ...context,
          boardId: board.id
        });
      }
      this.pruneThreads(data, board.id);
      return { id: thread.id, threadId: thread.id };
    });

    if (transaction.result.warning) throw httpError(403, transaction.result.message);
    for (const upload of uploads) {
      if (upload._deduplicated) this.uploads.removeCandidate(upload);
    }
    return transaction.result;
  }

  async createReply(threadId, input, image, context) {
    const uploads = uploadCandidates(image);
    const releasedAssets = [];
    const legacyPosts = [];
    const transaction = await this.store.update(data => {
      const thread = this.getThread(threadId, data);
      if (!thread) throw httpError(404, 'Thread not found.');
      if (thread.locked) throw httpError(403, 'This thread is locked.');
      if (thread.archived) throw httpError(403, 'This thread is archived and read-only.');
      const board = this.getBoardById(thread.boardId, data);
      if (!board || !board.enabled) throw httpError(404, 'Board not found.');
      const fields = this.validateText(input, uploads, false, board);
      this.assertBoardMediaPolicy(board, uploads, input);

      if (context.boardUri) {
        const board = this.getBoard(context.boardUri, data);
        if (!board || board.id !== thread.boardId) throw httpError(404, 'Thread not found.');
      }

      const posterKey = this.fingerprint(context.clientKey, data);
      const restriction = this.postingRestriction(data, posterKey, thread.boardId, uploads);
      if (restriction?.kind === 'ban') throw this.banError(restriction);
      if (restriction?.kind === 'warning') return this.consumeWarning(restriction);
      this.assertUniqueImage(data, uploads, board);

      const normalized = normalizeSpamText(fields.comment);
      if (normalized.length >= 8) {
        const duplicates = thread.replies.slice(-20)
          .filter(reply => normalizeSpamText(reply.comment) === normalized).length;
        if (duplicates >= 2) throw httpError(409, 'Duplicate reply detected.');
      }

      const replyLimit = this.boardSetting(board, 'replyLimit', this.config.limits.replyLimit);
      if (thread.replies.length >= replyLimit) {
        if (!thread.cyclic) throw httpError(409, 'This thread has reached the reply limit.');
        const removed = thread.replies.shift();
        if (removed) {
          this.releasePostMedia(data, removed, releasedAssets, legacyPosts);
          this.removeRelatedReports(data, [removed.id]);
        }
      }

      data.lastId += 1;
      const now = Date.now();
      const option = String(input.option || input.email || '').trim().toLowerCase();
      const sage = option === 'sage';
      if (sage && !this.boardSetting(board, 'allowSage', true)) {
        throw httpError(403, 'Sage is disabled on this board.');
      }
      const bumpLimit = this.boardSetting(board, 'bumpLimit', this.config.limits.bumpLimit);
      const bumped = !sage && thread.replies.length + 1 <= bumpLimit;
      const identity = this.postIdentity(fields.rawName, input.password || input.pwd, posterKey, thread.id, data, board);
      const capcode = this.capcodeFor(context, thread.boardId, data);
      const attachments = this.registerUploads(data, uploads, formBoolean(input.spoiler));
      const reply = {
        id: data.lastId,
        ...identity,
        ...(capcode ? { capcode } : {}),
        comment: fields.comment,
        ...(fields.fortune ? { fortune: fields.fortune } : {}),
        createdAt: now,
        sage,
        bumped,
        email: sage ? 'sage' : '',
        attachments
      };
      syncPrimaryAttachment(reply, attachments);
      thread.replies.push(reply);
      if (bumped) thread.bumpedAt = now;
      if (context.actor) {
        this.logModeration(data, 'staff-post', `Posted reply No.${reply.id}${capcode ? ` with ${capcode} capcode` : ''}`, {
          ...context,
          boardId: thread.boardId
        });
      }
      return { id: reply.id, threadId: thread.id };
    });

    if (transaction.result.warning) throw httpError(403, transaction.result.message);
    for (const upload of uploads) {
      if (upload._deduplicated) this.uploads.removeCandidate(upload);
    }
    this.cleanupReleasedMedia(releasedAssets, legacyPosts);
    return transaction.result;
  }

  recalculateBump(thread, board = null) {
    const bumpLimit = this.boardSetting(board, 'bumpLimit', this.config.limits.bumpLimit);
    const bumpTimes = thread.replies
      .filter((reply, index) => reply.bumped === undefined
        ? (!reply.sage && index + 1 <= bumpLimit)
        : reply.bumped)
      .map(reply => Number(reply.createdAt) || 0);
    thread.bumpedAt = Math.max(Number(thread.createdAt) || 0, ...bumpTimes);
  }

  closeRelatedReports(data, postIds, context = {}) {
    const ids = new Set(postIds);
    const now = Date.now();
    for (const report of data.reports) {
      if (!ids.has(Number(report.postId)) || report.status === 'closed') continue;
      report.status = 'closed';
      report.updatedAt = now;
      report.closedAt = now;
      report.resolution = 'post-deleted';
      report.moderatorNote = 'The reported post was deleted.';
      report.history.push({
        action: 'target-deleted',
        resolution: report.resolution,
        note: report.moderatorNote,
        actorId: String(context.actor?.id || ''),
        actorName: String(context.actor?.username || ''),
        createdAt: now
      });
      report.history = report.history.slice(-50);
    }
  }

  async deleteByPassword(rawIds, password, fileOnly = false) {
    if (!this.config.features.userDeletion) throw httpError(403, 'User deletion is disabled.');
    const ids = [...new Set((Array.isArray(rawIds) ? rawIds : [rawIds])
      .map(id => Number.parseInt(id, 10)).filter(id => id > 0))];
    if (!ids.length) throw httpError(400, 'Select at least one post to delete.');
    const releasedAssets = [];
    const legacyPosts = [];

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
          this.releasePostMedia(data, target.post, releasedAssets, legacyPosts);
          removePostAttachments(target.post);
        }
        return { deleted: ids, fileOnly: true };
      }

      const deletedIds = new Set();
      for (const target of targets.filter(item => item.isThread)) {
        const threadIndex = data.threads.findIndex(thread => thread.id === target.thread.id);
        if (threadIndex < 0) continue;
        const [thread] = data.threads.splice(threadIndex, 1);
        this.releasePostMedia(data, thread, releasedAssets, legacyPosts);
        for (const reply of thread.replies) {
          this.releasePostMedia(data, reply, releasedAssets, legacyPosts);
        }
        deletedIds.add(thread.id);
        thread.replies.forEach(reply => deletedIds.add(reply.id));
      }
      for (const id of ids) {
        if (deletedIds.has(id)) continue;
        const target = findPost(data, id);
        if (!target || target.isThread) continue;
        const [reply] = target.thread.replies.splice(target.replyIndex, 1);
        this.releasePostMedia(data, reply, releasedAssets, legacyPosts);
        deletedIds.add(reply.id);
        this.recalculateBump(target.thread, this.getBoardById(target.thread.boardId, data));
      }
      this.closeRelatedReports(data, deletedIds);
      return { deleted: [...deletedIds], fileOnly: false };
    });

    this.cleanupReleasedMedia(releasedAssets, legacyPosts);
    return transaction.result;
  }

  async reportPost(postId, reason, options = {}) {
    if (!this.config.features.reports) throw httpError(404, 'Reports are disabled.');
    const cleanReason = cleanText(reason);
    if (cleanReason.length < 3 || cleanReason.length > 500) throw httpError(400, 'Report reason must be between 3 and 500 characters.');
    const category = cleanText(options.category || this.config.reports.defaultCategory).toLowerCase();
    const allowedCategories = new Set(this.config.reports.categories.map(item => item.id));
    if (!allowedCategories.has(category)) throw httpError(400, 'Unknown report category.');
    return (await this.store.update(data => {
      const target = findPost(data, postId);
      if (!target) throw httpError(404, 'Post not found.');
      const reporterKey = this.reporterFingerprint(options.clientKey, data);
      const duplicate = data.reports.some(report => report.status !== 'closed'
        && Number(report.postId) === target.post.id
        && (reporterKey ? report.reporterKey === reporterKey : report.reason === cleanReason));
      if (duplicate) throw httpError(409, 'That report has already been submitted.');
      const now = Date.now();
      const report = {
        id: crypto.randomUUID(),
        postId: target.post.id,
        threadId: target.threadId,
        boardId: target.thread.boardId,
        category,
        reason: cleanReason,
        reporterKey,
        status: 'open',
        createdAt: now,
        updatedAt: now,
        closedAt: 0,
        resolution: '',
        moderatorNote: '',
        history: []
      };
      data.reports.push(report);
      return report;
    })).result;
  }

  logModeration(data, action, detail, context = {}) {
    const actor = context.actor;
    data.moderationLog.push({
      id: crypto.randomUUID(),
      action,
      detail,
      actorId: String(actor?.id || ''),
      actorName: String(actor?.username || actor?.displayName || ''),
      boardId: String(context.boardId || ''),
      createdAt: Date.now()
    });
    data.moderationLog = data.moderationLog.slice(-200);
  }

  currentStaffActor(actor, data) {
    if (!actor) return null;
    if (actor.legacy) return this.config.adminPassword ? actor : null;
    const current = data.staff.find(account => account.id === actor.id);
    if (!current || current.enabled === false || current.sessionVersion !== actor.sessionVersion) return null;
    return current;
  }

  assertStaffPermission(context, permission, boardId = '', data = null) {
    const actor = data && context?.actor
      ? this.currentStaffActor(context.actor, data)
      : context?.actor;
    if (!staffCan(actor, permission, boardId)) {
      throw httpError(403, 'Your staff account does not have permission for that action.');
    }
  }

  async adminDelete(postId, context = {}) {
    return (await this.store.update(data => {
      const target = findPost(data, postId);
      if (!target) throw httpError(404, 'Post not found.');
      this.assertStaffPermission(context, 'posts.delete', target.thread.boardId, data);
      const actor = this.currentStaffActor(context.actor, data) || context.actor;
      const now = Date.now();
      const fileOnly = Boolean(context.fileOnly);
      const attachments = postAttachments(target.post);
      const requestedAttachmentId = String(context.attachmentId || '');
      const attachmentPosition = requestedAttachmentId
        ? attachments.findIndex(attachment => attachment.id === requestedAttachmentId)
        : -1;
      if (fileOnly && !attachments.length) {
        throw httpError(409, 'That post has no attachment to remove.');
      }
      if (fileOnly && requestedAttachmentId && attachmentPosition < 0) {
        throw httpError(404, 'Attachment not found on that post.');
      }
      const trashedAttachments = fileOnly
        ? (attachmentPosition >= 0 ? [attachments[attachmentPosition]] : attachments)
        : [];
      const snapshot = structuredClone(target.post);
      if (fileOnly) syncPrimaryAttachment(snapshot, structuredClone(trashedAttachments));
      const trash = {
        id: crypto.randomUUID(),
        kind: fileOnly ? 'attachment' : (target.isThread ? 'thread' : 'reply'),
        boardId: target.thread.boardId,
        threadId: target.thread.id,
        postId: target.post.id,
        position: target.isThread
          ? data.threads.findIndex(thread => thread.id === target.thread.id)
          : target.replyIndex,
        attachmentId: attachmentPosition >= 0 ? attachments[attachmentPosition].id : '',
        attachmentPosition: Math.max(0, attachmentPosition),
        post: snapshot,
        reason: cleanText(context.reason).slice(0, 500),
        deletedAt: now,
        purgeAt: now + this.config.lifecycle.staffTrashRetentionDays * 24 * 60 * 60 * 1000,
        deletedById: String(actor?.id || ''),
        deletedByName: String(actor?.username || actor?.displayName || '')
      };
      data.trash.push(trash);

      if (fileOnly) {
        if (attachmentPosition >= 0) {
          const remaining = attachments.filter((attachment, index) => index !== attachmentPosition);
          if (remaining.length) syncPrimaryAttachment(target.post, remaining);
          else removePostAttachments(target.post);
        } else {
          removePostAttachments(target.post);
        }
        this.logModeration(data, 'file-trash', `Moved ${trashedAttachments.length} attachment${trashedAttachments.length === 1 ? '' : 's'} from No.${Number(postId)} to staff trash`, {
          ...context,
          boardId: target.thread.boardId
        });
        return {
          deleted: [target.post.id],
          fileOnly: true,
          trashId: trash.id,
          attachmentId: trash.attachmentId
        };
      }

      const deletedIds = [];
      if (target.isThread) {
        const index = data.threads.findIndex(thread => thread.id === target.thread.id);
        const [thread] = data.threads.splice(index, 1);
        deletedIds.push(thread.id, ...thread.replies.map(reply => reply.id));
      } else {
        const [reply] = target.thread.replies.splice(target.replyIndex, 1);
        deletedIds.push(reply.id);
        this.recalculateBump(target.thread, this.getBoardById(target.thread.boardId, data));
      }
      this.closeRelatedReports(data, deletedIds, context);
      this.logModeration(data, 'delete', `Moved post No.${Number(postId)} to staff trash`, {
        ...context,
        boardId: target.thread.boardId
      });
      return { deleted: deletedIds, fileOnly: false, trashId: trash.id };
    })).result;
  }

  async restoreTrash(trashId, context = {}) {
    return (await this.store.update(data => {
      const index = data.trash.findIndex(entry => entry.id === String(trashId || ''));
      if (index < 0) throw httpError(404, 'Trash entry not found.');
      const entry = data.trash[index];
      this.assertStaffPermission(context, 'posts.delete', entry.boardId, data);
      if (entry.purgeAt <= Date.now()) throw httpError(410, 'This trash entry has expired and cannot be restored.');
      const existingIds = new Set(allPosts(data).map(item => item.post.id));

      if (entry.kind === 'attachment') {
        const target = findPost(data, entry.postId);
        if (!target) throw httpError(409, 'The post no longer exists, so its attachment cannot be restored.');
        if (entry.attachmentId) {
          const current = postAttachments(target.post);
          const restored = postAttachments(entry.post);
          if (!restored.length || current.some(attachment => attachment.id === entry.attachmentId)) {
            throw httpError(409, 'That attachment is already present or cannot be restored.');
          }
          current.splice(
            Math.min(entry.attachmentPosition, current.length),
            0,
            ...structuredClone(restored)
          );
          syncPrimaryAttachment(target.post, current);
        } else {
          if (postAttachments(target.post).length) {
            throw httpError(409, 'The post already has an attachment.');
          }
          restorePostAttachments(target.post, entry.post);
        }
      } else if (entry.kind === 'thread') {
        const snapshotIds = [entry.post.id, ...entry.post.replies.map(reply => reply.id)];
        if (snapshotIds.some(id => existingIds.has(id))) {
          throw httpError(409, 'A post with one of the original IDs already exists.');
        }
        data.threads.splice(Math.min(entry.position, data.threads.length), 0, structuredClone(entry.post));
      } else {
        if (existingIds.has(entry.post.id)) throw httpError(409, 'A post with the original ID already exists.');
        const thread = this.getThread(entry.threadId, data);
        if (!thread) throw httpError(409, 'Restore the parent thread before restoring this reply.');
        const bumpedAt = thread.bumpedAt;
        thread.replies.splice(Math.min(entry.position, thread.replies.length), 0, structuredClone(entry.post));
        thread.bumpedAt = bumpedAt;
      }

      data.trash.splice(index, 1);
      this.logModeration(data, 'trash-restore', `Restored ${entry.kind} for No.${entry.postId}`, {
        ...context,
        boardId: entry.boardId
      });
      return { restored: entry.postId, kind: entry.kind };
    })).result;
  }

  async purgeExpiredTrash(context = {}, now = Date.now()) {
    const releasedAssets = [];
    const legacyPosts = [];
    const transaction = await this.store.update(data => {
      const actor = context.actor ? this.currentStaffActor(context.actor, data) : null;
      if (context.actor && !actor) throw httpError(403, 'Your staff session is no longer valid.');
      if (!actor && !context.system) throw httpError(403, 'Staff authorization is required to purge trash.');
      const expired = data.trash.filter(entry => Number(entry.purgeAt) <= Number(now)
        && (!actor || staffCan(actor, 'posts.delete', entry.boardId)));
      const expiredIds = new Set(expired.map(entry => entry.id));
      for (const entry of expired) {
        this.releasePostMedia(data, entry.post, releasedAssets, legacyPosts);
        if (entry.kind === 'thread') {
          for (const reply of entry.post.replies) {
            this.releasePostMedia(data, reply, releasedAssets, legacyPosts);
          }
        }
      }
      data.trash = data.trash.filter(entry => !expiredIds.has(entry.id));
      if (expired.length && actor) {
        this.logModeration(data, 'trash-purge', `Purged ${expired.length} expired trash entr${expired.length === 1 ? 'y' : 'ies'}`, {
          ...context,
          boardId: actor.scope === 'boards' && actor.boardIds.length === 1 ? actor.boardIds[0] : ''
        });
      }
      return { purged: expired.map(entry => entry.id) };
    });
    this.cleanupReleasedMedia(releasedAssets, legacyPosts);
    return transaction.result;
  }

  async performMaintenance(now = Date.now()) {
    const orphanAssets = [];
    const transaction = await this.store.update(data => {
      const expiredSanctions = [];
      for (const sanction of data.bans) {
        if (sanction.active === false || sanction.kind !== 'ban' || !sanction.expiresAt
          || Number(sanction.expiresAt) > Number(now)) continue;
        sanction.active = false;
        sanction.updatedAt = Number(now);
        sanction.liftedAt = Number(now);
        expiredSanctions.push(sanction.id);
      }

      const archivedThreads = [];
      for (const board of data.boards) {
        archivedThreads.push(...this.pruneThreads(data, board.id, now).map(thread => thread.id));
      }

      for (const asset of data.media) {
        if ((Number(asset.refCount) || 0) <= 0) orphanAssets.push(structuredClone(asset));
      }
      if (orphanAssets.length) {
        const ids = new Set(orphanAssets.map(asset => asset.id));
        data.media = data.media.filter(asset => !ids.has(asset.id));
      }

      if (expiredSanctions.length || archivedThreads.length || orphanAssets.length) {
        this.logModeration(
          data,
          'maintenance',
          `Expired ${expiredSanctions.length} sanctions, archived ${archivedThreads.length} threads, and removed ${orphanAssets.length} unreferenced media records`,
          { actor: { id: 'system', username: 'system' } }
        );
      }
      return {
        expiredSanctions,
        archivedThreads,
        orphanAssets: orphanAssets.map(asset => asset.id)
      };
    });
    for (const asset of orphanAssets) this.uploads.removeAsset(asset);
    return transaction.result;
  }

  async editPost(postId, fields, context = {}) {
    const reason = cleanText(fields.reason);
    if (reason.length < 3 || reason.length > 500) {
      throw httpError(400, 'An edit reason between 3 and 500 characters is required.');
    }
    return (await this.store.update(data => {
      const target = findPost(data, postId);
      if (!target) throw httpError(404, 'Post not found.');
      this.assertStaffPermission(context, 'posts.edit', target.thread.boardId, data);
      const post = target.post;
      const comment = this.applyWordFilters(cleanText(fields.comment));
      const title = target.isThread ? cleanText(fields.title) : '';
      if (!comment && !post.image && !post.fortune) throw httpError(400, 'A comment or attachment is required.');
      if (title.length > this.config.limits.maxSubjectLength) {
        throw httpError(400, `Subject is limited to ${this.config.limits.maxSubjectLength} characters.`);
      }
      if (comment.length > this.config.limits.maxCommentLength) {
        throw httpError(400, `Comment is limited to ${this.config.limits.maxCommentLength} characters.`);
      }
      if (comment.split('\n').length > this.config.limits.maxCommentLines) {
        throw httpError(400, `Comments are limited to ${this.config.limits.maxCommentLines} lines.`);
      }
      const linkCount = (comment.match(/https?:\/\//gi) || []).length;
      if (linkCount > this.config.limits.maxLinks) {
        throw httpError(400, `Comments are limited to ${this.config.limits.maxLinks} links.`);
      }
      const citeCount = (comment.match(/(?:^|[^>])>>\d+/g) || []).length;
      if (citeCount > this.config.limits.maxCites) {
        throw httpError(400, `Comments are limited to ${this.config.limits.maxCites} citations.`);
      }
      if (comment === post.comment && (!target.isThread || title === post.title)) {
        throw httpError(409, 'The edited content is unchanged.');
      }

      const actor = this.currentStaffActor(context.actor, data) || context.actor;
      const before = { name: post.name || '', title: target.isThread ? post.title : '', comment: post.comment };
      const after = { name: post.name || '', title, comment };
      const now = Date.now();
      data.revisions.push({
        id: crypto.randomUUID(),
        postId: post.id,
        threadId: target.thread.id,
        boardId: target.thread.boardId,
        before,
        after,
        reason,
        editedAt: now,
        editedById: String(actor?.id || ''),
        editedByName: String(actor?.username || actor?.displayName || '')
      });
      const revisions = data.revisions
        .filter(revision => revision.postId === post.id)
        .sort((left, right) => Number(left.editedAt) - Number(right.editedAt));
      const excess = revisions.length - this.config.lifecycle.maxRevisionsPerPost;
      if (excess > 0) {
        const removedIds = new Set(revisions.slice(0, excess).map(revision => revision.id));
        data.revisions = data.revisions.filter(revision => !removedIds.has(revision.id));
      }
      post.comment = comment;
      if (target.isThread) post.title = title;
      post.editedAt = now;
      post.editCount = (Number(post.editCount) || 0) + 1;
      this.logModeration(data, 'post-edit', `Edited post No.${post.id}: ${reason}`, {
        ...context,
        boardId: target.thread.boardId
      });
      return { postId: post.id, threadId: target.thread.id, editedAt: now };
    })).result;
  }

  async setThreadFlag(threadId, flag, value, context = {}) {
    if (!['sticky', 'locked', 'cyclic', 'archived'].includes(flag)) throw httpError(400, 'Unknown thread setting.');
    return (await this.store.update(data => {
      const thread = this.getThread(threadId, data);
      if (!thread) throw httpError(404, 'Thread not found.');
      this.assertStaffPermission(context, 'threads.manage', thread.boardId, data);
      thread[flag] = Boolean(value);
      if (flag === 'archived') thread.archivedAt = thread.archived ? Date.now() : 0;
      this.logModeration(data, 'thread-setting', `Set ${flag}=${Boolean(value)} on No.${thread.id}`, {
        ...context,
        boardId: thread.boardId
      });
      return { threadId: thread.id, flag, value: thread[flag] };
    })).result;
  }

  async resolveReport(reportId, resolution = 'dismissed', note = '', context = {}) {
    const allowedResolutions = new Set(['dismissed', 'action-taken']);
    const cleanResolution = cleanText(resolution).toLowerCase();
    if (!allowedResolutions.has(cleanResolution)) throw httpError(400, 'Unknown report resolution.');
    const moderatorNote = cleanText(note);
    if (moderatorNote.length > 500) throw httpError(400, 'Moderator notes are limited to 500 characters.');
    return (await this.store.update(data => {
      const report = data.reports.find(item => item.id === String(reportId || ''));
      if (!report) throw httpError(404, 'Report not found.');
      this.assertStaffPermission(context, 'reports.manage', report.boardId, data);
      if (report.status === 'closed') throw httpError(409, 'Report is already closed.');
      const now = Date.now();
      report.status = 'closed';
      report.updatedAt = now;
      report.closedAt = now;
      report.resolution = cleanResolution;
      report.moderatorNote = moderatorNote;
      report.history.push({
        action: 'resolved',
        resolution: cleanResolution,
        note: moderatorNote,
        actorId: String(context.actor?.id || ''),
        actorName: String(context.actor?.username || ''),
        createdAt: now
      });
      report.history = report.history.slice(-50);
      this.logModeration(data, 'report-resolve', `Resolved report for No.${report.postId} as ${cleanResolution}`, {
        ...context,
        boardId: report.boardId
      });
      return report;
    })).result;
  }

  async dismissReport(reportId, context = {}) {
    return this.resolveReport(reportId, 'dismissed', '', context);
  }

  async reopenReport(reportId, context = {}) {
    return (await this.store.update(data => {
      const report = data.reports.find(item => item.id === String(reportId || ''));
      if (!report) throw httpError(404, 'Report not found.');
      this.assertStaffPermission(context, 'reports.manage', report.boardId, data);
      if (report.status !== 'closed') throw httpError(409, 'Report is already open.');
      const now = Date.now();
      report.status = 'open';
      report.updatedAt = now;
      report.closedAt = 0;
      report.resolution = '';
      report.moderatorNote = '';
      report.history.push({
        action: 'reopened',
        resolution: '',
        note: '',
        actorId: String(context.actor?.id || ''),
        actorName: String(context.actor?.username || ''),
        createdAt: now
      });
      report.history = report.history.slice(-50);
      this.logModeration(data, 'report-reopen', `Reopened report for No.${report.postId}`, {
        ...context,
        boardId: report.boardId
      });
      return report;
    })).result;
  }

  async sanctionPost(postId, options = {}, context = {}) {
    return (await this.store.update(data => {
      const target = findPost(data, postId);
      if (!target) throw httpError(404, 'Post not found.');
      this.assertStaffPermission(context, 'bans.manage', target.thread.boardId, data);
      const actor = this.currentStaffActor(context.actor, data) || context.actor;
      const kind = options.kind === 'warning' ? 'warning' : 'ban';
      const sanctionTarget = options.target === 'file' ? 'file' : 'poster';
      const scope = options.scope === 'board' ? 'board' : 'global';
      if (scope === 'global' && actor?.scope !== 'global') {
        throw httpError(403, 'Board-scoped staff cannot create global sanctions.');
      }
      if (sanctionTarget === 'poster' && !target.post.posterKey) {
        throw httpError(409, 'This legacy post has no poster fingerprint to sanction.');
      }
      const uploadHashes = postAttachments(target.post)
        .map(attachment => attachment.sha256)
        .filter(Boolean);
      const requestedHash = String(options.fileHash || '').toLowerCase();
      if (sanctionTarget === 'file' && requestedHash && !uploadHashes.includes(requestedHash)) {
        throw httpError(400, 'The selected upload hash does not belong to that post.');
      }
      const fileHash = requestedHash || uploadHashes[0] || '';
      if (sanctionTarget === 'file' && !fileHash) {
        throw httpError(409, 'This post has no upload hash to sanction.');
      }
      const cleanReason = cleanText(options.reason, 'Rule violation').slice(0, 300);
      const moderatorNote = cleanText(options.moderatorNote).slice(0, 500);
      const duration = kind === 'ban' ? Math.max(0, Number(options.durationMs) || 0) : 0;
      const now = Date.now();
      const sanction = {
        id: crypto.randomUUID(),
        kind,
        target: sanctionTarget,
        scope,
        boardId: scope === 'board' ? target.thread.boardId : '',
        posterKey: sanctionTarget === 'poster' ? target.post.posterKey : '',
        fileHash: sanctionTarget === 'file' ? fileHash : '',
        reason: cleanReason,
        reasonVisible: options.reasonVisible !== false,
        moderatorNote,
        appealId: crypto.randomUUID(),
        active: true,
        createdAt: now,
        updatedAt: now,
        expiresAt: duration ? now + duration : 0,
        deliveredAt: 0,
        liftedAt: 0,
        createdById: String(actor?.id || ''),
        createdByName: String(actor?.username || actor?.displayName || '')
      };
      data.bans.push(sanction);
      this.logModeration(data, kind, `${kind === 'ban' ? 'Banned' : 'Warned'} ${sanctionTarget} from No.${target.post.id} (${scope}): ${cleanReason}`, {
        ...context,
        boardId: target.thread.boardId
      });
      return sanction;
    })).result;
  }

  async banPost(postId, durationMs, reason, context = {}) {
    return this.sanctionPost(postId, {
      kind: 'ban',
      target: context.target || 'poster',
      scope: context.scope || 'global',
      durationMs,
      reason,
      reasonVisible: context.reasonVisible,
      moderatorNote: context.moderatorNote
    }, context);
  }

  async unban(banId, context = {}) {
    return (await this.store.update(data => {
      const ban = data.bans.find(item => item.id === banId);
      if (!ban) throw httpError(404, 'Ban not found.');
      this.assertStaffPermission(context, 'bans.manage', ban.boardId || '', data);
      const actor = this.currentStaffActor(context.actor, data) || context.actor;
      if (ban.scope === 'global' && actor?.scope !== 'global') {
        throw httpError(403, 'Board-scoped staff cannot lift global sanctions.');
      }
      ban.active = false;
      ban.updatedAt = Date.now();
      ban.liftedAt = ban.updatedAt;
      this.logModeration(data, 'unban', `Lifted ban ${ban.id}`, {
        ...context,
        boardId: ban.boardId || ''
      });
      return ban;
    })).result;
  }

  getAppealContext(appealId, data = this.getData()) {
    const sanction = data.bans.find(item => item.kind === 'ban' && item.appealId === String(appealId || ''));
    if (!sanction) return null;
    const appeal = data.appeals.find(item => item.sanctionId === sanction.id) || null;
    return {
      appealId: sanction.appealId,
      reason: sanction.reasonVisible ? sanction.reason : '',
      active: sanction.active !== false && (!sanction.expiresAt || sanction.expiresAt > Date.now()),
      expiresAt: sanction.expiresAt,
      status: appeal?.status || '',
      message: appeal?.message || '',
      staffNote: appeal?.status === 'open' ? '' : (appeal?.staffNote || '')
    };
  }

  async submitAppeal(appealId, message) {
    const cleanMessage = cleanText(message);
    if (cleanMessage.length < 20 || cleanMessage.length > 2000) {
      throw httpError(400, 'Appeals must be between 20 and 2000 characters.');
    }
    return (await this.store.update(data => {
      const sanction = data.bans.find(item => item.kind === 'ban' && item.appealId === String(appealId || ''));
      if (!sanction) throw httpError(404, 'Appeal link not found.');
      if (data.appeals.some(appeal => appeal.sanctionId === sanction.id)) {
        throw httpError(409, 'An appeal has already been submitted for this sanction.');
      }
      const now = Date.now();
      const appeal = {
        id: crypto.randomUUID(),
        sanctionId: sanction.id,
        boardId: sanction.scope === 'board' ? sanction.boardId : '',
        message: cleanMessage,
        status: 'open',
        createdAt: now,
        updatedAt: now,
        resolvedAt: 0,
        staffNote: '',
        resolvedById: '',
        resolvedByName: ''
      };
      data.appeals.push(appeal);
      return appeal;
    })).result;
  }

  async resolveAppeal(appealId, decision, note = '', context = {}) {
    const status = String(decision || '').toLowerCase();
    if (!['accepted', 'denied'].includes(status)) throw httpError(400, 'Unknown appeal decision.');
    const staffNote = cleanText(note).slice(0, 500);
    return (await this.store.update(data => {
      const appeal = data.appeals.find(item => item.id === String(appealId || ''));
      if (!appeal) throw httpError(404, 'Appeal not found.');
      const sanction = data.bans.find(item => item.id === appeal.sanctionId);
      if (!sanction) throw httpError(404, 'Sanction not found.');
      this.assertStaffPermission(context, 'reports.manage', sanction.boardId || '', data);
      const currentActor = this.currentStaffActor(context.actor, data) || context.actor;
      if (sanction.scope === 'global' && currentActor?.scope !== 'global') {
        throw httpError(403, 'Board-scoped staff cannot resolve global appeals.');
      }
      if (appeal.status !== 'open') throw httpError(409, 'Appeal is already resolved.');
      const actor = currentActor;
      const now = Date.now();
      appeal.status = status;
      appeal.updatedAt = now;
      appeal.resolvedAt = now;
      appeal.staffNote = staffNote;
      appeal.resolvedById = String(actor?.id || '');
      appeal.resolvedByName = String(actor?.username || actor?.displayName || '');
      if (status === 'accepted') {
        sanction.active = false;
        sanction.updatedAt = now;
        sanction.liftedAt = now;
      }
      this.logModeration(data, 'appeal-resolve', `${status} appeal ${appeal.id} for sanction ${sanction.id}`, {
        ...context,
        boardId: sanction.boardId || ''
      });
      return appeal;
    })).result;
  }

  getCustomization(data = this.getData()) {
    return structuredClone(data.customization);
  }

  getCustomPage(slug, data = this.getData()) {
    const normalized = String(slug || '').trim().toLowerCase();
    return data.customization.pages.find(page => page.slug === normalized) || null;
  }

  parseNavigation(value) {
    const lines = String(value || '').replace(/\0/g, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length > 20) throw httpError(400, 'Navigation is limited to 20 links.');
    return lines.map(line => {
      const separator = line.indexOf('|');
      const label = separator >= 0 ? line.slice(0, separator).trim() : '';
      const href = separator >= 0 ? line.slice(separator + 1).trim() : '';
      if (!label || label.length > 80 || !/^\/(?!\/)[^\s\0]{0,199}$/.test(href)) {
        throw httpError(400, 'Navigation lines must use Label | /same-origin-path.');
      }
      return { label, href };
    });
  }

  async updateCustomization(fields, context = {}) {
    this.assertStaffPermission(context, 'site.manage');
    return (await this.store.update(data => {
      this.assertStaffPermission(context, 'site.manage', '', data);
      const theme = {};
      for (const key of [
        'background', 'text', 'link', 'linkHover', 'boardTitle', 'subject', 'name',
        'formHeader', 'formBackground', 'formBorder', 'replyBackground', 'replyBorder',
        'quote', 'quoteLink', 'panelHeader'
      ]) {
        const value = String(fields.theme?.[key] || '').trim();
        if (value && !/^#[a-f0-9]{6}$/i.test(value)) {
          throw httpError(400, `Theme color ${key} must be a six-digit hex value.`);
        }
        if (value) theme[key] = value;
      }
      const navigation = this.parseNavigation(fields.navigation);
      const candidate = normalizeCustomization({
        ...data.customization,
        title: fields.title,
        description: fields.description,
        announcement: fields.announcement,
        footerText: fields.footerText,
        logoPath: fields.logoPath,
        faviconPath: fields.faviconPath,
        navigation,
        theme
      });
      if (candidate.navigation.length !== navigation.length) {
        throw httpError(400, 'Navigation paths contain unsupported characters.');
      }
      for (const key of ['logoPath', 'faviconPath']) {
        if (String(fields[key] || '').trim() && !candidate[key]) {
          throw httpError(400, `${key} must be /banner.png, /chikki.ico, /favicon.ico, or a served image path.`);
        }
      }
      data.customization = candidate;
      this.logModeration(data, 'site-customization', 'Updated structured site branding and navigation', context);
      return structuredClone(candidate);
    })).result;
  }

  cleanCustomPage(fields, existing = null) {
    const slug = String(fields.slug || existing?.slug || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
      throw httpError(400, 'Page slugs use lowercase letters, numbers, and hyphens.');
    }
    const title = cleanText(fields.title, existing?.title || slug).slice(0, 120);
    const content = String(fields.content ?? existing?.content ?? '')
      .replace(/\0/g, '')
      .replace(/\r\n?/g, '\n')
      .normalize('NFC');
    if (content.length > 50000) throw httpError(400, 'Custom pages are limited to 50,000 characters.');
    return { slug, title, content, showInFooter: formBoolean(fields.showInFooter) };
  }

  async addCustomPage(fields, context = {}) {
    this.assertStaffPermission(context, 'site.manage');
    const clean = this.cleanCustomPage(fields);
    return (await this.store.update(data => {
      this.assertStaffPermission(context, 'site.manage', '', data);
      if (data.customization.pages.length >= 50) throw httpError(409, 'Custom pages are limited to 50.');
      if (data.customization.pages.some(page => page.slug === clean.slug)) {
        throw httpError(409, 'That custom page slug already exists.');
      }
      const now = Date.now();
      const page = {
        id: crypto.randomUUID(),
        ...clean,
        order: data.customization.pages.length,
        createdAt: now,
        updatedAt: now
      };
      data.customization.pages.push(page);
      this.logModeration(data, 'custom-page-add', `Added custom page /pages/${page.slug}`, context);
      return page;
    })).result;
  }

  async updateCustomPage(pageId, fields, context = {}) {
    this.assertStaffPermission(context, 'site.manage');
    return (await this.store.update(data => {
      this.assertStaffPermission(context, 'site.manage', '', data);
      const page = data.customization.pages.find(item => item.id === String(pageId || ''));
      if (!page) throw httpError(404, 'Custom page not found.');
      const clean = this.cleanCustomPage(fields, page);
      if (data.customization.pages.some(item => item.id !== page.id && item.slug === clean.slug)) {
        throw httpError(409, 'That custom page slug already exists.');
      }
      Object.assign(page, clean, { updatedAt: Date.now() });
      this.logModeration(data, 'custom-page-edit', `Updated custom page /pages/${page.slug}`, context);
      return page;
    })).result;
  }

  async deleteCustomPage(pageId, context = {}) {
    this.assertStaffPermission(context, 'site.manage');
    return (await this.store.update(data => {
      this.assertStaffPermission(context, 'site.manage', '', data);
      const index = data.customization.pages.findIndex(page => page.id === String(pageId || ''));
      if (index < 0) throw httpError(404, 'Custom page not found.');
      const [page] = data.customization.pages.splice(index, 1);
      data.customization.pages.forEach((item, order) => { item.order = order; });
      this.logModeration(data, 'custom-page-delete', `Deleted custom page /pages/${page.slug}`, context);
      return page;
    })).result;
  }

  async addBoard(fields, context = {}) {
    this.assertStaffPermission(context, 'boards.manage');
    return (await this.store.update(data => {
      this.assertStaffPermission(context, 'boards.manage', '', data);
      const existingUris = new Set(data.boards.map(board => board.uri));
      const uri = validateBoardUri(fields.uri, existingUris);
      const board = {
        id: uri,
        uri,
        name: cleanText(fields.name, uri),
        description: cleanText(fields.description || ''),
        category: cleanText(fields.category || 'Other'),
        order: data.boards.length,
        createdAt: Date.now(),
        enabled: formBoolean(fields.enabled, true),
        rules: [],
        settings: {},
        appearance: { bannerText: '', bannerPath: '', theme: {} },
        path: `/${uri}/`
      };
      data.boards.push(board);
      this.logModeration(data, 'board-add', `Added board /${uri}/`, { ...context, boardId: board.id });
      return board;
    })).result;
  }

  async updateBoard(uri, fields, context = {}) {
    this.assertStaffPermission(context, 'boards.manage');
    return (await this.store.update(data => {
      this.assertStaffPermission(context, 'boards.manage', '', data);
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
        for (const account of data.staff) {
          account.boardIds = account.boardIds.map(boardId => boardId === oldUri ? newUri : boardId);
          if (account.boardIds.includes(newUri)) account.boardIds = [...new Set(account.boardIds)];
        }
        for (const ban of data.bans) {
          if (ban.boardId === oldUri) ban.boardId = newUri;
        }
        for (const appeal of data.appeals) {
          if (appeal.boardId === oldUri) appeal.boardId = newUri;
        }
        for (const entry of data.trash) {
          if (entry.boardId !== oldUri) continue;
          entry.boardId = newUri;
          if (entry.kind === 'thread') entry.post.boardId = newUri;
        }
        for (const revision of data.revisions) {
          if (revision.boardId === oldUri) revision.boardId = newUri;
        }
      }

      board.name = cleanText(fields.name, board.name);
      board.description = cleanText(fields.description, board.description);
      board.category = cleanText(fields.category, board.category);
      if (fields.enabled !== undefined && fields.enabled !== null) {
        board.enabled = formBoolean(fields.enabled);
      }
      if (fields.settings) {
        if (Number(fields.settings.maxFilesPerPost) > 4) {
          throw httpError(400, 'Boards cannot allow more than 4 attachments per post.');
        }
        board.settings = normalizeBoardSettings(fields.settings);
      }
      if (fields.appearance) {
        const appearance = normalizeBoardAppearance(fields.appearance);
        if (String(fields.appearance.bannerPath || '').trim() && !appearance.bannerPath) {
          throw httpError(400, 'Board banner path must reference a served image.');
        }
        board.appearance = appearance;
      }
      this.logModeration(data, 'board-edit', `Edited board /${board.uri}/`, { ...context, boardId: board.id });
      return board;
    })).result;
  }

  async toggleBoard(uri, context = {}) {
    this.assertStaffPermission(context, 'boards.manage');
    return (await this.store.update(data => {
      this.assertStaffPermission(context, 'boards.manage', '', data);
      const board = this.getBoard(uri, data);
      if (!board) throw httpError(404, 'Board not found.');
      board.enabled = !board.enabled;
      this.logModeration(
        data,
        'board-toggle',
        `${board.enabled ? 'Enabled' : 'Disabled'} board /${board.uri}/`,
        { ...context, boardId: board.id }
      );
      return board;
    })).result;
  }

  async moveBoard(uri, direction, context = {}) {
    this.assertStaffPermission(context, 'boards.manage');
    if (!['up', 'down'].includes(direction)) throw httpError(400, 'Board direction must be up or down.');
    return (await this.store.update(data => {
      this.assertStaffPermission(context, 'boards.manage', '', data);
      const index = data.boards.findIndex(board => board.uri === String(uri || '').trim().toLowerCase());
      if (index < 0) throw httpError(404, 'Board not found.');
      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      const board = data.boards[index];
      if (targetIndex < 0 || targetIndex >= data.boards.length) return board;
      [data.boards[index], data.boards[targetIndex]] = [data.boards[targetIndex], data.boards[index]];
      data.boards.forEach((item, boardIndex) => { item.order = boardIndex; });
      this.logModeration(data, 'board-move', `Moved board /${board.uri}/ ${direction}`, {
        ...context,
        boardId: board.id
      });
      return board;
    })).result;
  }

  cleanBoardRule(value) {
    const rule = cleanText(value);
    if (!rule) throw httpError(400, 'Board rule text is required.');
    if (rule.length > this.config.limits.maxBoardRuleLength) {
      throw httpError(400, `Board rules are limited to ${this.config.limits.maxBoardRuleLength} characters.`);
    }
    return rule;
  }

  async addBoardRule(uri, value, context = {}) {
    this.assertStaffPermission(context, 'boards.manage');
    const text = this.cleanBoardRule(value);
    return (await this.store.update(data => {
      this.assertStaffPermission(context, 'boards.manage', '', data);
      const board = this.getBoard(uri, data);
      if (!board) throw httpError(404, 'Board not found.');
      if (board.rules.length >= this.config.limits.maxBoardRules) {
        throw httpError(409, `Boards are limited to ${this.config.limits.maxBoardRules} rules.`);
      }
      if (board.rules.some(rule => rule.text === text)) {
        throw httpError(409, 'That board rule already exists.');
      }
      const now = Date.now();
      const rule = { id: crypto.randomUUID(), text, createdAt: now, updatedAt: now };
      board.rules.push(rule);
      this.logModeration(data, 'board-rule-add', `Added rule ${rule.id} to /${board.uri}/`, {
        ...context,
        boardId: board.id
      });
      return rule;
    })).result;
  }

  async updateBoardRule(uri, ruleId, value, context = {}) {
    this.assertStaffPermission(context, 'boards.manage');
    const text = this.cleanBoardRule(value);
    return (await this.store.update(data => {
      this.assertStaffPermission(context, 'boards.manage', '', data);
      const board = this.getBoard(uri, data);
      if (!board) throw httpError(404, 'Board not found.');
      const rule = board.rules.find(item => item.id === String(ruleId || ''));
      if (!rule) throw httpError(404, 'Board rule not found.');
      if (board.rules.some(item => item.id !== rule.id && item.text === text)) {
        throw httpError(409, 'That board rule already exists.');
      }
      rule.text = text;
      rule.updatedAt = Date.now();
      this.logModeration(data, 'board-rule-edit', `Edited rule ${rule.id} on /${board.uri}/`, {
        ...context,
        boardId: board.id
      });
      return rule;
    })).result;
  }

  async deleteBoardRule(uri, ruleId, context = {}) {
    this.assertStaffPermission(context, 'boards.manage');
    return (await this.store.update(data => {
      this.assertStaffPermission(context, 'boards.manage', '', data);
      const board = this.getBoard(uri, data);
      if (!board) throw httpError(404, 'Board not found.');
      const index = board.rules.findIndex(rule => rule.id === String(ruleId || ''));
      if (index < 0) throw httpError(404, 'Board rule not found.');
      const [rule] = board.rules.splice(index, 1);
      this.logModeration(data, 'board-rule-delete', `Deleted rule ${rule.id} from /${board.uri}/`, {
        ...context,
        boardId: board.id
      });
      return rule;
    })).result;
  }

  async deleteBoard(uri, context = {}) {
    this.assertStaffPermission(context, 'boards.manage');
    return (await this.store.update(data => {
      this.assertStaffPermission(context, 'boards.manage', '', data);
      const board = this.getBoard(uri, data);
      if (!board) throw httpError(404, 'Board not found.');
      const defaultBoard = this.getDefaultBoard(data);
      if (board.id === defaultBoard.id) {
        throw httpError(400, 'Cannot delete the default board.');
      }
      for (const thread of data.threads) {
        if (thread.boardId === board.id) thread.boardId = defaultBoard.id;
      }
      for (const entry of data.trash) {
        if (entry.boardId !== board.id) continue;
        entry.boardId = defaultBoard.id;
        if (entry.kind === 'thread') entry.post.boardId = defaultBoard.id;
      }
      for (const revision of data.revisions) {
        if (revision.boardId === board.id) revision.boardId = defaultBoard.id;
      }
      data.boards = data.boards.filter(b => b.uri !== uri);
      data.boards.forEach((item, index) => { item.order = index; });
      for (const account of data.staff) {
        account.boardIds = account.boardIds.filter(boardId => boardId !== board.id);
      }
      for (const sanction of data.bans) {
        if (sanction.scope !== 'board' || sanction.boardId !== board.id) continue;
        sanction.active = false;
        sanction.updatedAt = Date.now();
        sanction.liftedAt = sanction.updatedAt;
      }
      this.logModeration(
        data,
        'board-delete',
        `Deleted board /${uri}/; threads moved to /${defaultBoard.uri}/`,
        { ...context, boardId: board.id }
      );
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
      .filter(entry => entry.board && entry.board.enabled && !entry.thread.archived)
      .sort((left, right) => Number(right.post.createdAt) - Number(left.post.createdAt));
    return entries.slice(0, limit);
  }

  latestImages(limit = 24, data = this.getData()) {
    const images = [];
    const seen = new Set();

    for (const entry of this.latestPosts(Number.MAX_SAFE_INTEGER, data)) {
      const post = entry.post;
      for (const attachment of postAttachments(post)) {
        const imagePath = this.uploads.pathForPost(attachment);
        if (!imagePath || !this.uploads.inspectServedFile(path.basename(attachment.image))) continue;

        const imageKey = attachment.sha256 || attachment.image;
        if (seen.has(imageKey)) continue;
        seen.add(imageKey);
        images.push({
          ...entry,
          post: {
            ...post,
            ...attachment,
            id: post.id,
            attachments: [attachment],
            spoiler: Boolean(attachment.spoiler)
          }
        });
        if (images.length >= limit) break;
      }
      if (images.length >= limit) break;
    }

    return images;
  }
}

module.exports = { BoardService, boardStats, findPost, sortedThreads, siteStats };
