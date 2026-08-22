'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadConfig } = require('../config');

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('STORAGE supports environment configuration and explicit app overrides remain isolated', t => {
  const previousStorage = process.env.STORAGE;
  const previousDataDir = process.env.DATA_DIR;
  t.after(() => {
    restoreEnvironment('STORAGE', previousStorage);
    restoreEnvironment('DATA_DIR', previousDataDir);
  });

  process.env.STORAGE = 'json';
  process.env.DATA_DIR = '/environment-data';
  const environmentConfig = loadConfig();
  assert.equal(environmentConfig.storage, 'json');
  assert.equal(environmentConfig.dataDir, '/environment-data');

  const isolatedDirectory = path.join(os.tmpdir(), 'chikochan-config-override');
  const overrideConfig = loadConfig({ storage: 'mongodb', dataDir: isolatedDirectory });
  assert.equal(overrideConfig.storage, 'mongodb');
  assert.equal(overrideConfig.dataDir, isolatedDirectory);
});
