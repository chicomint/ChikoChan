'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  COOKIE_NAME,
  MemoryAuthorizationNonceStore,
  PostingAuthorization
} = require('../lib/posting-authorization');

function authorization() {
  return new PostingAuthorization({
    deployment: { publicOrigin: 'https://boards.example' },
    postingAuthorization: {
      enabled: true,
      secret: 'posting-authorization-unit-secret-123456789',
      ttlMs: 60000
    }
  }, new MemoryAuthorizationNonceStore());
}

function requestWith(token, secure = true) {
  return {
    headers: { cookie: `${COOKIE_NAME}=${encodeURIComponent(token)}` },
    query: {},
    secure,
    get() { return ''; }
  };
}

test('posting authorizations are signed, scoped, address-bound, and one-time', async () => {
  const service = authorization();
  const addressKey = 'a'.repeat(43);
  const issued = await service.issue({ boardUri: 'chiko', threadId: 42, addressKey });
  assert.ok(issued.expiresAt > Date.now());
  assert.equal(JSON.stringify(service.parse(issued.token)).includes(service.config.secret), false);

  const wrongScope = await service.consume(requestWith(issued.token), {
    boardUri: 'chiko', threadId: 41, addressKey
  });
  assert.equal(wrongScope, null);

  const accepted = await service.consume(requestWith(issued.token), {
    boardUri: 'chiko', threadId: 42, addressKey
  });
  assert.equal(accepted.board, 'chiko');
  assert.equal(await service.consume(requestWith(issued.token), {
    boardUri: 'chiko', threadId: 42, addressKey
  }), null);
});

test('posting authorization cookies are HttpOnly, strict, short-lived, and secure for HTTPS origins', async () => {
  const service = authorization();
  const issued = await service.issue({ boardUri: 'chiko', threadId: 0, addressKey: 'b'.repeat(43) });
  const response = {
    headers: {},
    getHeader(name) { return this.headers[name]; },
    setHeader(name, value) { this.headers[name] = value; }
  };
  service.setCookie({ secure: false }, response, issued.token);
  const cookie = response.headers['Set-Cookie'];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Max-Age=60/);
});
