'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parseEnv } = require('node:util');
const { AdminAuth } = require('../lib/admin-auth');
const { loadStartupConfig } = require('../config');
const { createBootstrap } = require('../lib/bootstrap');
const { configurationWritable, mergeEnvironment, prepareInstallation } = require('../lib/install-state');
const { SettingsStore, connectionSettings } = require('../lib/settings');
const { testMongoConnection, validateAdministrator, validateDatabase, validateSite } = require('../lib/installer');
const PASSWORD = 'strong-admin-password';
const URI = 'mongodb://test:database-password@localhost:27017/chikochan';

async function fixture(t, overrides = {}, bootstrapOptions = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chiko-install-'));
  const options = { envFile: path.join(directory, '.env'), keyFile: path.join(directory, 'key'),
    overrides: { maintenance: { enabled: false }, ...overrides }, ...bootstrapOptions };
  let bootstrap = await createBootstrap(options);
  const server = bootstrap.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await bootstrap.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${url}/install`);
  const html = await response.text();
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(html)[1];
  return { directory, options, bootstrap, url, html,
    get: route => fetch(url + route, { headers: { cookie }, redirect: 'manual' }),
    post: (route, fields = {}, headers = {}) => fetch(`${url}/install/${route}`, {
      method: 'POST', redirect: 'manual', headers: { cookie, origin: url, ...headers },
      body: new URLSearchParams({ csrf, ...fields })
    }),
    async restart() { await bootstrap.close(); bootstrap = await createBootstrap(options); return bootstrap; }
  };
}

async function prepare(f, site = {}) {
  assert.equal((await f.post('welcome')).status, 303);
  assert.equal((await f.post('storage', { storage: 'json', action: 'continue' })).status, 303);
  assert.equal((await f.post('site', { siteName: 'My Chiko', siteDescription: 'A friendly board.', ...site })).status, 303);
  assert.equal((await f.post('administrator', { password: PASSWORD, confirmPassword: PASSWORD })).status, 303);
}

test('bootstrap validates proxy, origin and HSTS settings before exposing setup', () => {
  assert.throws(() => loadStartupConfig({ trustProxy: true, deployment: { environment: 'production' } }), /forbidden in production/);
  assert.throws(() => loadStartupConfig({ trustProxy: 11 }), /hop count/);
  assert.throws(() => loadStartupConfig({ deployment: { publicOrigin: 'https://example.test/path' } }), /deployment.publicOrigin/);
  assert.throws(() => loadStartupConfig({ security: { hsts: { maxAgeSeconds: -1 } } }), /security.hsts/);
  assert.throws(() => loadStartupConfig({ security: { hsts: { preload: true } } }), /HSTS preload/);
});

test('input limits, safe fields, password length and confirmation are enforced', () => {
  assert.deepEqual(validateDatabase({ mongoUrl: 'mongodb://localhost:27017/chikochan', mongoDbName: 'chikochan' }), {
    mongoUrl: 'mongodb://localhost:27017/chikochan', mongoDbName: 'chikochan'
  });
  for (const body of [
    { mongoUrl: 'https://localhost', mongoDbName: 'chikochan' },
    { mongoUrl: URI, mongoDbName: '../bad' },
    { mongoUrl: [URI], mongoDbName: 'chikochan' },
    { mongoUrl: 'mongodb://' + 'a'.repeat(2048), mongoDbName: 'chikochan' }
  ]) assert.throws(() => validateDatabase(body));
  assert.throws(() => validateSite({ siteName: 'a'.repeat(101) }), /siteName/);
  assert.throws(() => validateSite({ siteName: 'test\nADMIN_PASSWORD=bad' }), /siteName/);
  assert.throws(() => validateSite({ siteName: 'test', siteDescription: 'a'.repeat(2001) }), /siteDescription/);
  assert.equal(validateSite({ siteName: 'test', siteDescription: 'first\r\nsecond' }).description, 'first\nsecond');
  assert.throws(() => validateAdministrator({ password: 'short', confirmPassword: 'short' }), /at least 12/);
  assert.throws(() => validateAdministrator({ password: PASSWORD, confirmPassword: 'different-password' }), /do not match/);
  assert.throws(() => validateAdministrator({ password: PASSWORD + '\nSTORAGE=json', confirmPassword: PASSWORD }), /password/);
  assert.equal(validateAdministrator({ password: PASSWORD, confirmPassword: PASSWORD }), PASSWORD);
});

test('MongoDB validation uses the selected database, bounded timeouts, and always closes the client', async () => {
  const calls = [];
  class Client {
    constructor(uri, options) { calls.push({ uri, options }); }
    async connect() { calls.push('connect'); }
    db(name) { calls.push(name); return { async command(value) { calls.push(value); } }; }
    async close() { calls.push('close'); }
  }
  await testMongoConnection({ mongoUrl: URI, mongoDbName: 'chikochan' }, { Client });
  assert.equal(calls[0].uri, URI);
  assert.equal(calls[0].options.serverSelectionTimeoutMS, 5000);
  assert.deepEqual(calls.slice(1), ['connect', 'chikochan', { ping: 1 }, 'close']);
  class FailingClient extends Client { async connect() { throw new Error(URI); } }
  await assert.rejects(testMongoConnection({ mongoUrl: URI, mongoDbName: 'chikochan' }, { Client: FailingClient }), error => {
    assert.doesNotMatch(error.message, /database-password|mongodb:\/\//);
    return true;
  });
  assert.equal(calls.at(-1), 'close');
});

test('real MongoDB driver rejects malformed URLs and unreachable servers without returning credentials', async () => {
  await assert.rejects(testMongoConnection({ mongoUrl: 'mongodb://test:database-password@', mongoDbName: 'chikochan' }), /Could not connect/);
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  await assert.rejects(testMongoConnection({ mongoUrl: `mongodb://test:database-password@127.0.0.1:${port}`, mongoDbName: 'chikochan' }), error => {
    assert.doesNotMatch(error.message, /database-password|127\.0\.0\.1/);
    return true;
  });
});


test('fresh setup stays on loopback and exposes only installer assets and health', async t => {
  const f = await fixture(t);
  assert.equal(f.bootstrap.config.host, '127.0.0.1');
  assert.equal(f.bootstrap.application, undefined);
  assert.match(f.html, /Welcome to ChikoChan/);
  assert.equal((await fetch(f.url + '/healthz')).status, 200);
  assert.equal((await fetch(f.url + '/readyz')).status, 503);
  const response = await fetch(f.url + '/install');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /form-action 'self'/);
});

test('real local install switches live, encrypts secrets, persists only database env fields and survives restart', async t => {
  const f = await fixture(t);
  await prepare(f, { siteDescription: 'Quotes: " \' ` all work here.' });
  assert.equal((await f.post('finish')).status, 303);
  assert.deepEqual(parseEnv(fs.readFileSync(f.options.envFile, 'utf8')), { DATABASE_URL: 'json:./data' });
  assert.equal(new AdminAuth(f.bootstrap.application.locals.chikochan.config).verifyPassword(PASSWORD), true);
  assert.equal((await fetch(f.url + '/boards.json')).status, 200);
  const encrypted = fs.readFileSync(path.join(f.directory, 'data/settings.json'), 'utf8');
  assert.ok(!encrypted.includes(PASSWORD));
  const restarted = await f.restart();
  assert.equal(restarted.application.locals.chikochan.config.site.title, 'My Chiko');
  assert.equal(new AdminAuth(restarted.application.locals.chikochan.config).verifyPassword(PASSWORD), true);
});

test('CSRF, cross-origin, oversized, malformed and out-of-order setup requests fail closed', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('welcome', { csrf: 'wrong' })).status, 403);
  assert.equal((await f.post('welcome', {}, { origin: 'https://elsewhere.test' })).status, 403);
  assert.equal((await f.post('welcome', {}, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await f.post('site', { siteName: 'Early' })).status, 409);
  assert.equal((await f.post('welcome', { text: 'x'.repeat(13000) })).status, 413);
  await prepare(f);
  assert.equal((await f.post('finish')).status, 303);
  assert.equal((await f.post('finish')).status, 303);
});

test('secure setup cookies and HSTS respect a bounded trusted proxy', async t => {
  const f = await fixture(t, { trustProxy: 1, security: { hsts: { enabled: true } } });
  const response = await fetch(f.url + '/install', { headers: { 'x-forwarded-proto': 'https' } });
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict.*Secure/);
  assert.match(response.headers.get('strict-transport-security'), /max-age=15552000/);
});

test('connection failures never reflect driver secrets and remain retryable', async t => {
  const f = await fixture(t);
  await f.post('welcome');
  // An invalid URI is rejected before any driver work.
  const response = await f.post('storage', { storage: 'mongodb', action: 'test', mongoUrl: 'secret-invalid-uri', mongoDbName: 'chiko' });
  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text(), /secret-invalid-uri/);
  assert.equal((await f.post('storage', { storage: 'json', action: 'continue' })).status, 303);
});

test('settings created by another process lock a running installer', async t => {
  const f = await fixture(t);
  const store = await new SettingsStore(connectionSettings(f.options.envFile, {}), { keyFile: f.options.keyFile }).open();
  await store.read();
  await store.save({ adminPassword: PASSWORD, adminSessionSecret: 'x'.repeat(64) });
  await store.close();
  assert.equal((await f.post('welcome')).status, 409);
});

test('database-only environment writes serialize setup and reject external edits and unsafe files', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chiko-env-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, '.env');
  assert.equal(configurationWritable(file), true);
  assert.throws(() => mergeEnvironment('', { adminPassword: PASSWORD }), /database connection/);
  const prepared = prepareInstallation({ DATABASE_URL: URI, DB_NAME: 'chiko' }, file);
  assert.throws(() => prepareInstallation({ DATABASE_URL: URI }, file), /Another installation/);
  prepared.commit(); prepared.release();
  assert.equal(parseEnv(fs.readFileSync(file, 'utf8')).DATABASE_URL, URI);
  const second = prepareInstallation({ DATABASE_URL: URI }, file);
  fs.writeFileSync(file, 'DATABASE_URL=json:./elsewhere\n');
  assert.throws(() => second.commit(), /changed during/);
  second.release();
  fs.unlinkSync(file);
  fs.symlinkSync(path.join(directory, 'target'), file);
  assert.equal(configurationWritable(file), false);
});

test('production proxy and security policy cannot be bypassed during activation', async t => {
  const f = await fixture(t, { deployment: { environment: 'production' } });
  await f.post('welcome');
  assert.equal((await f.post('storage', { storage: 'json', action: 'continue' })).status, 400);
  assert.equal(fs.existsSync(f.options.envFile), false);
});

test('concurrent finish requests create only one installation', async t => {
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const initializing = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, {}, { createApplication(settings) {
    const app = require('../app').createApp(settings);
    app.locals.chikochan.store.ready = gate;
    entered();
    return app;
  } });
  await prepare(f);
  const first = f.post('finish');
  await initializing;
  try { assert.equal((await f.post('finish')).status, 503); }
  finally { release(); }
  assert.equal((await first).status, 303);
  const store = await new SettingsStore(connectionSettings(f.options.envFile, {}), { keyFile: f.options.keyFile }).open();
  assert.equal((await store.read()).site.title, 'My Chiko');
  assert.equal(store.revision, 1);
});

test('site text is escaped in setup previews and secret validation never reflects inputs', async t => {
  const f = await fixture(t);
  await f.post('welcome');
  await f.post('storage', { storage: 'json', action: 'continue' });
  await f.post('site', { siteName: '<img src=x onerror=alert(1)>', siteDescription: 'All quotes: " \' `' });
  const invalid = await f.post('administrator', { password: 'private-short', confirmPassword: 'different' });
  assert.equal(invalid.status, 400);
  assert.ok(!(await invalid.text()).includes('private-short'));
  await f.post('administrator', { password: PASSWORD, confirmPassword: PASSWORD });
  const preview = await (await f.get('/install')).text();
  assert.ok(!preview.includes('<img src=x'));
  assert.match(preview, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('failed application initialization leaves setup available and can be retried without leaking errors', async t => {
  let fail = true;
  const f = await fixture(t, {}, { createApplication(settings) {
    if (fail) throw new Error('synthetic-private-driver-password');
    return require('../app').createApp(settings);
  } });
  await prepare(f);
  const response = await f.post('finish');
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('synthetic-private-driver-password'));
  assert.equal(fs.existsSync(f.options.envFile), false);
  assert.equal(fs.existsSync(f.options.envFile + '.install-lock'), false);
  fail = false;
  assert.equal((await f.post('finish')).status, 303);
});
