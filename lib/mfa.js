'use strict';

const crypto = require('node:crypto');
const { timingSafeEqualStrings } = require('./utils');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ENCRYPTION_AAD = Buffer.from('chikochan-staff-mfa-v1');

function base32Encode(value) {
  const buffer = Buffer.from(value);
  let bits = 0;
  let accumulator = 0;
  let output = '';
  for (const byte of buffer) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(accumulator >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) output += BASE32_ALPHABET[(accumulator << (5 - bits)) & 31];
  return output;
}

function base32Decode(value) {
  const normalized = String(value || '').toUpperCase().replace(/=+$/g, '');
  if (!normalized || !/^[A-Z2-7]+$/.test(normalized)) throw new Error('Invalid Base32 value.');
  let bits = 0;
  let accumulator = 0;
  const bytes = [];
  for (const character of normalized) {
    accumulator = (accumulator << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((accumulator >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function parseEncryptionKey(value) {
  const supplied = String(value || '').trim();
  let key;
  if (/^[a-f0-9]{64}$/i.test(supplied)) key = Buffer.from(supplied, 'hex');
  else if (/^[A-Za-z0-9+/_-]{43}={0,2}$/.test(supplied)) key = Buffer.from(supplied, 'base64');
  else throw new Error('STAFF_MFA_ENCRYPTION_KEY must encode exactly 32 random bytes.');
  if (key.length !== 32) throw new Error('STAFF_MFA_ENCRYPTION_KEY must encode exactly 32 random bytes.');
  return key;
}

function encryptSecret(secret, encryptionKey) {
  const key = Buffer.isBuffer(encryptionKey) ? encryptionKey : parseEncryptionKey(encryptionKey);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(ENCRYPTION_AAD);
  const ciphertext = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
  return `v1.${nonce.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}

function decryptSecret(value, encryptionKey) {
  const key = Buffer.isBuffer(encryptionKey) ? encryptionKey : parseEncryptionKey(encryptionKey);
  const [version, encodedNonce, encodedCiphertext, encodedTag, extra] = String(value || '').split('.');
  if (version !== 'v1' || !encodedNonce || !encodedCiphertext || !encodedTag || extra) {
    throw new Error('Invalid encrypted MFA secret.');
  }
  const nonce = Buffer.from(encodedNonce, 'base64url');
  const tag = Buffer.from(encodedTag, 'base64url');
  if (nonce.length !== 12 || tag.length !== 16) throw new Error('Invalid encrypted MFA secret.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(ENCRYPTION_AAD);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
    decipher.final()
  ]).toString('utf8');
}

function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function totpAt(secret, now = Date.now(), counterOverride) {
  const counter = Number.isSafeInteger(counterOverride)
    ? counterOverride
    : Math.floor(Number(now) / 30000);
  const movingFactor = Buffer.alloc(8);
  movingFactor.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(movingFactor).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8)
    | digest[offset + 3];
  return String(binary % 1000000).padStart(6, '0');
}

function verifyTotp(secret, suppliedCode, options = {}) {
  const code = String(suppliedCode || '').replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(Number(options.now ?? Date.now()) / 30000);
  const lastCounter = Number.isSafeInteger(Number(options.lastCounter)) ? Number(options.lastCounter) : -1;
  const window = Math.min(2, Math.max(0, Number(options.window) || 1));
  for (let offset = -window; offset <= window; offset += 1) {
    const counter = current + offset;
    if (counter <= lastCounter || counter < 0) continue;
    if (timingSafeEqualStrings(totpAt(secret, 0, counter), code)) return counter;
  }
  return null;
}

function normalizeRecoveryCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
}

function generateRecoveryCodes(count = 10) {
  return Array.from({ length: Math.min(20, Math.max(1, Number(count) || 10)) }, () => {
    const value = base32Encode(crypto.randomBytes(8)).slice(0, 12);
    return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8)}`;
  });
}

function hashRecoveryCode(value, encryptionKey) {
  const normalized = normalizeRecoveryCode(value);
  if (normalized.length !== 12) return '';
  const key = Buffer.isBuffer(encryptionKey) ? encryptionKey : parseEncryptionKey(encryptionKey);
  return crypto.createHmac('sha256', key).update(`recovery:${normalized}`).digest('base64url');
}

function totpUri(secret, username, issuer = 'ChikoChan') {
  const safeIssuer = String(issuer || 'ChikoChan').slice(0, 80);
  const label = `${safeIssuer}:${String(username || '').slice(0, 80)}`;
  const parameters = new URLSearchParams({
    secret,
    issuer: safeIssuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30'
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${parameters}`;
}

module.exports = {
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  normalizeRecoveryCode,
  parseEncryptionKey,
  totpAt,
  totpUri,
  verifyTotp
};
