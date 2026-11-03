'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// Install mongodb-memory-server separately; pass its module path and optional mongod binary.
const root = path.join(__dirname, '..');
const { MongoMemoryServer } = require(process.argv[2] || 'mongodb-memory-server');
const { SettingsStore, connectionSettings } = require(root + '/lib/settings');
const { createBootstrap } = require(root + '/lib/bootstrap');
const { migrateSettings } = require(root + '/scripts/settings');
(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chiko-real-mongo-'));
  let mongo, bootstrap, server, store;
  try {
    mongo = await MongoMemoryServer.create({ binary: process.argv[3] ? { systemBinary: path.resolve(process.argv[3]) } : {} });
    const envFile = path.join(directory, '.env');
    const keyFile = path.join(directory, 'key');
    const uri = mongo.getUri('chiko');
    fs.writeFileSync(envFile, 'DATABASE_URL=' + uri + '\nDB_NAME=chiko\n', { mode: 0o600 });
    const connection = connectionSettings(envFile, {});
    store = await new SettingsStore(connection, { keyFile }).open();
    assert.equal(await store.read(), null);
    await store.save({ adminPassword: 'synthetic-private-password', adminSessionSecret: 'x'.repeat(64), dataDir: directory, site: { title: 'Real Mongo Chiko' }, maintenance: { enabled: false } });
    const record = await store.collection.findOne({ _id: 'application' });
    assert.ok(!JSON.stringify(record).includes('synthetic-private-password'));
    const settings = await store.read();
    const stale = await new SettingsStore(connection, { keyFile }).open();
    await stale.read();
    settings.site.title = 'Updated Mongo Chiko';
    await store.save(settings);
    await assert.rejects(stale.save(settings), /concurrent update/);
    await stale.close();
    bootstrap = await createBootstrap({ envFile, keyFile });
    server = bootstrap.app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    assert.match(await (await fetch(base)).text(), /Updated Mongo Chiko/);
    assert.equal((await fetch(base + '/readyz')).status, 200);
    assert.equal((await fetch(base + '/boards.json')).status, 200);
    const first = await fetch(base + '/preferences');
    const cookie = first.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(base + '/preferences', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ 'chikochan-theme': 'dark' }) })).status, 204);
    assert.equal((await (await fetch(base + '/preferences', { headers: { cookie } })).json()).values['chikochan-theme'], 'dark');
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null;
    await bootstrap.close(); bootstrap = await createBootstrap({ envFile, keyFile });
    assert.equal(bootstrap.application.locals.chikochan.config.site.title, 'Updated Mongo Chiko');
    // Import a second legacy database without touching the first installation.
    const legacyFile = path.join(directory, 'legacy.env');
    fs.writeFileSync(legacyFile, 'STORAGE=mongodb\nMONGO_URL=' + mongo.getUri('legacy') + '\nDATA_DIR=' + directory + '\nSITE_NAME=LegacyMongo\nADMIN_PASSWORD=synthetic-migration-password\nADMIN_SESSION_SECRET=synthetic-stable-session-secret\n', { mode: 0o600 });
    await migrateSettings({ envFile: legacyFile, configFile: path.join(directory, 'missing.json'), keyFile, environment: {} });
    assert.ok(!fs.readFileSync(legacyFile, 'utf8').includes('ADMIN_PASSWORD'));
    console.log('PASS real MongoDB: encrypted settings, defaults, CAS, startup, readiness, boards, preferences, restart, legacy migration');
  } finally {
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    await bootstrap?.close(); await store?.close(); await mongo?.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
