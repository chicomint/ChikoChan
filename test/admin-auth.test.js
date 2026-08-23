'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { AdminAuth } = require('../lib/admin-auth');

function requestForToken(token, secure = false) {
  return {
    headers: { cookie: `chikochan_admin=${encodeURIComponent(token)}` },
    body: {},
    secure
  };
}

test('named admin sessions expose no role or password claims and retain CSRF/cookie protections', () => {
  const auth = new AdminAuth({
    adminPassword: '',
    adminSessionSecret: 'unit-test-session-secret'
  });
  assert.equal(auth.configured, true);
  assert.equal(auth.legacyConfigured, false);

  const token = auth.createToken({
    accountId: 'account-id',
    sessionVersion: 7,
    role: 'root',
    password: 'must-not-be-signed'
  });
  const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
  assert.equal(payload.accountId, 'account-id');
  assert.equal(payload.sessionVersion, 7);
  assert.equal(Object.hasOwn(payload, 'role'), false);
  assert.equal(Object.hasOwn(payload, 'password'), false);

  const request = requestForToken(token, true);
  const session = auth.readSession(request);
  assert.equal(session.accountId, 'account-id');
  request.adminSession = session;
  request.body.csrf = auth.csrf(session);
  assert.equal(auth.verifyCsrf(request), true);
  request.body.csrf = `${request.body.csrf}tampered`;
  assert.equal(auth.verifyCsrf(request), false);

  const response = { setHeader(name, value) { this[name] = value; } };
  auth.setCookie(request, response, token);
  assert.match(response['Set-Cookie'], /Path=\/admin/);
  assert.match(response['Set-Cookie'], /HttpOnly/);
  assert.match(response['Set-Cookie'], /SameSite=Strict/);
  assert.match(response['Set-Cookie'], /Secure/);

  const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(auth.readSession(requestForToken(tampered)), null);
});

test('legacy sessions remain available only when both environment credentials are configured', () => {
  const auth = new AdminAuth({
    adminPassword: 'legacy-password',
    adminSessionSecret: 'unit-test-session-secret'
  });
  assert.equal(auth.legacyConfigured, true);
  assert.equal(auth.verifyPassword('legacy-password'), true);
  const session = auth.readSession(requestForToken(auth.createToken()));
  assert.equal(session.kind, 'legacy');
  assert.equal(Object.hasOwn(session, 'accountId'), false);
});
