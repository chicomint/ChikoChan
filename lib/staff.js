'use strict';

const ROLES = Object.freeze(['root', 'admin', 'moderator', 'janitor']);
const ROLE_LABELS = Object.freeze({
  root: 'Root',
  admin: 'Administrator',
  moderator: 'Moderator',
  janitor: 'Janitor'
});
const ROLE_RANK = Object.freeze({ root: 0, admin: 1, moderator: 2, janitor: 3 });
const ROLE_PERMISSIONS = Object.freeze({
  root: new Set(['*']),
  admin: new Set([
    'dashboard.view', 'reports.manage', 'posts.delete', 'posts.edit', 'threads.manage',
    'posts.capcode', 'bans.manage', 'boards.manage', 'site.manage', 'staff.manage'
  ]),
  moderator: new Set([
    'dashboard.view', 'reports.manage', 'posts.delete', 'posts.edit', 'posts.capcode',
    'threads.manage', 'bans.manage'
  ]),
  janitor: new Set(['dashboard.view', 'reports.manage', 'posts.delete', 'posts.capcode'])
});
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{2,31}$/;

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function roleLabel(role) {
  return ROLE_LABELS[role] || String(role || 'Unknown');
}

function staffCan(staff, permission, boardId = '') {
  if (!staff || staff.enabled === false || !ROLES.includes(staff.role)) return false;
  const permissions = ROLE_PERMISSIONS[staff.role];
  if (!permissions.has('*') && !permissions.has(permission)) return false;
  if (boardId && staff.scope === 'boards' && !staff.boardIds.includes(String(boardId))) return false;
  return true;
}

function canAssignRole(actor, role) {
  if (!actor || !ROLES.includes(role)) return false;
  if (actor.role === 'root') return true;
  return actor.role === 'admin' && ROLE_RANK[role] > ROLE_RANK.admin;
}

function canManageAccount(actor, target) {
  if (!actor || !target || actor.id === target.id) return false;
  if (actor.role === 'root') return true;
  return actor.role === 'admin' && ROLE_RANK[target.role] > ROLE_RANK.admin;
}

module.exports = {
  ROLES,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  ROLE_RANK,
  USERNAME_PATTERN,
  canAssignRole,
  canManageAccount,
  normalizeUsername,
  roleLabel,
  staffCan
};
