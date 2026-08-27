'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  parseEncryptionKey,
  totpAt,
  verifyTotp
} = require('../lib/mfa');

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('TOTP follows RFC 6238 timing and rejects replayed counters', () => {
  assert.equal(totpAt(RFC_SECRET, 59000), '287082');
  assert.equal(verifyTotp(RFC_SECRET, '287082', { now: 59000, lastCounter: -1 }), 1);
  assert.equal(verifyTotp(RFC_SECRET, '287082', { now: 59000, lastCounter: 1 }), null);
  assert.equal(verifyTotp(RFC_SECRET, 'not-a-code', { now: 59000 }), null);
});

test('MFA secrets are authenticated-encrypted and recovery codes are only keyed hashes', () => {
  const key = parseEncryptionKey('11'.repeat(32));
  const encrypted = encryptSecret(RFC_SECRET, key);
  assert.match(encrypted, /^v1\./);
  assert.equal(encrypted.includes(RFC_SECRET), false);
  assert.equal(decryptSecret(encrypted, key), RFC_SECRET);
  const tamperedParts = encrypted.split('.');
  tamperedParts[3] = `${tamperedParts[3][0] === 'A' ? 'B' : 'A'}${tamperedParts[3].slice(1)}`;
  const tampered = tamperedParts.join('.');
  assert.throws(() => decryptSecret(tampered, key));

  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  assert.match(codes[0], /^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){2}$/);
  const hash = hashRecoveryCode(codes[0], key);
  assert.match(hash, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(hash.includes(codes[0]), false);
});
