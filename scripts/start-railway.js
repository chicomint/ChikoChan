'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { KEY_FILE, SettingsStore, connectionSettings, readPrivate } = require('../lib/settings');

// The volume keeps the authoritative key across deployments. Settings reads
// reject symlinks, so the application receives a private regular-file copy.
function prepareKey(persistentKey = '/data/private/.chiko-key', applicationKey = KEY_FILE) {
  const key = readPrivate(persistentKey, 100).trim();
  if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('Invalid persistent settings key.');
  if (fs.existsSync(applicationKey)) {
    if (readPrivate(applicationKey, 100).trim() !== key) {
      throw new Error('Application key differs from the persistent settings key.');
    }
    return;
  }
  fs.writeFileSync(applicationKey, key + '\n', { mode: 0o600, flag: 'wx' });
}

async function prepareSettings() {
  const connection = connectionSettings();
  if (connection.storage !== 'mongodb' || !connection.mongoDbName) {
    throw new Error('Railway requires a MongoDB connection and explicit DB_NAME.');
  }
  const seedDirectory = '/data/private';
  const seedFile = path.join(seedDirectory, 'settings.json');
  const store = await new SettingsStore(connection).open();
  try {
    if (!await store.read()) {
      const seed = await new SettingsStore({ storage: 'json', dataDir: seedDirectory }).open();
      try {
        const settings = await seed.read();
        if (!settings) throw new Error('Encrypted bootstrap settings are missing.');
        await store.save(settings);
        await store.read();
      } finally { await seed.close(); }
    }
    // The database is authoritative after the one-time encrypted import.
    fs.rmSync(seedFile, { force: true });
  } finally { await store.close(); }
}

if (require.main === module) {
  (async () => {
    process.umask(0o077);
    prepareKey();
    await prepareSettings();
    require('../server');
  })().catch(() => {
    console.error('Railway startup failed. Check DATABASE_URL, DB_NAME, the persistent volume, and the private key/bootstrap settings described in RAILWAY_DEPLOYMENT.md.');
    process.exitCode = 1;
  });
}

module.exports = { prepareKey, prepareSettings };
