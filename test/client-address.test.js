'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ClientAddressPolicy, normalizeAddress } = require('../lib/client-address');

test('normalizes socket addresses and never exposes raw values as fingerprints', () => {
  assert.equal(normalizeAddress('::ffff:192.0.2.4'), '192.0.2.4');
  assert.equal(normalizeAddress('[2001:db8::2]:443'), '2001:db8::2');
  assert.equal(normalizeAddress('not-an-address'), '');

  const policy = new ClientAddressPolicy({
    privacy: { abuseFingerprintSecret: 'unit-test-address-secret-that-is-long-enough' }
  });
  const request = { ip: '::ffff:192.0.2.4', socket: { remoteAddress: '198.51.100.8' } };
  const postKey = policy.fingerprint(request, 'poster');
  const reportKey = policy.fingerprint(request, 'reporter');
  assert.match(postKey, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(postKey, reportKey);
  assert.equal(postKey.includes('192.0.2.4'), false);
});
