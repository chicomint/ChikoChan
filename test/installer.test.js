'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parseEnv } = require('node:util');
const { createApp } = require('../app');
const { loadConfig, loadStartupConfig } = require('../config');
const { createBootstrap } = require('../lib/bootstrap');
const {
  configurationWritable, installationRequired, mergeEnvironment, prepareInstallation
} = require('../lib/install-state');
const { testMongoConnection, validateAdministrator, validateDatabase, validateSite } = require('../lib/installer');
const { AdminAuth } = require('../lib/admin-auth');
const { MongoStore } = require('../lib/mongo-store');

const ENV_KEYS = ['STORAGE', 'MONGO_URL', 'MONGODB_URI', 'MONGO_DB_NAME', 'ADMIN_PASSWORD',
  'ADMIN_SESSION_SECRET', 'CHIKO_INSTALLED', 'SITE_NAME', 'SITE_DESCRIPTION', 'INSTALLER_DISABLED', 'CHIKO_CONFIG', 'NODE_ENV', 'UNRELATED', 'PORT', 'DATA_DIR'];
const PASSWORD = 'strong-admin-password';
const URI = 'mongodb://test:database-password@localhost:27017/chikochan';

function matches(document, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === 'object') {
      if ('$ne' in value) return document[key] !== value.$ne;
      if ('$nin' in value) return !value.$nin.includes(document[key]);
      if ('$in' in value) return value.$in.includes(document[key]);
    }
    return document[key] === value;
  });
}

// Exercise MongoStore's real index creation, persistence, default-board logic,
// and the real application against a small in-memory Mongo transport.
function mongoTransport() {
  const collections = new Map();
  const indexes = [];
  function collection(name) {
    if (!collections.has(name)) collections.set(name, []);
    const documents = () => collections.get(name);
    const cursor = values => ({
      sort() { return this; }, limit() { return this; }, skip() { return this; },
      async toArray() { return structuredClone(values); }
    });
    return {
      async createIndex(keys, options) { indexes.push({ name, keys, options }); },
      async findOne(filter) { return structuredClone(documents().find(value => matches(value, filter)) || null); },
      find(filter) { return cursor(documents().filter(value => matches(value, filter))); },
      aggregate() { return cursor([]); },
      async countDocuments(filter) { return documents().filter(value => matches(value, filter)).length; },
      async deleteMany(filter) { collections.set(name, documents().filter(value => !matches(value, filter))); },
      async bulkWrite(operations) {
        for (const { replaceOne } of operations) {
          const index = documents().findIndex(value => matches(value, replaceOne.filter));
          const value = structuredClone(replaceOne.replacement);
          if (index < 0) documents().push(value);
          else documents()[index] = value;
        }
      }
    };
  }
  return { collections, indexes, db: () => ({ collection, admin: () => ({ command: async () => ({ ok: 1 }) }) }) };
}

async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chikochan-install-'));
  const envFile = path.join(directory, '.env');
  const previous = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  ENV_KEYS.forEach(key => { delete process.env[key]; });
  process.env.NODE_ENV = 'test';
  process.env.CHIKO_CONFIG = path.join(directory, 'config.json');
  if (options.environment) Object.assign(process.env, options.environment);
  if (options.envContent !== undefined) fs.writeFileSync(envFile, options.envContent);
  let server;
  let bootstrap;
  t.after(async () => {
    if (server) {
      server.closeIdleConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await bootstrap?.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const transport = mongoTransport();
  const applications = [];
  const factory = settings => {
    const appSettings = { ...settings, dataDir: path.join(directory, 'data') };
    const runtime = loadConfig(appSettings);
    const store = runtime.storage === 'json' ? undefined : new MongoStore(runtime, { client: transport });
    const application = createApp({ ...appSettings, ...(store ? { store } : {}) });
    applications.push(application);
    return application;
  };
  bootstrap = await createBootstrap({
    envFile: options.envFile || envFile,
    overrides: { dataDir: path.join(directory, 'data'), maintenance: { enabled: false }, ...options.overrides },
    testConnection: options.testConnection || (async () => {}),
    createApplication: options.realFactory ? undefined : options.createApplication || factory
  });
  server = await new Promise((resolve, reject) => {
    const listener = bootstrap.app.listen(0, '127.0.0.1', error => error ? reject(error) : resolve(listener));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const browser = () => installationBrowser(url);
  return { directory, envFile, bootstrap, browser, url, applications, transport, factory };
}

async function installationBrowser(url) {
  const response = await fetch(`${url}/install`, { redirect: 'manual' });
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  const initialHTML = await response.text();
  const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(initialHTML)?.[1];
  return {
    initialHTML, cookie, csrf,
    get: route => fetch(`${url}${route}`, { headers: { cookie }, redirect: 'manual' }),
    post: (route, fields = {}, headers = {}) => fetch(`${url}/install/${route}`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, origin: url, ...headers },
      body: new URLSearchParams({ csrf, ...fields })
    })
  };
}

async function prepareBrowser(browser, site = {}) {
  assert.equal((await browser.post('welcome')).status, 303);
  assert.equal((await browser.post('storage', { storage: 'mongodb', mongoUrl: URI, mongoDbName: 'chikochan', action: 'continue' })).status, 303);
  assert.equal((await browser.post('site', { siteName: 'My Chiko', siteDescription: 'A friendly board.', ...site })).status, 303);
  assert.equal((await browser.post('administrator', { password: PASSWORD, confirmPassword: PASSWORD })).status, 303);
}

test('fresh MongoDB setup is detected without requiring administrator settings on existing installs', () => {
  assert.equal(installationRequired({ storage: 'mongodb', mongoUrl: '' }, {}), true);
  assert.equal(installationRequired({ storage: 'mongodb', mongoUrl: URI }, {}), false);
  assert.equal(installationRequired({ storage: 'json', mongoUrl: '' }, {}), false);
  for (const environment of [{ CHIKO_INSTALLED: 'true' }, { MONGO_URL: URI }, { MONGODB_URI: URI }, { STORAGE: 'json' }]) {
    assert.equal(installationRequired({ storage: 'mongodb', mongoUrl: '' }, environment), false);
  }
});

test('bootstrap validates proxy, origin and HSTS settings before exposing setup', () => {
  assert.throws(() => loadStartupConfig({ trustProxy: true, deployment: { environment: 'production' } }), /forbidden in production/);
  assert.throws(() => loadStartupConfig({ trustProxy: 11 }), /hop count/);
  assert.throws(() => loadStartupConfig({ deployment: { publicOrigin: 'https://example.test/path' } }), /PUBLIC_ORIGIN/);
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

test('fresh bootstrap serves welcome before constructing an application and reports not-ready', async t => {
  const f = await fixture(t);
  assert.equal(f.bootstrap.application, undefined);
  assert.equal(f.applications.length, 0);
  const response = await fetch(f.url, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/install');
  const browser = await f.browser();
  assert.match(browser.initialHTML, /Welcome to ChikoChan/);
  assert.match(browser.initialHTML, /Writable configuration: ready/);
  assert.match(browser.initialHTML, /MongoDB support: ready/);
  assert.equal((await fetch(`${f.url}/healthz`)).status, 200);
  assert.equal((await fetch(`${f.url}/readyz`)).status, 503);
  const page = await browser.get('/install');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.match(page.headers.get('content-security-policy'), /form-action 'self'/);
  assert.equal(page.headers.get('x-powered-by'), null);
});

test('installer retains HSTS and secure cookies behind a bounded trusted proxy', async t => {
  const f = await fixture(t, { overrides: { trustProxy: 1, security: { hsts: { enabled: true } } } });
  const response = await fetch(`${f.url}/install`, { headers: { 'x-forwarded-proto': 'https' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('strict-transport-security'), 'max-age=15552000; includeSubDomains');
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.match(response.headers.get('set-cookie'), /; Secure/);
});

test('installation initializes MongoStore, saves only environment secrets, switches live, and stays locked on restart', async t => {
  const checks = [];
  const f = await fixture(t, { envContent: 'PORT=3000\nUNRELATED=`a"quoted\'value`\n', testConnection: async database => checks.push(database) });
  const browser = await f.browser();
  await browser.post('welcome');
  const tested = await browser.post('storage', { storage: 'mongodb', mongoUrl: URI, mongoDbName: 'chikochan', action: 'test' });
  const testedHTML = await tested.text();
  assert.equal(tested.status, 200);
  assert.match(testedHTML, /connection successful/);
  assert.doesNotMatch(testedHTML, /database-password|mongodb:\/\/test/);
  await browser.post('storage', { storage: 'mongodb', mongoUrl: '', mongoDbName: 'chikochan', action: 'continue' });
  await browser.post('site', { siteName: 'My Chiko', siteDescription: 'First line\nSecond line' });
  await browser.post('administrator', { password: PASSWORD, confirmPassword: PASSWORD });
  const finishHTML = await (await browser.get('/install')).text();
  assert.doesNotMatch(finishHTML, new RegExp(`${PASSWORD}|database-password`));
  const response = await browser.post('finish');
  assert.equal(response.status, 303, await response.text());
  assert.equal(response.headers.get('location'), '/');
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(checks.length, 3);
  const env = parseEnv(fs.readFileSync(f.envFile, 'utf8'));
  assert.equal(env.STORAGE, 'mongodb');
  assert.equal(env.MONGO_URL, URI);
  assert.equal(env.MONGO_DB_NAME, 'chikochan');
  assert.equal(env.ADMIN_PASSWORD, PASSWORD);
  assert.match(env.ADMIN_SESSION_SECRET, /^[a-f0-9]{64}$/);
  assert.notEqual(env.ADMIN_SESSION_SECRET, browser.csrf);
  assert.equal(env.CHIKO_INSTALLED, 'true');
  assert.equal(env.UNRELATED, 'a"quoted\'value');
  assert.equal(env.SITE_DESCRIPTION, 'First line\nSecond line');
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.envFile).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${f.envFile}.install-lock`), false);
  assert.ok(f.bootstrap.application.locals.chikochan.store instanceof MongoStore);
  assert.ok(f.transport.indexes.some(value => value.name === 'boards'));
  const stored = JSON.stringify([...f.transport.collections.values()]);
  assert.doesNotMatch(stored, new RegExp(`${PASSWORD}|database-password|${env.ADMIN_SESSION_SECRET}`));
  const boards = await (await fetch(`${f.url}/boards.json`)).json();
  assert.equal(boards.boards[0].board, 'chiko');
  const home = await fetch(f.url);
  assert.equal(home.status, 200, await home.clone().text());
  const homeHTML = await home.text();
  assert.match(homeHTML, /My Chiko/);
  assert.doesNotMatch(homeHTML, new RegExp(`${PASSWORD}|database-password|${env.ADMIN_SESSION_SECRET}`));
  assert.equal(new AdminAuth(f.bootstrap.application.locals.chikochan.config).verifyPassword(PASSWORD), true);
  for (const route of ['/', '/finish', '/storage']) {
    const locked = route === '/' ? await browser.get('/install') : await browser.post(route.slice(1));
    assert.equal(locked.status, 303);
    assert.equal(locked.headers.get('location'), '/');
  }
  assert.deepEqual(parseEnv(fs.readFileSync(f.envFile, 'utf8')), env);
  // Simulate a new process loading the saved file using the project's Node API.
  ENV_KEYS.filter(key => !['NODE_ENV', 'CHIKO_CONFIG'].includes(key)).forEach(key => { delete process.env[key]; });
  process.loadEnvFile(f.envFile);
  const restarted = await createBootstrap({
    overrides: { dataDir: path.join(f.directory, 'restart'), maintenance: { enabled: false } },
    envFile: f.envFile, createApplication: f.factory
  });
  assert.ok(restarted.application);
  assert.equal(restarted.application.locals.chikochan.config.site.title, 'My Chiko');
  await restarted.close();
});

test('existing Mongo URL or deployment alias skips setup even when admin is disabled', async t => {
  for (const key of ['MONGO_URL', 'MONGODB_URI']) {
    await t.test(key, async t => {
      const f = await fixture(t, { environment: { [key]: URI } });
      assert.ok(f.bootstrap.application);
      assert.equal(f.bootstrap.application.locals.chikochan.config.adminPassword, '');
      assert.equal((await fetch(`${f.url}/boards.json`)).status, 200);
      const locked = await fetch(`${f.url}/install`, { redirect: 'manual' });
      assert.equal(locked.status, 303);
      assert.equal(locked.headers.get('location'), '/');
      assert.equal(fs.existsSync(f.envFile), false);
    });
  }
});

test('JSON/local mode uses its real storage and does not open setup', async t => {
  const f = await fixture(t, { realFactory: true, environment: { STORAGE: 'json', MONGO_URL: URI } });
  assert.equal(f.bootstrap.application.locals.chikochan.config.storage, 'json');
  assert.ok(fs.existsSync(path.join(f.directory, 'data', 'posts.json')));
  assert.equal((await fetch(f.url)).status, 200);
  const install = await fetch(`${f.url}/install`, { redirect: 'manual' });
  assert.equal(install.status, 303);
  assert.equal(fs.existsSync(f.envFile), false);
});

test('CSRF, cross-origin, malformed, oversized and out-of-order requests cannot configure the app', async t => {
  const f = await fixture(t);
  const browser = await f.browser();
  assert.equal((await browser.post('welcome', { csrf: 'invalid' })).status, 403);
  assert.equal((await browser.post('welcome', {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await browser.post('welcome', {}, { 'sec-fetch-site': 'same-site' })).status, 403);
  assert.equal((await browser.post('finish')).status, 409);
  assert.equal((await browser.post('welcome', { extra: 'x'.repeat(14000) })).status, 413);
  await browser.post('welcome');
  const invalid = await browser.post('storage', { storage: 'mongodb', mongoUrl: 'https://secret-password@example.test', mongoDbName: 'chikochan', action: 'test' });
  assert.equal(invalid.status, 400);
  assert.doesNotMatch(await invalid.text(), /secret-password/);
  assert.equal(fs.existsSync(f.envFile), false);
});

test('site HTML is escaped and passwords are never reflected after validation failures', async t => {
  const f = await fixture(t);
  const browser = await f.browser();
  await prepareBrowser(browser, { siteName: '<img src=x onerror=alert(1)>', siteDescription: '<script>alert(1)</script>' });
  const html = await (await browser.get('/install')).text();
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img src=x|<script>alert/);
  await browser.post('back');
  const response = await browser.post('administrator', { password: PASSWORD, confirmPassword: 'mismatch-password' });
  assert.equal(response.status, 400);
  const errorHTML = await response.text();
  assert.match(errorHTML, /do not match/);
  assert.doesNotMatch(errorHTML, /strong-admin-password|mismatch-password|database-password/);
});

test('failed Mongo initialization does not commit configuration or secrets, and can be retried', async t => {
  let fail = true;
  let factory;
  const f = await fixture(t, { createApplication: settings => {
    if (fail) throw new Error(`${URI} ${settings.adminPassword} ${settings.adminSessionSecret}`);
    return factory(settings);
  } });
  factory = f.factory;
  const browser = await f.browser();
  await prepareBrowser(browser);
  const response = await browser.post('finish');
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /database-password|strong-admin-password|Error:|at create/);
  assert.equal(fs.existsSync(f.envFile), false);
  assert.equal(fs.existsSync(`${f.envFile}.install-lock`), false);
  assert.equal(process.env.ADMIN_PASSWORD, undefined);
  fail = false;
  assert.equal((await browser.post('finish')).status, 303);
});

test('connection exceptions cannot leak credentials even if an adapter attaches HTTP status', async t => {
  const f = await fixture(t, { testConnection: async () => { throw Object.assign(new Error(URI), { status: 400 }); } });
  const browser = await f.browser();
  await browser.post('welcome');
  const response = await browser.post('storage', { storage: 'mongodb', mongoUrl: URI, mongoDbName: 'chikochan', action: 'test' });
  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text(), /database-password|mongodb:\/\/test/);
});

test('environment writer round-trips special values, preserves other settings and serializes competing installers', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chikochan-env-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, '.env');
  fs.writeFileSync(file, 'UNRELATED="keep me"\n');
  const values = { PASSWORD: 'a"quote\'and`backtick', DESCRIPTION: 'first\nsecond', SECRET: 'contains\\nliteral' };
  assert.deepEqual(parseEnv(mergeEnvironment('UNRELATED="keep me"\n', values)), { UNRELATED: 'keep me', ...values });
  const prepared = prepareInstallation({ MONGO_URL: URI }, file);
  assert.throws(() => prepareInstallation({ MONGO_URL: 'mongodb://attacker' }, file));
  assert.equal(parseEnv(fs.readFileSync(file, 'utf8')).MONGO_URL, undefined);
  prepared.commit();
  prepared.release();
  assert.throws(() => prepareInstallation({ MONGO_URL: 'mongodb://attacker' }, file));
  assert.equal(parseEnv(fs.readFileSync(file, 'utf8')).MONGO_URL, URI);
  assert.equal(parseEnv(fs.readFileSync(file, 'utf8')).UNRELATED, 'keep me');
});

test('environment writer rejects unsafe files and changes made during initialization', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chikochan-env-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, '.env');
  fs.writeFileSync(file, 'UNRELATED="original"\n');
  const prepared = prepareInstallation({ MONGO_URL: URI }, file);
  fs.writeFileSync(file, 'UNRELATED="changed"\n');
  assert.throws(() => prepared.commit(), /changed during installation/);
  prepared.release();
  assert.equal(fs.readFileSync(file, 'utf8'), 'UNRELATED="changed"\n');
  if (process.platform !== 'win32') {
    const link = path.join(directory, 'linked-env');
    fs.symlinkSync(file, link);
    assert.equal(configurationWritable(link), false);
    assert.throws(() => prepareInstallation({ MONGO_URL: URI }, link));
  }
});

test('read-only/missing config directories and disabled ephemeral installers explain platform variables', async t => {
  await t.test('unwritable destination', async t => {
    const f = await fixture(t, { envFile: path.join(os.tmpdir(), `missing-chiko-${Date.now()}`, '.env') });
    const browser = await f.browser();
    assert.match(browser.initialHTML, /Writable configuration: unavailable/);
    assert.match(browser.initialHTML, /ADMIN_SESSION_SECRET/);
    assert.match(browser.initialHTML, /ephemeral/);
    assert.doesNotMatch(browser.initialHTML, /action="\/install\/welcome"/);
    assert.equal((await browser.post('welcome')).status, 503);
  });
  await t.test('hosting opt-out', async t => {
    const f = await fixture(t, { environment: { INSTALLER_DISABLED: 'true' } });
    const browser = await f.browser();
    assert.match(browser.initialHTML, /hosting platform/);
    assert.doesNotMatch(browser.initialHTML, /action="\/install\/welcome"/);
  });
});

test('externally configured and unsafe environment files lock an already-running installer', async t => {
  const f = await fixture(t);
  const browser = await f.browser();
  fs.writeFileSync(f.envFile, `MONGO_URL="${URI}"\n`);
  const response = await browser.post('welcome');
  assert.equal(response.status, 409);
  assert.doesNotMatch(await response.text(), /database-password/);
});

test('production activation retains existing security policy and leaves setup uncommitted', async t => {
  const f = await fixture(t, { realFactory: true, overrides: { deployment: { environment: 'production' } } });
  const browser = await f.browser();
  await prepareBrowser(browser);
  const response = await browser.post('finish');
  assert.equal(response.status, 503);
  assert.match(await response.text(), /Production also requires/);
  assert.equal(fs.existsSync(f.envFile), false);
  assert.equal(f.bootstrap.application, undefined);
});

test('concurrent finish requests cannot replace the first installation', async t => {
  let release;
  let notify;
  const entered = new Promise(resolve => { notify = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  let checks = 0;
  const f = await fixture(t, { testConnection: async () => {
    if (++checks === 2) { notify(); await pending; }
  } });
  const browser = await f.browser();
  await prepareBrowser(browser);
  const finishing = browser.post('finish');
  await entered;
  const competing = await browser.post('finish');
  assert.equal(competing.status, 503);
  assert.equal((await fetch(`${f.url}/healthz`)).status, 200);
  release();
  assert.equal((await finishing).status, 303);
  assert.equal(f.applications.length, 1);
});

test('npm start and start:local entry points boot and shut down in disposable checkouts', async t => {
  for (const local of [false, true]) {
    await t.test(local ? 'local command overrides MongoDB env' : 'normal command exposes fresh installer', async t => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chikochan-start-'));
      const root = path.join(__dirname, '..');
      for (const name of ['package.json', 'server.js', 'app.js', 'config.js', 'lib', 'locales', 'scripts', 'style.css', 'chikki.ico']) {
        fs.cpSync(path.join(root, name), path.join(directory, name), { recursive: true });
      }
      fs.symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      if (local) fs.writeFileSync(path.join(directory, '.env'), `STORAGE=mongodb\nMONGO_URL="${URI}"\n`);
      const env = { ...process.env, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test', MAINTENANCE_ENABLED: 'false' };
      ENV_KEYS.filter(key => !['NODE_ENV', 'PORT'].includes(key)).forEach(key => { delete env[key]; });
      const child = spawn('npm', ['run', local ? 'start:local' : 'start'], {
        cwd: directory, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
      });
      let output = '';
      const exited = new Promise(resolve => child.once('exit', resolve));
      t.after(async () => {
        if (process.platform === 'win32') child.kill('SIGTERM');
        else {
          try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        await exited;
        fs.rmSync(directory, { recursive: true, force: true });
      });
      const url = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Startup timed out')), 10000);
        timer.unref();
        const read = chunk => {
          output += chunk.toString();
          const match = /ChikoChan is running at (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
          if (match) { clearTimeout(timer); resolve(match[1]); }
        };
        child.stdout.on('data', read);
        child.stderr.on('data', read);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited before startup')); });
      });
      const response = await fetch(url, { redirect: 'manual' });
      assert.equal(response.status, local ? 200 : 302);
      if (local) {
        assert.ok(fs.existsSync(path.join(directory, 'data', 'posts.json')));
        assert.equal((await fetch(`${url}/install`, { redirect: 'manual' })).status, 303);
      } else {
        assert.equal(response.headers.get('location'), '/install');
        const browser = await installationBrowser(url);
        assert.equal((await browser.post('welcome')).status, 303);
        const storageHTML = await (await browser.get('/install')).text();
        assert.match(storageHTML, /2\. Storage/);
        assert.match(storageHTML, /name="storage" value="json" checked/);
        assert.match(storageHTML, /id="installer-mongo" class="installer-mongo" hidden disabled/);
        assert.equal((await browser.post('storage', { storage: 'json', action: 'continue' })).status, 303);
        assert.equal((await browser.post('site', { siteName: 'Simple Chiko', siteDescription: 'No MongoDB required.' })).status, 303);
        assert.equal((await browser.post('administrator', { password: PASSWORD, confirmPassword: PASSWORD })).status, 303);
        assert.equal((await browser.post('finish')).status, 303);
        const saved = parseEnv(fs.readFileSync(path.join(directory, '.env'), 'utf8'));
        assert.equal(saved.STORAGE, 'json');
        assert.equal(saved.DATA_DIR, './data');
        assert.equal(saved.MONGO_URL, undefined);
        assert.equal(saved.CHIKO_INSTALLED, 'true');
        assert.match(saved.ADMIN_SESSION_SECRET, /^[a-f0-9]{64}$/);
        assert.ok(fs.existsSync(path.join(directory, 'data', 'posts.json')));
        const home = await fetch(url);
        assert.equal(home.status, 200);
        assert.match(await home.text(), /Simple Chiko/);
        assert.equal((await browser.get('/install')).status, 303);
      }
      assert.doesNotMatch(output, /database-password/);
    });
  }
});

test('local setup never tests MongoDB and discards a previously tested connection', async t => {
  let checks = 0;
  const f = await fixture(t, { testConnection: async () => { checks++; } });
  const browser = await f.browser();
  await browser.post('welcome');
  await browser.post('storage', { storage: 'mongodb', mongoUrl: URI, mongoDbName: 'chikochan', action: 'test' });
  assert.equal(checks, 1);
  await browser.post('storage', { storage: 'json', action: 'continue' });
  await browser.post('site', { siteName: 'Local Chiko' });
  await browser.post('administrator', { password: PASSWORD, confirmPassword: PASSWORD });
  const finishHTML = await (await browser.get('/install')).text();
  assert.match(finishHTML, /Local storage will save data/);
  assert.equal((await browser.post('finish')).status, 303);
  assert.equal(checks, 1);
  const saved = parseEnv(fs.readFileSync(f.envFile, 'utf8'));
  assert.equal(saved.STORAGE, 'json');
  assert.equal(saved.DATA_DIR, './data');
  assert.equal(saved.MONGO_URL, undefined);
  assert.equal(saved.MONGO_DB_NAME, undefined);
  assert.equal(f.bootstrap.application.locals.chikochan.config.storage, 'json');
  ENV_KEYS.filter(key => !['NODE_ENV', 'CHIKO_CONFIG'].includes(key)).forEach(key => { delete process.env[key]; });
  process.loadEnvFile(f.envFile);
  const restarted = await createBootstrap({ envFile: f.envFile, createApplication: f.factory });
  assert.equal(restarted.application.locals.chikochan.config.storage, 'json');
  await restarted.close();
});

test('storage choices reject unsupported backends and production JSON without requiring Mongo fields', async t => {
  const f = await fixture(t, { overrides: { deployment: { environment: 'production' } } });
  const welcome = await fetch(`${f.url}/install`);
  assert.match(welcome.headers.get('set-cookie'), /; Secure/);
  const browser = await f.browser();
  await browser.post('welcome');
  const html = await (await browser.get('/install')).text();
  assert.match(html, /name="storage" value="json" disabled/);
  assert.match(html, /name="storage" value="mongodb" checked/);
  assert.equal((await browser.post('storage', { storage: 'sqlite', action: 'continue' })).status, 400);
  const response = await browser.post('storage', { storage: 'json', action: 'continue' });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Production requires MongoDB/);
  assert.equal(fs.existsSync(f.envFile), false);
});

test('Mongo selection progressively reveals fields without JavaScript', async t => {
  const f = await fixture(t);
  const browser = await f.browser();
  await browser.post('welcome');
  const response = await browser.post('storage', { storage: 'mongodb', action: 'continue' });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /name="storage" value="mongodb" checked/);
  assert.doesNotMatch(html, /class="installer-mongo" hidden/);
  assert.match(html, /Enter your MongoDB connection details/);
});
