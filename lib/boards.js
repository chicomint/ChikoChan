'use strict';

const { httpError } = require('./utils');

const BOARD_URI_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const RESERVED_URIS = new Set([
  'admin', 'api', 'login', 'logout', 'static',
  'style', 'client', 'src', 'thread', 'catalog',
  'search', 'report', 'delete', 'post', 'reply',
  'feed', 'boards', 'healthz', 'readyz', 'robots',
  'index', 'favicon', 'chikki', 'res', 'overboard',
  'images', 'assets', 'js', 'css'
]);

function validateBoardUri(uri, existingUris = new Set()) {
  const normalized = String(uri || '').trim().toLowerCase();
  if (!normalized) throw httpError(400, 'Board URI is required.');
  if (!BOARD_URI_PATTERN.test(normalized)) {
    throw httpError(400, 'Board URI must be lowercase letters, numbers, underscores, or hyphens.');
  }
  if (RESERVED_URIS.has(normalized)) {
    throw httpError(400, `/${normalized}/ is a reserved application route.`);
  }
  if (existingUris.has(normalized)) {
    throw httpError(409, `A board with URI /${normalized}/ already exists.`);
  }
  return normalized;
}

function isReservedUri(uri) {
  return RESERVED_URIS.has(String(uri || '').trim().toLowerCase());
}

function groupBoardsByCategory(boards) {
  const groups = new Map();
  for (const board of boards) {
    const category = board.category || 'Other';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(board);
  }
  return groups;
}

module.exports = {
  BOARD_URI_PATTERN,
  RESERVED_URIS,
  groupBoardsByCategory,
  isReservedUri,
  validateBoardUri
};
