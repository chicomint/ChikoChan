'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ROLES, USERNAME_PATTERN, normalizeUsername } = require('./staff');
const { syncPrimaryAttachment } = require('./post-media');

const SCHEMA_VERSION = 16;

function numericId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

const DEFAULT_BOARD_URI = 'chiko';
const BOARD_RULE_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const CUSTOM_PAGE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HEX_COLOR_PATTERN = /^#[a-f0-9]{6}$/i;
const INTERNAL_PATH_PATTERN = /^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/?#-]{0,199}$/;
const BRAND_ASSET_PATTERN = /^\/(?:banner\.png|chikki\.ico|favicon\.ico|src\/[a-z0-9][a-z0-9._-]{0,199}\.(?:jpe?g|png|gif|webp))$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const MEDIA_STATES = new Set(['pending', 'scanning', 'approved', 'rejected', 'quarantined', 'moderator_hold', 'failed']);
const MEDIA_DECISIONS = new Set(['approved', 'rejected', 'quarantined', 'moderator_hold']);
const ENCRYPTED_MFA_PATTERN = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{1,256}\.[A-Za-z0-9_-]{22}$/;
const RECOVERY_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BOARD_TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;
const MAX_BOARD_TAGS = 8;
const BOARD_FILTER_KINDS = new Set(['literal', 'domain']);
const MAX_BOARD_FILTERS = 20;
const MAX_BOARD_FILTER_TEXT = 200;

function normalizeStorageKey(value) {
  const key = String(value || '');
  const segments = key.split('/');
  if (!key || key.length > 500 || key.startsWith('/') || key.endsWith('/') || key.includes('\\')
    || segments.some(segment => !segment || segment === '.' || segment === '..')
    || !/^[A-Za-z0-9._/-]+$/.test(key)) return '';
  return key;
}

function normalizeMediaHold(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sourceKey = normalizeStorageKey(value.sourceKey);
  const thumbnailKey = normalizeStorageKey(value.thumbnailKey);
  const quarantineSourceKey = normalizeStorageKey(value.quarantineSourceKey);
  const quarantineThumbnailKey = normalizeStorageKey(value.quarantineThumbnailKey);
  if ((!sourceKey || !quarantineSourceKey) && (!thumbnailKey || !quarantineThumbnailKey)) return null;
  return {
    sourceKey,
    thumbnailKey,
    quarantineSourceKey,
    quarantineThumbnailKey,
    originalPath: sourceKey ? `src/${sourceKey}` : '',
    originalThumbnail: thumbnailKey ? `src/${thumbnailKey}` : ''
  };
}

function normalizeTheme(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const theme = {};
  for (const key of [
    'background', 'text', 'link', 'linkHover', 'boardTitle', 'subject', 'name',
    'formHeader', 'formBackground', 'formBorder', 'replyBackground', 'replyBorder',
    'quote', 'quoteLink', 'panelHeader'
  ]) {
    if (HEX_COLOR_PATTERN.test(String(source[key] || ''))) theme[key] = String(source[key]).toLowerCase();
  }
  return theme;
}

function normalizeNavigationLinks(links) {
  if (!Array.isArray(links)) return [];
  return links.slice(0, 20).flatMap(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const label = String(value.label || '').replace(/\0/g, '').trim().slice(0, 80);
    const href = String(value.href || '').trim();
    return label && INTERNAL_PATH_PATTERN.test(href) ? [{ label, href }] : [];
  });
}

function normalizeCustomPages(pages) {
  if (!Array.isArray(pages)) return [];
  const seen = new Set();
  return pages.slice(0, 50).flatMap((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const slug = String(value.slug || '').trim().toLowerCase();
    if (!CUSTOM_PAGE_SLUG_PATTERN.test(slug) || seen.has(slug)) return [];
    seen.add(slug);
    const createdAt = Number(value.createdAt) || Date.now();
    return [{
      id: BOARD_RULE_ID_PATTERN.test(String(value.id || ''))
        ? String(value.id)
        : `page-${crypto.createHash('sha256').update(`${slug}:${index}`).digest('hex').slice(0, 20)}`,
      slug,
      title: String(value.title || slug).replace(/\0/g, '').trim().slice(0, 120) || slug,
      content: String(value.content || '')
        .replace(/\0/g, '')
        .replace(/\r\n?/g, '\n')
        .normalize('NFC')
        .slice(0, 50000),
      showInFooter: value.showInFooter !== false,
      order: Number.isSafeInteger(Number(value.order)) && Number(value.order) >= 0
        ? Number(value.order)
        : index,
      createdAt,
      updatedAt: Number(value.updatedAt) || createdAt
    }];
  }).sort((left, right) => left.order - right.order).map((page, index) => ({ ...page, order: index }));
}

function normalizeCustomization(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const logoPath = String(source.logoPath || '').trim();
  const faviconPath = String(source.faviconPath || '').trim();
  return {
    title: String(source.title || '').replace(/\0/g, '').trim().slice(0, 120),
    description: String(source.description || '').replace(/\0/g, '').replace(/\r\n?/g, '\n').normalize('NFC').trim().slice(0, 4000),
    announcement: String(source.announcement || '').replace(/\0/g, '').replace(/\r\n?/g, '\n').normalize('NFC').trim().slice(0, 1000),
    footerText: String(source.footerText || '').replace(/\0/g, '').trim().slice(0, 500),
    logoPath: BRAND_ASSET_PATTERN.test(logoPath) ? logoPath : '',
    faviconPath: BRAND_ASSET_PATTERN.test(faviconPath) ? faviconPath : '',
    navigation: normalizeNavigationLinks(source.navigation),
    theme: normalizeTheme(source.theme),
    pages: normalizeCustomPages(source.pages)
  };
}

function normalizeBoardSettings(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const settings = {};
  for (const key of [
    'requireImageForThread', 'allowVideoUploads', 'allowSpoilers', 'showPosterIds',
    'allowSage', 'rejectDuplicateImages'
  ]) {
    if (typeof source[key] === 'boolean') settings[key] = source[key];
  }
  for (const key of ['maxThreads', 'bumpLimit', 'replyLimit', 'maxFilesPerPost']) {
    if (Number.isInteger(Number(source[key])) && Number(source[key]) > 0) settings[key] = Number(source[key]);
  }
  if (settings.maxFilesPerPost > 4) delete settings.maxFilesPerPost;
  const anonymousName = String(source.anonymousName || '').replace(/\0/g, '').trim().slice(0, 80);
  if (anonymousName) settings.anonymousName = anonymousName;
  return settings;
}

function normalizeBoardAppearance(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const bannerPath = String(source.bannerPath || '').trim();
  return {
    bannerText: String(source.bannerText || '').replace(/\0/g, '').trim().slice(0, 500),
    bannerPath: BRAND_ASSET_PATTERN.test(bannerPath) ? bannerPath : '',
    theme: normalizeTheme(source.theme)
  };
}

function normalizeBoardRules(rules, boardCreatedAt = Date.now()) {
  if (!Array.isArray(rules)) return [];

  const seenIds = new Set();
  const normalized = [];
  for (const [index, value] of rules.entries()) {
    const rule = typeof value === 'string' ? { text: value } : value;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) continue;

    const text = String(rule.text || '')
      .replace(/\0/g, '')
      .replace(/\r\n?/g, '\n')
      .normalize('NFC')
      .trim();
    if (!text) continue;

    const suppliedId = String(rule.id || '');
    const digest = crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
    const baseId = BOARD_RULE_ID_PATTERN.test(suppliedId)
      ? suppliedId
      : `legacy-${index + 1}-${digest}`;
    let id = baseId;
    let suffix = index + 1;
    while (seenIds.has(id)) {
      id = `${baseId.slice(0, 68)}-${suffix}`;
      suffix += 1;
    }
    seenIds.add(id);

    const createdAt = Number(rule.createdAt) || Number(boardCreatedAt) || Date.now();
    normalized.push({
      id,
      text,
      createdAt,
      updatedAt: Number(rule.updatedAt) || createdAt
    });
  }
  return normalized;
}

function normalizeBoardTags(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.flatMap(entry => {
    const tag = String(entry || '').trim().toLowerCase();
    if (!BOARD_TAG_PATTERN.test(tag) || seen.has(tag)) return [];
    seen.add(tag);
    return [tag];
  }).slice(0, MAX_BOARD_TAGS);
}

function normalizeBoardFilters(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.slice(0, MAX_BOARD_FILTERS).flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const kind = BOARD_FILTER_KINDS.has(entry.kind) ? String(entry.kind) : '';
    const text = String(entry.value || '').replace(/\0/g, '').trim().slice(0, MAX_BOARD_FILTER_TEXT);
    const filterValue = kind === 'domain' ? text.toLowerCase() : text;
    if (!kind || !filterValue) return [];
    const key = `${kind}:${filterValue.toLowerCase()}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      id: BOARD_RULE_ID_PATTERN.test(String(entry.id || ''))
        ? String(entry.id)
        : `filter-${crypto.createHash('sha256').update(`${kind}:${filterValue}:${index}`).digest('hex').slice(0, 20)}`,
      kind,
      value: filterValue,
      note: String(entry.note || '').replace(/\0/g, '').trim().slice(0, MAX_BOARD_FILTER_TEXT)
    }];
  });
}

function createDefaultBoard(config) {
  const board = config.board || {};
  const site = config.site || {};
  const uri = String(board.uri || DEFAULT_BOARD_URI).toLowerCase();
  return {
    id: uri,
    uri,
    name: String(board.title || site.title || 'ChikoChan'),
    description: String(board.description || site.description || ''),
    category: 'General',
    order: 0,
    createdAt: Date.now(),
    enabled: true,
    tags: normalizeBoardTags(board.tags),
    sfw: board.sfw !== false,
    filters: normalizeBoardFilters(board.filters),
    rules: normalizeBoardRules(board.rules),
    settings: normalizeBoardSettings(board.settings),
    appearance: normalizeBoardAppearance(board.appearance),
    path: `/${uri}/`
  };
}

function defaultBoardUri(config) {
  return String(config.board?.uri || DEFAULT_BOARD_URI).toLowerCase();
}

function validateBoards(boards, defaultBoard) {
  if (!Array.isArray(boards) || !boards.length) return [defaultBoard];
  const seen = new Set();
  const valid = [];
  for (const [index, board] of boards.entries()) {
    const uri = String(board?.uri || '').trim().toLowerCase();
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    const createdAt = Number(board.createdAt) || Date.now();
    valid.push({
      id: uri,
      uri,
      name: String(board.name || uri),
      description: String(board.description || ''),
      category: String(board.category || 'Other'),
      order: Number.isSafeInteger(Number(board.order)) && Number(board.order) >= 0
        ? Number(board.order)
        : index,
      createdAt,
      enabled: board.enabled !== false,
      tags: normalizeBoardTags(board.tags),
      sfw: board.sfw !== false,
      filters: normalizeBoardFilters(board.filters),
      rules: normalizeBoardRules(board.rules, createdAt),
      settings: normalizeBoardSettings(board.settings),
      appearance: normalizeBoardAppearance(board.appearance),
      path: `/${uri}/`
    });
  }
  if (!valid.length) return [defaultBoard];
  valid.sort((left, right) => left.order - right.order);
  valid.forEach((board, index) => { board.order = index; });
  return valid;
}

function normalizeAttachment(value, postId, index, fallbackSpoiler = false, allowSuppliedId = true) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const image = String(source.image || '');
  if (!image) return null;
  const suppliedId = allowSuppliedId ? String(source.id || '') : '';
  const id = BOARD_RULE_ID_PATTERN.test(suppliedId)
    ? suppliedId
    : `attachment-${crypto.createHash('sha256')
      .update(`${postId}:${image}:${index}`)
      .digest('hex')
      .slice(0, 32)}`;
  const mime = String(source.imageMime || '');
  const mediaKind = source.mediaKind === 'video' || mime.startsWith('video/') ? 'video' : 'image';
  return {
    id,
    assetId: String(source.assetId || ''),
    image,
    imageName: String(source.imageName || 'image'),
    imageBytes: Number(source.imageBytes) || 0,
    imageMime: mime,
    mediaKind,
    width: Number(source.width) || 0,
    height: Number(source.height) || 0,
    durationMs: Number(source.durationMs) || 0,
    frameRate: Number(source.frameRate) || 0,
    videoCodec: String(source.videoCodec || ''),
    audioCodec: String(source.audioCodec || ''),
    thumbnail: String(source.thumbnail || ''),
    thumbnailWidth: Number(source.thumbnailWidth) || 0,
    thumbnailHeight: Number(source.thumbnailHeight) || 0,
    md5: String(source.md5 || ''),
    sha256: /^[a-f0-9]{64}$/i.test(String(source.sha256 || ''))
      ? String(source.sha256).toLowerCase()
      : '',
    contentSha256: SHA256_PATTERN.test(String(source.contentSha256 || ''))
      ? String(source.contentSha256).toLowerCase()
      : (SHA256_PATTERN.test(String(source.sha256 || '')) ? String(source.sha256).toLowerCase() : ''),
    metadataStripped: source.metadataStripped === true,
    spoiler: source.spoiler === undefined ? Boolean(fallbackSpoiler) : Boolean(source.spoiler)
  };
}

function normalizePost(post, isThread = false) {
  const id = numericId(post?.id);
  if (!id) throw new Error('posts.json contains a post with an invalid id; it was left untouched.');
  const normalized = {
    ...post,
    id,
    name: String(post.name || ''),
    trip: String(post.trip || ''),
    comment: String(post.comment || ''),
    createdAt: Number(post.createdAt) || Date.now(),
    references: [],
    backlinks: []
  };

  if (post.imageBytes !== undefined) normalized.imageBytes = Number(post.imageBytes) || 0;
  if (post.width !== undefined) normalized.width = Number(post.width) || 0;
  if (post.height !== undefined) normalized.height = Number(post.height) || 0;
  if (post.durationMs !== undefined) normalized.durationMs = Number(post.durationMs) || 0;
  if (post.frameRate !== undefined) normalized.frameRate = Number(post.frameRate) || 0;
  if (post.thumbnailWidth !== undefined) normalized.thumbnailWidth = Number(post.thumbnailWidth) || 0;
  if (post.thumbnailHeight !== undefined) normalized.thumbnailHeight = Number(post.thumbnailHeight) || 0;
  if (post.assetId !== undefined) normalized.assetId = String(post.assetId || '');
  if (post.mediaKind !== undefined) normalized.mediaKind = post.mediaKind === 'video' ? 'video' : 'image';
  if (post.thumbnail !== undefined) normalized.thumbnail = String(post.thumbnail || '');
  if (post.videoCodec !== undefined) normalized.videoCodec = String(post.videoCodec || '');
  if (post.audioCodec !== undefined) normalized.audioCodec = String(post.audioCodec || '');
  if (post.fortune !== undefined) normalized.fortune = String(post.fortune || '');
  normalized.editedAt = Number(post.editedAt) || 0;
  normalized.editCount = Math.max(0, Number.parseInt(post.editCount, 10) || 0);
  if (ROLES.includes(post.capcode)) normalized.capcode = post.capcode;
  else delete normalized.capcode;
  const hasAttachmentArray = Array.isArray(post.attachments);
  if (hasAttachmentArray && post.attachments.length > 32) {
    throw new Error(`Post No.${id} has more than 32 stored attachments; it was left untouched.`);
  }
  const attachmentSources = hasAttachmentArray
    ? post.attachments
    : (post.image && !post.imageDeleted ? [post] : []);
  const attachments = attachmentSources
    .map((attachment, index) => normalizeAttachment(
      attachment,
      id,
      index,
      post.spoiler,
      hasAttachmentArray
    ))
    .filter(Boolean);
  syncPrimaryAttachment(normalized, attachments);
  if (!attachments.length && post.imageDeleted) normalized.imageDeleted = true;
  else delete normalized.imageDeleted;
  delete normalized._asset;
  delete normalized._paths;

  if (isThread) {
    normalized.title = String(post.title || '');
    normalized.bumpedAt = Number(post.bumpedAt) || normalized.createdAt;
    normalized.sticky = Boolean(post.sticky);
    normalized.locked = Boolean(post.locked);
    normalized.cyclic = Boolean(post.cyclic);
    normalized.archived = Boolean(post.archived);
    normalized.archivedAt = normalized.archived ? (Number(post.archivedAt) || normalized.createdAt) : 0;
    normalized.replies = Array.isArray(post.replies)
      ? post.replies.map(reply => normalizePost(reply, false)).filter(reply => reply.id)
      : [];
  } else {
    delete normalized.replies;
  }

  return normalized;
}

function normalizeTrash(trash, boardIds, fallbackBoardId) {
  const seenIds = new Set();
  return trash.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`posts.json contains an invalid trash entry at position ${index + 1}; it was left untouched.`);
    }
    const kind = ['thread', 'reply', 'attachment'].includes(value.kind) ? value.kind : '';
    if (!kind || !value.post || typeof value.post !== 'object' || Array.isArray(value.post)) {
      throw new Error(`posts.json contains an invalid trash snapshot at position ${index + 1}; it was left untouched.`);
    }
    const post = normalizePost(value.post, kind === 'thread');
    const suppliedId = String(value.id || '');
    const digest = crypto.createHash('sha256')
      .update(`${kind}:${post.id}:${value.deletedAt || ''}:${index}`)
      .digest('hex')
      .slice(0, 24);
    const baseId = BOARD_RULE_ID_PATTERN.test(suppliedId) ? suppliedId : `legacy-trash-${digest}`;
    let id = baseId;
    let suffix = index + 1;
    while (seenIds.has(id)) {
      id = `${baseId.slice(0, 68)}-${suffix}`;
      suffix += 1;
    }
    seenIds.add(id);
    const suppliedBoardId = String(value.boardId || post.boardId || '');
    const boardId = boardIds.has(suppliedBoardId) ? suppliedBoardId : fallbackBoardId;
    if (kind === 'thread') post.boardId = boardId;
    const deletedAt = Number(value.deletedAt) || Date.now();
    const threadId = numericId(value.threadId) || (kind === 'thread' ? post.id : numericId(value.parentThreadId));
    if (!threadId) {
      throw new Error(`posts.json contains trash without a valid parent thread at position ${index + 1}; it was left untouched.`);
    }
    return {
      id,
      kind,
      boardId,
      threadId,
      postId: post.id,
      position: Math.max(0, Number.parseInt(value.position, 10) || 0),
      attachmentId: BOARD_RULE_ID_PATTERN.test(String(value.attachmentId || ''))
        ? String(value.attachmentId)
        : '',
      attachmentPosition: Math.max(0, Number.parseInt(value.attachmentPosition, 10) || 0),
      post,
      reason: String(value.reason || '').replace(/\0/g, '').trim().slice(0, 500),
      deletedAt,
      purgeAt: Math.max(deletedAt, Number(value.purgeAt) || (deletedAt + 14 * 24 * 60 * 60 * 1000)),
      deletedById: String(value.deletedById || ''),
      deletedByName: String(value.deletedByName || ''),
      ...(BOARD_RULE_ID_PATTERN.test(String(value.restoringToken || '')) ? {
        restoringToken: String(value.restoringToken),
        restoringAt: Number(value.restoringAt) || deletedAt
      } : {})
    };
  });
}

function normalizeRevisionState(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    name: String(source.name || '').replace(/\0/g, '').trim().slice(0, 80),
    title: String(source.title || '').replace(/\0/g, '').trim().slice(0, 120),
    comment: String(source.comment || '').replace(/\0/g, '').replace(/\r\n?/g, '\n').normalize('NFC')
  };
}

function normalizeRevisions(revisions, boardIds, fallbackBoardId) {
  const seenIds = new Set();
  return revisions.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`posts.json contains an invalid revision at position ${index + 1}; it was left untouched.`);
    }
    const postId = numericId(value.postId);
    const threadId = numericId(value.threadId);
    if (!postId || !threadId) {
      throw new Error(`posts.json contains a revision with an invalid post reference at position ${index + 1}; it was left untouched.`);
    }
    const suppliedId = String(value.id || '');
    const editedAt = Number(value.editedAt) || Date.now();
    const digest = crypto.createHash('sha256')
      .update(`${postId}:${editedAt}:${index}`)
      .digest('hex')
      .slice(0, 24);
    const baseId = BOARD_RULE_ID_PATTERN.test(suppliedId) ? suppliedId : `legacy-revision-${digest}`;
    let id = baseId;
    let suffix = index + 1;
    while (seenIds.has(id)) {
      id = `${baseId.slice(0, 68)}-${suffix}`;
      suffix += 1;
    }
    seenIds.add(id);
    const suppliedBoardId = String(value.boardId || '');
    return {
      id,
      postId,
      threadId,
      boardId: boardIds.has(suppliedBoardId) ? suppliedBoardId : fallbackBoardId,
      before: normalizeRevisionState(value.before),
      after: normalizeRevisionState(value.after),
      reason: String(value.reason || '').replace(/\0/g, '').trim().slice(0, 500),
      editedAt,
      editedById: String(value.editedById || ''),
      editedByName: String(value.editedByName || '')
    };
  });
}

function normalizeReportHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-50).flatMap(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const action = ['resolved', 'reopened', 'target-deleted'].includes(entry.action)
      ? entry.action
      : '';
    if (!action) return [];
    return [{
      action,
      resolution: String(entry.resolution || ''),
      note: String(entry.note || '').replace(/\0/g, '').trim(),
      actorId: String(entry.actorId || ''),
      actorName: String(entry.actorName || ''),
      createdAt: Number(entry.createdAt) || Date.now()
    }];
  });
}

function normalizeReports(reports, threads, boardIds, fallbackBoardId) {
  const locations = new Map();
  for (const thread of threads) {
    locations.set(thread.id, { threadId: thread.id, boardId: thread.boardId });
    for (const reply of thread.replies) {
      locations.set(reply.id, { threadId: thread.id, boardId: thread.boardId });
    }
  }

  const seenIds = new Set();
  const seenOpenDedupeKeys = new Set();
  return reports.flatMap((report, index) => {
    if (!report || typeof report !== 'object' || Array.isArray(report)) {
      throw new Error(`posts.json contains an invalid report at entry ${index + 1}; it was left untouched.`);
    }
    const postId = numericId(report.postId);
    const location = locations.get(postId);
    const digest = crypto.createHash('sha256')
      .update(`${postId}:${report.reason || ''}:${report.createdAt || ''}:${index}`)
      .digest('hex')
      .slice(0, 16);
    const baseId = BOARD_RULE_ID_PATTERN.test(String(report.id || ''))
      ? String(report.id)
      : `legacy-report-${digest}`;
    let id = baseId;
    let suffix = index + 1;
    while (seenIds.has(id)) {
      id = `${baseId.slice(0, 68)}-${suffix}`;
      suffix += 1;
    }
    seenIds.add(id);

    const createdAt = Number(report.createdAt) || Date.now();
    const closedAt = Number(report.closedAt) || 0;
    const status = report.status === 'closed' || closedAt ? 'closed' : 'open';
    const suppliedBoardId = String(report.boardId || '');
    const reporterKey = /^[A-Za-z0-9_-]{43}$/.test(String(report.reporterKey || ''))
      ? String(report.reporterKey)
      : '';
    const derivedDedupeKey = reporterKey
      ? crypto.createHash('sha256').update(`${postId}:${reporterKey}`).digest('hex')
      : '';
    const requestedDedupeKey = SHA256_PATTERN.test(String(report.openDedupeKey || ''))
      ? String(report.openDedupeKey).toLowerCase()
      : derivedDedupeKey;
    const openDedupeKey = status === 'open' && requestedDedupeKey && !seenOpenDedupeKeys.has(requestedDedupeKey)
      ? requestedDedupeKey
      : '';
    if (openDedupeKey) seenOpenDedupeKeys.add(openDedupeKey);
    return [{
      id,
      postId,
      threadId: numericId(report.threadId) || location?.threadId || postId,
      boardId: boardIds.has(suppliedBoardId)
        ? suppliedBoardId
        : (location?.boardId || fallbackBoardId),
      category: /^[a-z0-9][a-z0-9_-]{0,31}$/.test(String(report.category || ''))
        ? String(report.category)
        : 'other',
      reason: String(report.reason || '').replace(/\0/g, '').trim(),
      reporterKey,
      ...(openDedupeKey ? { openDedupeKey } : {}),
      status,
      createdAt,
      updatedAt: Number(report.updatedAt) || closedAt || createdAt,
      closedAt: status === 'closed' ? (closedAt || createdAt) : 0,
      resolution: status === 'closed' ? String(report.resolution || 'dismissed') : '',
      moderatorNote: status === 'closed'
        ? String(report.moderatorNote || '').replace(/\0/g, '').trim()
        : '',
      history: normalizeReportHistory(report.history)
    }];
  });
}

function normalizeSanctions(bans, boardIds) {
  const seenIds = new Set();
  return bans.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`posts.json contains an invalid sanction at entry ${index + 1}; it was left untouched.`);
    }
    const suppliedId = String(value.id || '');
    const digest = crypto.createHash('sha256')
      .update(`${value.posterKey || value.fileHash || value.uploadHash || ''}:${value.createdAt || ''}:${index}`)
      .digest('hex')
      .slice(0, 20);
    const baseId = BOARD_RULE_ID_PATTERN.test(suppliedId) ? suppliedId : `legacy-sanction-${digest}`;
    let id = baseId;
    let suffix = index + 1;
    while (seenIds.has(id)) {
      id = `${baseId.slice(0, 68)}-${suffix}`;
      suffix += 1;
    }
    seenIds.add(id);

    const kind = value.kind === 'warning' ? 'warning' : 'ban';
    const fileHash = String(value.fileHash || value.uploadHash || '').toLowerCase();
    const target = value.target === 'file' || /^[a-f0-9]{64}$/.test(fileHash) ? 'file' : 'poster';
    const suppliedBoardId = String(value.boardId || '');
    const scope = value.scope === 'board' && boardIds.has(suppliedBoardId) ? 'board' : 'global';
    const createdAt = Number(value.createdAt) || Date.now();
    const appealId = BOARD_RULE_ID_PATTERN.test(String(value.appealId || ''))
      ? String(value.appealId)
      : `appeal-${crypto.createHash('sha256').update(id).digest('hex').slice(0, 24)}`;
    return {
      id,
      kind,
      target,
      scope,
      boardId: scope === 'board' ? suppliedBoardId : '',
      posterKey: target === 'poster' ? String(value.posterKey || '') : '',
      fileHash: target === 'file' ? fileHash : '',
      reason: String(value.reason || 'Rule violation').replace(/\0/g, '').trim().slice(0, 300),
      reasonVisible: value.reasonVisible !== false,
      moderatorNote: String(value.moderatorNote || '').replace(/\0/g, '').trim().slice(0, 500),
      appealId,
      active: value.active !== false,
      createdAt,
      updatedAt: Number(value.updatedAt) || createdAt,
      expiresAt: kind === 'ban' ? (Number(value.expiresAt) || 0) : 0,
      deliveredAt: kind === 'warning' ? (Number(value.deliveredAt) || 0) : 0,
      liftedAt: Number(value.liftedAt) || 0,
      createdById: String(value.createdById || ''),
      createdByName: String(value.createdByName || '')
    };
  });
}

function normalizeMediaHashBans(values, boardIds, sanctions = []) {
  const source = Array.isArray(values) ? values : [];
  const legacy = sanctions
    .filter(sanction => sanction.target === 'file' && SHA256_PATTERN.test(sanction.fileHash))
    .map(sanction => ({
      id: `sanction-${sanction.id}`,
      sha256: sanction.fileHash,
      scope: sanction.scope,
      boardId: sanction.boardId,
      active: sanction.active,
      reason: sanction.reason,
      moderatorNote: sanction.moderatorNote,
      createdAt: sanction.createdAt,
      updatedAt: sanction.updatedAt,
      createdById: sanction.createdById,
      createdByName: sanction.createdByName,
      sourceSanctionId: sanction.id
    }));
  const records = [...source, ...legacy];
  const unique = new Map();
  for (const [index, value] of records.entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`posts.json contains an invalid media hash ban at entry ${index + 1}; it was left untouched.`);
    }
    const sha256 = String(value.sha256 || value.fileHash || '').toLowerCase();
    if (!SHA256_PATTERN.test(sha256)) {
      throw new Error(`posts.json contains an invalid media hash at entry ${index + 1}; it was left untouched.`);
    }
    const requestedBoard = String(value.boardId || '');
    const scope = value.scope === 'board' && boardIds.has(requestedBoard) ? 'board' : 'global';
    const key = `${scope}:${scope === 'board' ? requestedBoard : ''}:${sha256}`;
    if (unique.has(key)) continue;
    const createdAt = Number(value.createdAt) || Date.now();
    unique.set(key, {
      id: BOARD_RULE_ID_PATTERN.test(String(value.id || ''))
        ? String(value.id)
        : `media-ban-${crypto.createHash('sha256').update(`${key}:${index}`).digest('hex').slice(0, 24)}`,
      sha256,
      scope,
      boardId: scope === 'board' ? requestedBoard : '',
      active: value.active !== false,
      reason: String(value.reason || 'Prohibited media').replace(/\0/g, '').trim().slice(0, 300),
      moderatorNote: String(value.moderatorNote || '').replace(/\0/g, '').trim().slice(0, 500),
      sourceSanctionId: String(value.sourceSanctionId || ''),
      createdAt,
      updatedAt: Number(value.updatedAt) || createdAt,
      createdById: String(value.createdById || ''),
      createdByName: String(value.createdByName || '')
    });
  }
  return [...unique.values()];
}

function normalizeMediaDecisions(values, boardIds) {
  return (Array.isArray(values) ? values : []).slice(-5000).map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !SHA256_PATTERN.test(String(value.sha256 || ''))
      || !MEDIA_DECISIONS.has(value.decision)) {
      throw new Error(`posts.json contains an invalid media decision at entry ${index + 1}; it was left untouched.`);
    }
    const createdAt = Number(value.createdAt) || Date.now();
    return {
      id: BOARD_RULE_ID_PATTERN.test(String(value.id || ''))
        ? String(value.id)
        : `media-decision-${crypto.createHash('sha256').update(`${value.sha256}:${createdAt}:${index}`).digest('hex').slice(0, 20)}`,
      sha256: String(value.sha256).toLowerCase(),
      contentSha256: SHA256_PATTERN.test(String(value.contentSha256 || ''))
        ? String(value.contentSha256).toLowerCase()
        : '',
      boardId: boardIds.has(String(value.boardId || '')) ? String(value.boardId) : '',
      decision: value.decision,
      reasonCode: String(value.reasonCode || '').replace(/[^a-z0-9:_-]/gi, '').slice(0, 80),
      reason: String(value.reason || '').replace(/\0/g, '').trim().slice(0, 300),
      provider: String(value.provider || '').replace(/[^a-z0-9._-]/gi, '').slice(0, 80),
      providerReference: String(value.providerReference || '').replace(/\0/g, '').trim().slice(0, 200),
      actorId: String(value.actorId || ''),
      actorName: String(value.actorName || ''),
      createdAt
    };
  });
}

function normalizeMediaProviderResults(values) {
  return (Array.isArray(values) ? values : []).slice(-5000).map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !SHA256_PATTERN.test(String(value.sha256 || ''))) {
      throw new Error(`posts.json contains an invalid media provider result at entry ${index + 1}; it was left untouched.`);
    }
    return {
      id: BOARD_RULE_ID_PATTERN.test(String(value.id || ''))
        ? String(value.id)
        : `provider-result-${crypto.createHash('sha256').update(`${value.sha256}:${value.checkedAt || ''}:${index}`).digest('hex').slice(0, 20)}`,
      sha256: String(value.sha256).toLowerCase(),
      provider: String(value.provider || '').replace(/[^a-z0-9._-]/gi, '').slice(0, 80),
      available: value.available === true,
      matched: value.matched === true,
      reasonCode: String(value.reasonCode || '').replace(/[^a-z0-9:_-]/gi, '').slice(0, 80),
      providerReference: String(value.providerReference || '').replace(/\0/g, '').trim().slice(0, 200),
      checkedAt: Number(value.checkedAt) || Date.now()
    };
  });
}

function normalizeAppeals(appeals, sanctions, boardIds) {
  const sanctionMap = new Map(sanctions.map(sanction => [sanction.id, sanction]));
  const seenIds = new Set();
  return appeals.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`posts.json contains an invalid appeal at entry ${index + 1}; it was left untouched.`);
    }
    const sanction = sanctionMap.get(String(value.sanctionId || ''));
    if (!sanction || sanction.kind !== 'ban') {
      throw new Error(`posts.json appeal ${index + 1} references an unknown ban; it was left untouched.`);
    }
    const suppliedId = String(value.id || '');
    const digest = crypto.createHash('sha256')
      .update(`${sanction.id}:${value.createdAt || ''}:${index}`)
      .digest('hex')
      .slice(0, 20);
    const baseId = BOARD_RULE_ID_PATTERN.test(suppliedId) ? suppliedId : `legacy-appeal-${digest}`;
    let id = baseId;
    let suffix = index + 1;
    while (seenIds.has(id)) {
      id = `${baseId.slice(0, 68)}-${suffix}`;
      suffix += 1;
    }
    seenIds.add(id);
    const status = ['open', 'accepted', 'denied'].includes(value.status) ? value.status : 'open';
    const createdAt = Number(value.createdAt) || Date.now();
    return {
      id,
      sanctionId: sanction.id,
      boardId: sanction.scope === 'board' && boardIds.has(sanction.boardId) ? sanction.boardId : '',
      message: String(value.message || '').replace(/\0/g, '').trim().slice(0, 2000),
      status,
      createdAt,
      updatedAt: Number(value.updatedAt) || createdAt,
      resolvedAt: status === 'open' ? 0 : (Number(value.resolvedAt) || createdAt),
      staffNote: String(value.staffNote || '').replace(/\0/g, '').trim().slice(0, 500),
      resolvedById: String(value.resolvedById || ''),
      resolvedByName: String(value.resolvedByName || '')
    };
  });
}

function normalizeStaff(staff, boardIds) {
  const seenIds = new Set();
  const seenUsernames = new Set();
  return staff.flatMap((account, index) => {
    if (!account || typeof account !== 'object' || Array.isArray(account)) {
      throw new Error('posts.json contains an invalid staff account; it was left untouched.');
    }
    const username = normalizeUsername(account.username);
    if (!USERNAME_PATTERN.test(username)) {
      throw new Error(`posts.json contains an invalid staff username at entry ${index + 1}; it was left untouched.`);
    }
    if (seenUsernames.has(username)) {
      throw new Error(`posts.json contains duplicate staff username ${username}; it was left untouched.`);
    }
    seenUsernames.add(username);

    const digest = crypto.createHash('sha256').update(`${username}:${index}`).digest('hex').slice(0, 16);
    const baseId = BOARD_RULE_ID_PATTERN.test(String(account.id || ''))
      ? String(account.id)
      : `legacy-staff-${digest}`;
    let id = baseId;
    let suffix = index + 1;
    while (seenIds.has(id)) {
      id = `${baseId.slice(0, 68)}-${suffix}`;
      suffix += 1;
    }
    seenIds.add(id);

    if (!ROLES.includes(account.role)) {
      throw new Error(`Staff account ${username} has an invalid role; posts.json was left untouched.`);
    }
    const role = account.role;
    if (!['global', 'boards'].includes(account.scope)) {
      throw new Error(`Staff account ${username} has an invalid scope; posts.json was left untouched.`);
    }
    const scope = ['root', 'admin'].includes(role) || account.scope === 'global'
      ? 'global'
      : 'boards';
    const createdAt = Number(account.createdAt) || Date.now();
    const passwordHash = String(account.passwordHash || '');
    if (passwordHash && !/^scrypt\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/.test(passwordHash)) {
      throw new Error(`Staff account ${username} has an unsupported password hash; posts.json was left untouched.`);
    }
    const mfaSecret = String(account.mfaSecret || '');
    const mfaPendingSecret = String(account.mfaPendingSecret || '');
    if ((mfaSecret && !ENCRYPTED_MFA_PATTERN.test(mfaSecret))
      || (mfaPendingSecret && !ENCRYPTED_MFA_PATTERN.test(mfaPendingSecret))) {
      throw new Error(`Staff account ${username} has invalid encrypted MFA data; posts.json was left untouched.`);
    }
    if (account.mfaEnabled === true && !mfaSecret) {
      throw new Error(`Staff account ${username} has MFA enabled without a secret; posts.json was left untouched.`);
    }
    const normalizeRecoveryHashes = (values, field) => {
      const hashes = [...new Set(Array.isArray(values) ? values.map(String) : [])];
      if (hashes.length > 20 || hashes.some(hash => !RECOVERY_HASH_PATTERN.test(hash))) {
        throw new Error(`Staff account ${username} has invalid ${field}; posts.json was left untouched.`);
      }
      return hashes;
    };
    const recoveryHashes = normalizeRecoveryHashes(account.mfaRecoveryHashes, 'MFA recovery hashes');
    const pendingRecoveryHashes = normalizeRecoveryHashes(
      account.mfaPendingRecoveryHashes,
      'pending MFA recovery hashes'
    );
    return [{
      id,
      username,
      displayName: String(account.displayName || username).replace(/\0/g, '').trim().slice(0, 80) || username,
      passwordHash,
      role,
      scope,
      boardIds: scope === 'boards'
        ? [...new Set(Array.isArray(account.boardIds) ? account.boardIds.map(String) : [])]
          .filter(boardId => boardIds.has(boardId))
        : [],
      enabled: account.enabled !== false,
      sessionVersion: Number.isSafeInteger(Number(account.sessionVersion)) && Number(account.sessionVersion) > 0
        ? Number(account.sessionVersion)
        : 1,
      createdAt,
      updatedAt: Number(account.updatedAt) || createdAt,
      lastLoginAt: Number(account.lastLoginAt) || 0,
      mfaEnabled: account.mfaEnabled === true,
      ...(mfaSecret ? { mfaSecret } : {}),
      ...(recoveryHashes.length ? { mfaRecoveryHashes: recoveryHashes } : {}),
      mfaLastCounter: Number.isSafeInteger(Number(account.mfaLastCounter))
        ? Number(account.mfaLastCounter)
        : -1,
      mfaEnabledAt: Number(account.mfaEnabledAt) || 0,
      ...(mfaPendingSecret ? {
        mfaPendingSecret,
        mfaPendingRecoveryHashes: pendingRecoveryHashes,
        mfaPendingAt: Number(account.mfaPendingAt) || Date.now()
      } : {})
    }];
  });
}

function extractReferences(comment, maximum) {
  const references = [];
  const seen = new Set();
  const pattern = /(?:^|[^>])>>(\d+)/g;
  let match;

  while ((match = pattern.exec(String(comment || ''))) && references.length < maximum) {
    const id = numericId(match[1]);
    if (id && !seen.has(id)) {
      seen.add(id);
      references.push(id);
    }
  }

  return references;
}

function allPosts(data) {
  const posts = [];
  for (const thread of data.threads) {
    posts.push({ post: thread, threadId: thread.id, thread });
    for (const reply of thread.replies) posts.push({ post: reply, threadId: thread.id, thread });
  }
  return posts;
}

function trashPosts(trash) {
  const posts = [];
  for (const entry of trash) {
    posts.push({ post: entry.post, threadId: entry.threadId, thread: entry.post });
    if (entry.kind === 'thread') {
      for (const reply of entry.post.replies) {
        posts.push({ post: reply, threadId: entry.threadId, thread: entry.post });
      }
    }
  }
  return posts;
}

function normalizeMedia(media, threads, trash = []) {
  const assets = new Map();
  const safeId = value => BOARD_RULE_ID_PATTERN.test(String(value || '')) ? String(value) : '';

  for (const [index, value] of media.entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`posts.json contains an invalid media asset at entry ${index + 1}; it was left untouched.`);
    }
    const rawPath = String(value.path || value.image || '');
    const id = safeId(value.id)
      || `legacy-media-${crypto.createHash('sha256').update(`${rawPath}:${index}`).digest('hex').slice(0, 24)}`;
    if (assets.has(id)) continue;
    const mime = String(value.mime || value.imageMime || '');
    const kind = value.kind === 'video' || mime.startsWith('video/') ? 'video' : 'image';
    const state = MEDIA_STATES.has(value.state) ? value.state : 'approved';
    const hold = state === 'moderator_hold' ? normalizeMediaHold(value.hold) : null;
    assets.set(id, {
      id,
      kind,
      path: rawPath,
      mime,
      extension: String(value.extension || ''),
      bytes: Number(value.bytes ?? value.imageBytes) || 0,
      width: Number(value.width) || 0,
      height: Number(value.height) || 0,
      durationMs: Number(value.durationMs) || 0,
      frameRate: Number(value.frameRate) || 0,
      videoCodec: String(value.videoCodec || ''),
      audioCodec: String(value.audioCodec || ''),
      thumbnail: String(value.thumbnail || ''),
      thumbnailWidth: Number(value.thumbnailWidth) || 0,
      thumbnailHeight: Number(value.thumbnailHeight) || 0,
      md5: String(value.md5 || ''),
      sha256: /^[a-f0-9]{64}$/i.test(String(value.sha256 || '')) ? String(value.sha256).toLowerCase() : '',
      contentSha256: SHA256_PATTERN.test(String(value.contentSha256 || ''))
        ? String(value.contentSha256).toLowerCase()
        : (SHA256_PATTERN.test(String(value.sha256 || '')) ? String(value.sha256).toLowerCase() : ''),
      sourceSha256: SHA256_PATTERN.test(String(value.sourceSha256 || ''))
        ? String(value.sourceSha256).toLowerCase()
        : (SHA256_PATTERN.test(String(value.sha256 || '')) ? String(value.sha256).toLowerCase() : ''),
      metadataStripped: value.metadataStripped === true,
      state,
      approvedAt: Number(value.approvedAt) || (state !== 'approved' ? 0 : Number(value.createdAt) || Date.now()),
      createdAt: Number(value.createdAt) || Date.now(),
      ...(hold ? {
        hold,
        holdPending: value.holdPending === true,
        heldAt: Number(value.heldAt) || Number(value.createdAt) || Date.now(),
        holdReason: value.holdReason === 'hash-ban' ? 'hash-ban' : 'staff-trash'
      } : {}),
      refCount: 0
    });
  }

  for (const entry of [...allPosts({ threads }), ...trashPosts(trash)]) {
    const post = entry.post;
    for (const attachment of post.attachments || []) {
      const legacyId = `legacy-media-${crypto.createHash('sha256')
        .update(String(attachment.image))
        .digest('hex')
        .slice(0, 24)}`;
      const id = safeId(attachment.assetId) || legacyId;
      let asset = assets.get(id);
      if (!asset) {
        const mime = String(attachment.imageMime || '');
        asset = {
          id,
          kind: attachment.mediaKind === 'video' || mime.startsWith('video/') ? 'video' : 'image',
          path: String(attachment.image),
          mime,
          extension: '',
          bytes: Number(attachment.imageBytes) || 0,
          width: Number(attachment.width) || 0,
          height: Number(attachment.height) || 0,
          durationMs: Number(attachment.durationMs) || 0,
          frameRate: Number(attachment.frameRate) || 0,
          videoCodec: String(attachment.videoCodec || ''),
          audioCodec: String(attachment.audioCodec || ''),
          thumbnail: String(attachment.thumbnail || ''),
          thumbnailWidth: Number(attachment.thumbnailWidth) || 0,
          thumbnailHeight: Number(attachment.thumbnailHeight) || 0,
          md5: String(attachment.md5 || ''),
          sha256: /^[a-f0-9]{64}$/i.test(String(attachment.sha256 || ''))
            ? String(attachment.sha256).toLowerCase()
            : '',
          contentSha256: SHA256_PATTERN.test(String(attachment.contentSha256 || ''))
            ? String(attachment.contentSha256).toLowerCase()
            : (SHA256_PATTERN.test(String(attachment.sha256 || '')) ? String(attachment.sha256).toLowerCase() : ''),
          sourceSha256: SHA256_PATTERN.test(String(attachment.sha256 || ''))
            ? String(attachment.sha256).toLowerCase()
            : '',
          metadataStripped: attachment.metadataStripped === true,
          state: 'approved',
          approvedAt: Number(post.createdAt) || Date.now(),
          createdAt: Number(post.createdAt) || Date.now(),
          refCount: 0
        };
        assets.set(id, asset);
      }
      asset.refCount += 1;
      attachment.assetId = id;
      attachment.mediaKind = asset.kind;
      if (!attachment.imageMime && asset.mime) attachment.imageMime = asset.mime;
      if (!attachment.thumbnail && asset.thumbnail) attachment.thumbnail = asset.thumbnail;
      if (!attachment.thumbnailWidth && asset.thumbnailWidth) attachment.thumbnailWidth = asset.thumbnailWidth;
      if (!attachment.thumbnailHeight && asset.thumbnailHeight) attachment.thumbnailHeight = asset.thumbnailHeight;
    }
    syncPrimaryAttachment(post, post.attachments || []);
  }

  return [...assets.values()];
}

function rebuildBacklinks(data, maximumCites) {
  const entries = allPosts(data);
  const index = new Map(entries.map(entry => [entry.post.id, entry]));

  for (const entry of entries) {
    entry.post.references = extractReferences(entry.post.comment, maximumCites);
    entry.post.backlinks = [];
  }

  for (const source of entries) {
    for (const referencedId of source.post.references) {
      const target = index.get(referencedId);
      if (!target) continue;
      target.post.backlinks.push({ id: source.post.id, threadId: source.threadId });
    }
  }

  for (const entry of entries) {
    entry.post.backlinks.sort((left, right) => left.id - right.id);
  }
}

function normalizeData(input, maximumCites = 45, defaultBoard) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('posts.json must contain a JSON object; it was left untouched.');
  }
  const source = input;
  if (source.threads !== undefined && !Array.isArray(source.threads)) {
    throw new Error('posts.json "threads" must be an array; it was left untouched.');
  }
  for (const field of [
    'reports', 'bans', 'appeals', 'trash', 'revisions', 'moderationLog', 'staff', 'media',
    'mediaHashBans', 'mediaDecisions', 'mediaProviderResults'
  ]) {
    if (source[field] !== undefined && !Array.isArray(source[field])) {
      throw new Error(`posts.json "${field}" must be an array; it was left untouched.`);
    }
  }

  const boards = validateBoards(source.boards, defaultBoard);
  const boardIds = new Set(boards.map(board => board.id));
  const fallbackBoardId = boards.find(board => board.enabled)?.id || boards[0].id;

  const threads = (source.threads || []).map(thread => {
    const normalized = normalizePost(thread, true);
    if (!normalized.boardId || !boardIds.has(normalized.boardId)) {
      normalized.boardId = fallbackBoardId;
    }
    return normalized;
  });

  let highestId = numericId(source.lastId);
  for (const thread of threads) {
    highestId = Math.max(highestId, thread.id);
    for (const reply of thread.replies) highestId = Math.max(highestId, reply.id);
  }

  const ids = new Set();
  for (const entry of threads.flatMap(thread => [thread, ...thread.replies])) {
    if (ids.has(entry.id)) throw new Error(`posts.json contains duplicate post id ${entry.id}; it was left untouched.`);
    ids.add(entry.id);
  }

  const sanctions = normalizeSanctions(Array.isArray(source.bans) ? source.bans : [], boardIds);
  const trash = normalizeTrash(Array.isArray(source.trash) ? source.trash : [], boardIds, fallbackBoardId);
  for (const entry of trash) {
    highestId = Math.max(highestId, entry.post.id);
    if (entry.kind === 'thread') {
      for (const reply of entry.post.replies) highestId = Math.max(highestId, reply.id);
    }
  }
  const data = {
    version: SCHEMA_VERSION,
    lastId: highestId,
    meta: {
      ...(source.meta && typeof source.meta === 'object' ? source.meta : {}),
      siteSecret: String(source.meta?.siteSecret || crypto.randomBytes(32).toString('base64url'))
    },
    boards,
    customization: normalizeCustomization(source.customization),
    threads,
    media: [],
    reports: normalizeReports(
      Array.isArray(source.reports) ? source.reports : [],
      threads,
      boardIds,
      fallbackBoardId
    ),
    bans: sanctions,
    mediaHashBans: normalizeMediaHashBans(
      Array.isArray(source.mediaHashBans) ? source.mediaHashBans : [],
      boardIds,
      sanctions
    ),
    mediaDecisions: normalizeMediaDecisions(
      Array.isArray(source.mediaDecisions) ? source.mediaDecisions : [],
      boardIds
    ),
    mediaProviderResults: normalizeMediaProviderResults(
      Array.isArray(source.mediaProviderResults) ? source.mediaProviderResults : []
    ),
    appeals: normalizeAppeals(Array.isArray(source.appeals) ? source.appeals : [], sanctions, boardIds),
    trash,
    revisions: normalizeRevisions(
      Array.isArray(source.revisions) ? source.revisions : [],
      boardIds,
      fallbackBoardId
    ),
    staff: normalizeStaff(Array.isArray(source.staff) ? source.staff : [], boardIds),
    moderationLog: Array.isArray(source.moderationLog) ? source.moderationLog.slice(-200) : []
  };

  data.media = normalizeMedia(Array.isArray(source.media) ? source.media : [], data.threads, data.trash);

  rebuildBacklinks(data, maximumCites);
  return data;
}

class JsonStore {
  constructor(config) {
    this.filePath = config.dataFile;
    this.maximumCites = config.limits.maxCites;
    this.defaultBoard = createDefaultBoard(config);
    this.leases = new Map();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.initialize();
  }

  initialize() {
    if (!fs.existsSync(this.filePath)) {
      this.write(normalizeData({}, this.maximumCites, this.defaultBoard));
      return;
    }

    const raw = fs.readFileSync(this.filePath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`posts.json is not valid JSON. It was left untouched: ${error.message}`);
    }

    const normalized = normalizeData(parsed, this.maximumCites, this.defaultBoard);
    if (JSON.stringify(parsed) !== JSON.stringify(normalized)) this.write(normalized);
  }

  read() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      throw new Error(`Could not read posts.json: ${error.message}`);
    }
    return normalizeData(parsed, this.maximumCites, this.defaultBoard);
  }

  write(data) {
    const normalized = normalizeData(data, this.maximumCites, this.defaultBoard);
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
    return normalized;
  }

  update(mutator) {
    const data = this.read();
    const result = mutator(data);
    const saved = this.write(data);
    return { data: saved, result };
  }

  async acquireLease(name, ownerId, ttlMs, now = Date.now()) {
    const key = String(name || '');
    const owner = String(ownerId || '');
    const existing = this.leases.get(key);
    if (existing && existing.expiresAt > now && existing.ownerId !== owner) return false;
    this.leases.set(key, { ownerId: owner, expiresAt: now + ttlMs });
    return true;
  }

  async releaseLease(name, ownerId) {
    const key = String(name || '');
    const existing = this.leases.get(key);
    if (!existing || existing.ownerId !== String(ownerId || '')) return false;
    this.leases.delete(key);
    return true;
  }
}

module.exports = {
  JsonStore,
  SCHEMA_VERSION,
  BOARD_TAG_PATTERN,
  MAX_BOARD_TAGS,
  BOARD_FILTER_KINDS,
  MAX_BOARD_FILTERS,
  MAX_BOARD_FILTER_TEXT,
  allPosts,
  createDefaultBoard,
  defaultBoardUri,
  extractReferences,
  normalizeData,
  normalizeBoardRules,
  normalizeBoardSettings,
  normalizeBoardAppearance,
  normalizeBoardTags,
  normalizeBoardFilters,
  normalizeCustomization,
  normalizeMedia,
  normalizeMediaDecisions,
  normalizeMediaHashBans,
  normalizeMediaProviderResults,
  normalizeTrash,
  normalizeRevisions,
  normalizeReports,
  normalizeSanctions,
  normalizeAppeals,
  normalizeStaff,
  rebuildBacklinks,
  validateBoards
};
