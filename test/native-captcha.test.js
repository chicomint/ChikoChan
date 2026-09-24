'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { NativeCaptcha } = require('../lib/native-captcha');
const { MemoryAuthorizationNonceStore } = require('../lib/posting-authorization');

function fixture() {
  const captcha = new NativeCaptcha({
    postingAuthorization: { enabled: true, secret: 'test-native-captcha-secret-123456789' },
    antiAbuse: { turnstile: {} }, deployment: { publicOrigin: '' }
  }, new MemoryAuthorizationNonceStore());
  const scope = { board: 'chiko', thread: 0, addressKey: 'address', session: 'a'.repeat(64) };
  const issued = captcha.issue(scope);
  const request = { query: { nativeChallenge: issued.token }, headers: { cookie: `chikochan_verification=${scope.session}` } };
  return { captcha, scope, issued, request };
}

test('native challenge is encrypted, expiring, scope-bound and single-attempt', async () => {
  const { captcha, scope, issued, request } = fixture();
  assert.match(issued.image, /^data:image\/png;base64,/);
  const png = Buffer.from(issued.image.split(',')[1], 'base64');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 210);
  const value = captcha.parse(issued.token);
  assert.equal(Buffer.from(issued.token, 'base64url').includes(Buffer.from(value.answer)), false);
  assert.equal(captcha.parse(`${issued.token.slice(0, 20)}!${issued.token.slice(21)}`), null);
  await assert.rejects(captcha.consume(request, { ...scope, thread: 1 }), /another form/);
  await assert.rejects(captcha.consume(request, { ...scope, addressKey: 'other' }), /another form/);
  await assert.rejects(captcha.consume({ ...request, headers: {} }, scope), /another form/);
  const accepted = await captcha.consume(request, scope);
  assert.throws(() => captcha.verify(accepted, 'wrong'), /incorrect/);
  await assert.rejects(captcha.consume(request, scope), /already attempted/);
  captcha.verify(accepted, value.answer);
  const now = Date.now;
  try {
    Date.now = () => value.expiresAt + 1;
    assert.equal(captcha.parse(issued.token), null);
  } finally { Date.now = now; }
});
