'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../app');
const { closeApplication } = require('../lib/bootstrap');
const { AdminAuth } = require('../lib/admin-auth');
const { normalizeCustomization } = require('../lib/store');
const { verifyParsedUpgrade } = require('../scripts/verify-upgrade');
const { loadConfig } = require('../config');

async function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chiko-verification-'));
  const options = { storage: 'json', dataDir: directory,
    adminPassword: 'verification-test-password', adminSessionSecret: 'verification-test-session-secret',
    features: { requireImageForThread: false }, limits: { postRateLimit: 100 },
    maintenance: { enabled: false },
    postingAuthorization: { enabled: true, secret: 'verification-test-authorization-secret' },
    antiAbuse: { turnstile: { enabled: true, siteKey: 'test-site-key', secretKey: 'test-secret-key' } },
    turnstileFetch: async (_url, options) => ({ ok: true, text: async () => JSON.stringify({ success: options.body.get('response') === 'test-token', action: 'post', hostname: 'localhost' }) }),
    ...overrides };
  let app, server, base;
  async function start() {
    app = createApp(options);
    await app.locals.chikochan.store.ready;
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await closeApplication(app);
  }
  await start();
  t.after(async () => { await stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  const auth = new AdminAuth(app.locals.chikochan.config), token = auth.createToken();
  const session = auth.readSession({ headers: { cookie: `chikochan_admin=${token}` } });
  const cookie = `chikochan_admin=${token}`, csrf = auth.csrf(session);
  const request = (url, options = {}) => fetch(base + url, { redirect: 'manual', ...options });
  const save = (fields, options = {}) => request('/admin/verification', { method: 'POST',
    headers: { cookie, Accept: 'application/json', ...options.headers }, body: new URLSearchParams({ csrf, ...fields }) });
  const post = fields => {
    const body = new FormData();
    for (const [key, value] of Object.entries({ com: 'A harmless test post', ...fields })) body.set(key, value);
    return request('/chiko/post?threadId=0', { method: 'POST', headers: { Accept: 'application/json' }, body });
  };
  return { get app() { return app; }, request, save, post, cookie, csrf, auth,
    async restart() { await stop(); await start(); } };
}

test('admin switches immediately control real posting, CAPTCHA, Turnstile, and CSP', async t => {
  const f = await fixture(t);
  let response = await f.request('/chiko/'), html = await response.text();
  assert.match(html, /native-verification/); assert.match(html, /data-turnstile-widget/);
  assert.match(response.headers.get('content-security-policy'), /challenges.cloudflare.com/);
  assert.equal((await f.post({})).status, 403);
  assert.equal((await f.save({ postingAuthorization: '0', turnstile: '0' })).status, 303);
  response = await f.request('/chiko/'); html = await response.text();
  assert.doesNotMatch(html, /native-verification|data-turnstile-widget|data-post-authorization/);
  assert.doesNotMatch(response.headers.get('content-security-policy'), /challenges.cloudflare.com/);
  assert.equal((await f.post({})).status, 201);
  assert.equal((await f.post({ bypassCheck: '1' })).status, 403, 'Public administrative bypass remains forbidden');
  assert.equal((await f.save({ postingAuthorization: '1', turnstile: '0' })).status, 303);
  html = await (await f.request('/chiko/')).text();
  assert.match(html, /native-verification/); assert.doesNotMatch(html, /data-turnstile-widget/);
  assert.equal((await f.post({})).status, 403);
  assert.equal((await f.save({ postingAuthorization: '0', turnstile: '1' })).status, 303);
  response = await f.request('/chiko/'); html = await response.text();
  assert.match(html, /native-verification/); assert.match(html, /data-turnstile-widget/);
  assert.match(response.headers.get('content-security-policy'), /challenges.cloudflare.com/);
  assert.equal((await f.post({})).status, 400);
  assert.equal((await f.post({ 'cf-turnstile-response': 'test-token' })).status, 201);
  assert.equal((await f.save({ postingAuthorization: 'inherit', turnstile: 'inherit' })).status, 303);
  assert.deepEqual(f.app.locals.chikochan.service.getCustomization().verification, {});
  assert.equal((await f.post({})).status, 403);
  assert.equal(f.app.locals.chikochan.config.postingAuthorization.enabled, true, 'Server defaults are unchanged outside a request');
});

test('verification overrides persist after restarting and keep other customization and screening intact', async t => {
  const f = await fixture(t), { store } = f.app.locals.chikochan;
  store.update(data => { data.customization.moderation = { adultPolicy: 'block', requireKnownIllegalCheck: true, boards: {} }; });
  const before = f.app.locals.chikochan.service.getCustomization();
  assert.equal((await f.save({ postingAuthorization: '0', turnstile: '0' })).status, 303);
  const after = f.app.locals.chikochan.service.getCustomization();
  assert.deepEqual({ ...after, verification: before.verification }, before);
  const log = store.read().moderationLog.at(-1);
  assert.equal(log.action, 'posting-verification'); assert.equal(log.actorId, 'legacy-root');
  assert.doesNotMatch(JSON.stringify(log), /test-secret-key|verification-test-authorization-secret/);
  const converted = verifyParsedUpgrade(store.read(), { maximumCites: 45, defaultBoard: store.defaultBoard });
  assert.deepEqual(converted.data.customization.verification, { postingAuthorization: false, turnstile: false });
  await f.restart();
  const page = await (await f.request('/admin/verification', { headers: { cookie: f.cookie } })).text();
  assert.match(page, /Current posting authorization: <strong>Off/);
  assert.match(page, /Current Turnstile: <strong>Off/);
  assert.doesNotMatch(page, /test-secret-key|verification-test-authorization-secret/);
  assert.doesNotMatch(await (await f.request('/chiko/')).text(), /native-verification|data-turnstile-widget/);
});

test('only global administrators with valid CSRF and origin can change verification', async t => {
  const f = await fixture(t), { service } = f.app.locals.chikochan;
  const fields = { postingAuthorization: '0', turnstile: '0' };
  assert.equal((await f.request('/admin/verification')).status, 303);
  assert.equal((await f.save(fields, { headers: { cookie: '' } })).status, 303);
  assert.equal((await f.save({ ...fields, csrf: 'bad' })).status, 403);
  assert.equal((await f.save(fields, { headers: { Origin: 'https://other.example' } })).status, 403);
  const root = { id: 'legacy-root', username: 'environment-admin', role: 'root', scope: 'global', enabled: true, legacy: true };
  for (const [role, scope] of [['moderator', 'global'], ['moderator', 'boards'], ['janitor', 'global']]) {
    const account = await service.addStaffAccount({ username: `${role}-${scope}`, displayName: role,
      password: 'test-staff-password', role, scope, boardIds: ['chiko'] }, root);
    const token = f.auth.createToken({ accountId: account.id, sessionVersion: account.sessionVersion });
    const cookie = `chikochan_admin=${token}`;
    const session = f.auth.readSession({ headers: { cookie } });
    assert.equal((await f.request('/admin/verification', { headers: { cookie } })).status, 403);
    assert.equal((await f.save({ ...fields, csrf: f.auth.csrf(session) }, { headers: { cookie } })).status, 403);
  }
  assert.deepEqual(service.getCustomization().verification, {});
  for (const invalid of [{ postingAuthorization: 'false', turnstile: '0' }, { turnstile: '0' }, { postingAuthorization: '0', turnstile: 'yes' }]) {
    assert.equal((await f.save(invalid)).status, 400);
  }
  assert.equal((await f.save({ ...fields, nativeCaptcha: 'false' })).status, 400);
  assert.deepEqual(service.getCustomization().verification, {});
  const account = await service.addStaffAccount({ username: 'admin-test', displayName: 'Admin', password: 'test-staff-password', role: 'admin', scope: 'global' }, root);
  const token = f.auth.createToken({ accountId: account.id, sessionVersion: account.sessionVersion });
  const cookie = `chikochan_admin=${token}`, session = f.auth.readSession({ headers: { cookie } });
  assert.equal((await f.request('/admin/verification', { headers: { cookie } })).status, 200);
  assert.equal((await f.save({ ...fields, csrf: f.auth.csrf(session) }, { headers: { cookie } })).status, 303);
});

test('missing credentials cannot be enabled and invalid stored fields inherit defaults', async t => {
  const f = await fixture(t, { postingAuthorization: { enabled: false, secret: '' }, antiAbuse: { turnstile: { enabled: false, siteKey: '', secretKey: '' } } });
  assert.equal((await f.save({ postingAuthorization: '1', turnstile: '0' })).status, 400);
  assert.equal((await f.save({ postingAuthorization: '0', turnstile: '1' })).status, 400);
  assert.deepEqual(f.app.locals.chikochan.service.getCustomization().verification, {});
  assert.deepEqual(normalizeCustomization({ verification: { postingAuthorization: 'false', turnstile: 1, secretKey: 'unsafe' } }).verification, {});
  f.app.locals.chikochan.store.update(data => { data.customization.verification = { postingAuthorization: true }; });
  assert.equal((await f.post({})).status, 503, 'Missing credentials fail closed instead of using an empty signing key');
  assert.equal((await f.request('/administrator/')).status, 503, 'Public board prefixes do not receive the administrator exception');
  assert.equal((await f.request('/admin/verification', { headers: { cookie: f.cookie } })).status, 200);
  assert.equal((await f.save({ postingAuthorization: '0', turnstile: '0' })).status, 303, 'Administrators can repair an unavailable setting');
  assert.equal((await f.post({})).status, 201);
});

test('Cloudflare stays enforced when the six-digit fallback is disabled, including stale challenges', async t => {
  const f = await fixture(t);
  const oldForm = await f.request('/chiko/');
  const oldHTML = await oldForm.text();
  const token = oldHTML.match(/nativeChallenge=([^"&]+)/)[1];
  const answer = f.app.locals.chikochan.nativeCaptcha.parse(token).answer;
  const cookie = oldForm.headers.getSetCookie().find(value => value.startsWith('chikochan_verification=')).split(';')[0];
  assert.equal((await f.save({ postingAuthorization: '1', turnstile: '1', nativeCaptcha: '0' })).status, 303);
  let response = await f.request('/chiko/'), html = await response.text();
  assert.doesNotMatch(html, /native-verification|name="nativeAnswer"|nativeChallenge=/);
  assert.match(html, /data-turnstile-widget/); assert.match(html, /data-posting-authorization/);
  assert.match(html, /Enable JavaScript to complete Cloudflare verification/);
  assert.match(response.headers.get('content-security-policy'), /challenges.cloudflare.com/);
  const staleAnswer = { board: 'chiko', threadId: '0', nativeAnswer: answer };
  response = await f.request('/posting-authorizations?nativeChallenge=' + token, {
    method: 'POST', headers: { cookie, Accept: 'application/json' }, body: new URLSearchParams(staleAnswer)
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Human verification failed/, 'An old image answer cannot bypass Cloudflare');
  assert.equal((await f.post({})).status, 403);
  response = await f.request('/posting-authorizations', { method: 'POST', headers: { Accept: 'application/json' },
    body: new URLSearchParams({ board: 'chiko', threadId: '0', 'cf-turnstile-response': 'invalid-token' }) });
  assert.equal(response.status, 400);
  response = await f.request('/posting-authorizations', { method: 'POST', headers: { Accept: 'application/json' },
    body: new URLSearchParams({ board: 'chiko', threadId: '0', 'cf-turnstile-response': 'test-token' }) });
  assert.equal(response.status, 201);
  const authorization = (await response.json()).token;
  const post = () => {
    const body = new FormData(); body.set('com', 'Verified with Cloudflare, without the numbers.');
    return f.request('/chiko/post?threadId=0', { method: 'POST', headers: { Accept: 'application/json', Authorization: 'ChikoPost ' + authorization }, body });
  };
  assert.equal((await post()).status, 201);
  assert.equal((await post()).status, 403, 'Posting authorization remains single-use');
  assert.equal((await f.save({ postingAuthorization: 'inherit', turnstile: 'inherit' })).status, 303);
  assert.equal(f.app.locals.chikochan.service.getCustomization().verification.nativeCaptcha, false, 'Old admin forms preserve the new fallback setting');
  await f.restart();
  html = await (await f.request('/chiko/')).text();
  assert.doesNotMatch(html, /native-verification|nativeChallenge=/);
  assert.match(html, /data-turnstile-widget/);
  const { store } = f.app.locals.chikochan;
  const converted = verifyParsedUpgrade(store.read(), { maximumCites: 45, defaultBoard: store.defaultBoard });
  assert.equal(converted.data.customization.verification.nativeCaptcha, false);

  assert.equal((await f.save({ postingAuthorization: '0', turnstile: '1', nativeCaptcha: '0' })).status, 303);
  const staleBody = new FormData(); staleBody.set('com', 'Test stale image fallback'); staleBody.set('nativeAnswer', answer);
  response = await f.request('/chiko/post?threadId=0&nativeChallenge=' + token, {
    method: 'POST', headers: { cookie, Accept: 'application/json' }, body: staleBody
  });
  assert.equal(response.status, 400, 'Direct posts must also pass Cloudflare when the number fallback is disabled');
  assert.equal((await f.post({ 'cf-turnstile-response': 'test-token' })).status, 201);
  assert.equal((await f.save({ postingAuthorization: 'inherit', turnstile: 'inherit', nativeCaptcha: 'inherit' })).status, 303);
  assert.match(await (await f.request('/chiko/')).text(), /native-verification/, 'Image fallback can be restored');
  assert.throws(() => loadConfig({ antiAbuse: { nativeCaptcha: { enabled: 'false' } } }), /nativeCaptcha.enabled/);
});
