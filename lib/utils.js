'use strict';

const crypto = require('node:crypto');

function cleanText(value, fallback = '') {
  const text = String(value ?? '')
    .replace(/\0/g, '')
    .replace(/\r\n?/g, '\n')
    .normalize('NFC')
    .trim();
  return text || fallback;
}

function escapeHTML(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeXML(value) {
  return escapeHTML(value);
}

function formatBytes(bytes) {
  const size = Number(bytes) || 0;
  if (size === 0) return '0 Bytes';

  const units = ['Bytes', 'KB', 'MB', 'GB'];
  const unitIndex = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  const amount = Number((size / (1024 ** unitIndex)).toFixed(2));
  return `${amount} ${units[unitIndex]}`;
}

function formatDate(timestamp) {
  const pad = value => String(value).padStart(2, '0');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const date = new Date(Number(timestamp) || Date.now());
  return `${String(date.getFullYear()).slice(-2)}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`
    + `(${days[date.getDay()]})${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function previewText(value, maxLength = 150) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return 'No comment.';
  return text.length <= maxLength ? text : `${text.slice(0, maxLength).trim()}…`;
}

function timingSafeEqualStrings(left, right) {
  const a = crypto.createHash('sha256').update(String(left ?? '')).digest();
  const b = crypto.createHash('sha256').update(String(right ?? '')).digest();
  return crypto.timingSafeEqual(a, b);
}

function hashPassword(password) {
  const normalized = String(password ?? '');
  if (!normalized) return '';

  const salt = crypto.randomBytes(16);
  const digest = crypto.scryptSync(normalized, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${digest.toString('base64url')}`;
}

function verifyPassword(password, encoded) {
  if (!password || !encoded) return false;
  const [algorithm, saltText, digestText] = String(encoded).split('$');
  if (algorithm !== 'scrypt' || !saltText || !digestText) return false;

  try {
    const digest = Buffer.from(digestText, 'base64url');
    const candidate = crypto.scryptSync(String(password), Buffer.from(saltText, 'base64url'), digest.length);
    return digest.length === candidate.length && crypto.timingSafeEqual(digest, candidate);
  } catch {
    return false;
  }
}

function parseNameAndTrip(rawName, anonymousName, secret, enabled = true) {
  const value = cleanText(rawName, anonymousName);
  if (!enabled) return { name: value, trip: '' };

  const marker = value.indexOf('#');
  if (marker === -1) return { name: value, trip: '' };

  const displayName = cleanText(value.slice(0, marker), anonymousName);
  const tripInput = value.slice(marker + 1);
  if (!tripInput) return { name: displayName, trip: '' };

  const secure = tripInput.startsWith('#');
  const key = secure ? tripInput.slice(1) : tripInput;
  if (!key) return { name: displayName, trip: '' };

  const digest = crypto
    .createHmac('sha256', secret)
    .update(`${secure ? 'secure' : 'trip'}:${key}`)
    .digest('base64url')
    .replace(/[-_]/g, '.')
    .slice(0, 10);

  return { name: displayName, trip: `${secure ? '!!' : '!'}${digest}` };
}

function parseCookies(header = '') {
  const cookies = {};
  String(header).split(';').forEach(part => {
    const separator = part.indexOf('=');
    if (separator < 0) return;
    const key = part.slice(0, separator).trim();
    if (!key) return;
    try {
      cookies[key] = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      cookies[key] = '';
    }
  });
  return cookies;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

module.exports = {
  cleanText,
  escapeHTML,
  escapeXML,
  formatBytes,
  formatDate,
  hashPassword,
  httpError,
  parseCookies,
  parseNameAndTrip,
  previewText,
  timingSafeEqualStrings,
  verifyPassword
};
