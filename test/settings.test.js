'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DEFAULTS } = require('../config');
const { SettingsStore, connectionSettings, encryptionKey, redact } = require('../lib/settings');
const { changeSetting, migrateSettings } = require('../scripts/settings');
const { importLegacy } = require('../scripts/legacy-settings');

async function fixture(t, client) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chiko-settings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const envFile = path.join(directory, '.env');
  const keyFile = path.join(directory, 'key');
  const connection = client ? { storage: 'mongodb', mongoUrl: 'mongodb://localhost/chiko' } : connectionSettings(envFile, {});
  const store = await new SettingsStore(connection, { keyFile, client }).open();
  t.after(() => store.close());
  return { directory, envFile, keyFile, connection, store };
}

test('database env parser rejects application settings and resolves local connections safely', async t => {
  const f = await fixture(t);
  fs.writeFileSync(f.envFile, 'DATABASE_URL=json:./existing\n', { mode: 0o600 });
  assert.equal(connectionSettings(f.envFile, {}).dataDir, path.join(f.directory, 'existing'));
  fs.writeFileSync(f.envFile, 'DATABASE_URL=json:./data\nPORT=9000\n');
  assert.throws(() => connectionSettings(f.envFile, {}), /database connection fields only/);
  assert.throws(() => connectionSettings('/missing', { DATABASE_URL: 'https://secret@host' }), /must use/);
  assert.equal(connectionSettings('/missing', { DATABASE_URL: 'mongodb://localhost/chiko', DB_NAME: 'other' }).mongoDbName, 'other');
});

test('JSON settings seed defaults, encrypt secrets, validate changes and reject stale writes', async t => {
  const f = await fixture(t);
  assert.equal(await f.store.read(), null);
  const password = 'synthetic-private-password';
  await f.store.save({ site: { title: 'Tiny Chiko' }, adminPassword: password, adminSessionSecret: 'x'.repeat(64) });
  const settings = await f.store.read();
  assert.equal(settings.site.title, 'Tiny Chiko');
  assert.equal(settings.features.api, true);
  assert.equal(settings.adminPassword, password);
  assert.ok(!fs.readFileSync(f.store.file, 'utf8').includes(password));
  assert.ok(!fs.readFileSync(f.store.file, 'utf8').includes('Tiny Chiko'));
  assert.equal(fs.statSync(f.keyFile).mode & 0o777, 0o600);
  const second = await new SettingsStore(f.connection, { keyFile: f.keyFile }).open();
  const earlier = await second.read();
  changeSetting(settings, 'site.title', 'Chiko Updated');
  await f.store.save(settings);
  await assert.rejects(second.save(earlier), /changed/);
  assert.equal((await f.store.read()).site.title, 'Chiko Updated');
  await assert.rejects(f.store.save({ limits: { maxFilesPerPost: 99 } }), /hard safety cap/);
  assert.throws(() => changeSetting(settings, '__proto__.polluted', true), /Unknown/);
  assert.throws(() => changeSetting(settings, 'site.missing', true), /Unknown/);
  assert.equal(DEFAULTS.site.title, 'ChikoChan');
});

test('missing keys, wrong keys, tampering, unsafe files and future schemas fail closed', async t => {
  const f = await fixture(t);
  await f.store.save({ site: { title: 'Private Chiko' } });
  const key = fs.readFileSync(f.keyFile);
  fs.unlinkSync(f.keyFile);
  await assert.rejects(f.store.read(), /key unavailable/);
  fs.writeFileSync(f.keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  await assert.rejects(f.store.read(), /Cannot unlock/);
  fs.writeFileSync(f.keyFile, key);
  const record = JSON.parse(fs.readFileSync(f.store.file));
  record.revision++;
  fs.writeFileSync(f.store.file, JSON.stringify(record));
  await assert.rejects(f.store.read(), /Cannot unlock/);
  record.version = 999;
  fs.writeFileSync(f.store.file, JSON.stringify(record));
  await assert.rejects(f.store.read(), /Unsupported settings schema/);
  fs.chmodSync(f.keyFile, 0o644);
  assert.throws(() => encryptionKey(f.keyFile), /key unavailable/);
});

test('redaction includes all configured credentials, including nested settings', () => {
  const values = redact({ adminPassword: 'hidden', site: { title: 'Public' },
    mediaStorage: { object: { accessKeyId: 'hidden', secretAccessKey: 'hidden', sessionToken: 'hidden' } },
    rateLimit: { redisUrl: 'rediss://hidden' }, staffMfa: { encryptionKey: 'hidden' } });
  assert.ok(!JSON.stringify(values).includes('hidden'));
  assert.equal(values.site.title, 'Public');
});

test('legacy import retains all kinds of settings and existing posts, then writes database-only env', async t => {
  const f = await fixture(t);
  const configFile = path.join(f.directory, 'config.json');
  const source = path.join(f.directory, 'posts.json');
  fs.writeFileSync(source, '{"threads":[],"customization":{"title":"Preserved"}}');
  const before = fs.readFileSync(source);
  fs.writeFileSync(configFile, JSON.stringify({ features: { search: false }, fortunes: ['Cute luck'], site: { title: 'File title' } }), { mode: 0o600 });
  fs.writeFileSync(f.envFile, 'STORAGE=json\nDATA_DIR=.\nSITE_NAME="Migrated Chiko"\nADMIN_PASSWORD="synthetic-private-password"\nADMIN_SESSION_SECRET="synthetic-stable-session-secret"\nPOST_RATE_LIMIT=13\n', { mode: 0o600 });
  await migrateSettings({ envFile: f.envFile, configFile, keyFile: f.keyFile, environment: {} });
  assert.equal(fs.readFileSync(f.envFile, 'utf8').includes('ADMIN'), false);
  assert.equal(fs.existsSync(configFile), false);
  assert.deepEqual(fs.readFileSync(source), before);
  const migrated = await new SettingsStore(connectionSettings(f.envFile, {}), { keyFile: f.keyFile }).open();
  const settings = await migrated.read();
  assert.equal(settings.site.title, 'Migrated Chiko');
  assert.equal(settings.features.search, false);
  assert.deepEqual(settings.fortunes, ['Cute luck']);
  assert.equal(settings.adminSessionSecret, 'synthetic-stable-session-secret');
  assert.equal(settings.rateLimit.operations.threadCreate.limit, 13);
});

test('legacy key aliases, typed values, proxy lists, and operation limits are preserved', () => {
  const imported = importLegacy({ MONGODB_URI: 'mongodb://localhost/alias', TRUST_PROXY: 'loopback,10.0.0.0/8',
    TURNSTILE_ENABLED: 'true', ADMIN_LOGIN_RATE_LIMIT: '3', TURNSTILE_ALLOWED_HOSTNAMES: 'a.test,b.test' });
  assert.equal(imported.mongoUrl, 'mongodb://localhost/alias');
  assert.deepEqual(imported.trustProxy, ['loopback', '10.0.0.0/8']);
  assert.equal(imported.antiAbuse.turnstile.enabled, true);
  assert.equal(imported.rateLimit.operations.adminLogin.limit, 3);
  assert.throws(() => importLegacy({ PORT: 'oops' }), /Invalid legacy numeric/);
  assert.throws(() => importLegacy({ TURNSTILE_ENABLED: 'maybe' }), /Invalid legacy boolean/);
});

test('Mongo settings use atomic revision checks and redact driver failures', async t => {
  let record = null;
  const client = {
    async connect() {}, async close() {},
    db: () => ({ collection: name => {
      assert.equal(name, 'settings');
      return {
        async findOne() { return structuredClone(record); },
        async insertOne(value) { if (record) throw new Error('Duplicate'); record = structuredClone(value); },
        async replaceOne(filter, value) {
          if (filter.revision !== record.revision) return { matchedCount: 0 };
          record = structuredClone(value); return { matchedCount: 1 };
        }
      };
    } })
  };
  const f = await fixture(t, client);
  await f.store.read();
  await f.store.save({ site: { title: 'Mongo Chiko' } });
  assert.equal((await f.store.read()).site.title, 'Mongo Chiko');
  const second = await new SettingsStore(f.connection, { keyFile: f.keyFile, client }).open();
  await second.read();
  await f.store.save({ site: { title: 'Updated Mongo Chiko' } });
  await assert.rejects(second.save({ site: { title: 'Stale' } }), /concurrent update/);
  const broken = new SettingsStore(f.connection, { client: { async connect() { throw new Error('secret-uri'); }, async close() {} } });
  await assert.rejects(broken.open(), error => !error.message.includes('secret-uri'));
});

test('migration refuses to overwrite customized settings and leaves legacy files intact on conflict', async t => {
  const f = await fixture(t);
  await f.store.save({ site: { title: 'Already customized' } });
  fs.writeFileSync(f.envFile, 'STORAGE=json\nDATA_DIR=./data\nSITE_NAME=Different\n', { mode: 0o600 });
  const original = fs.readFileSync(f.envFile);
  await assert.rejects(migrateSettings({ envFile: f.envFile, configFile: path.join(f.directory, 'missing'), keyFile: f.keyFile, environment: {} }), /never overwrites/);
  assert.deepEqual(fs.readFileSync(f.envFile), original);
  assert.equal((await f.store.read()).site.title, 'Already customized');
  assert.equal(fs.existsSync(f.envFile + '.install-lock'), false);
});

test('a failed database open releases migration locks and never changes old configuration', async t => {
  const f = await fixture(t);
  fs.writeFileSync(f.envFile, 'STORAGE=mongodb\nMONGO_URL=mongodb://invalid:password@\n', { mode: 0o600 });
  const original = fs.readFileSync(f.envFile);
  await assert.rejects(migrateSettings({ envFile: f.envFile, configFile: path.join(f.directory, 'missing'), keyFile: f.keyFile, environment: {} }), error => !error.message.includes('password'));
  assert.deepEqual(fs.readFileSync(f.envFile), original);
  assert.equal(fs.existsSync(f.envFile + '.install-lock'), false);
});

test('secret prompts disable echo and attach input handling before displaying the prompt', async () => {
  const { EventEmitter } = require('node:events');
  const { prompt } = require('../scripts/settings');
  const input = new EventEmitter();
  let raw = false;
  let transcript = '';
  Object.assign(input, { isTTY: true, setEncoding() {}, resume() {}, pause() {}, setRawMode(value) { raw = value; } });
  const output = { isTTY: true, write(text) {
    transcript += text;
    if (text.startsWith('Secret')) {
      assert.equal(raw, true);
      assert.equal(input.listenerCount('data'), 1);
      input.emit('data', 'synthetic-private-input\r');
    }
  } };
  assert.equal(await prompt('Secret', { input, output }), 'synthetic-private-input');
  assert.equal(raw, false);
  assert.ok(!transcript.includes('synthetic-private-input'));
  assert.equal(input.listenerCount('data'), 0);
  input.isTTY = false;
  assert.throws(() => prompt('Secret', { input, output }), /interactive terminal/);
});
