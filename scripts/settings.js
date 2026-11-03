'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv, isDeepStrictEqual } = require('node:util');
const { ENV_FILE, DEFAULTS, loadConfig, mergeConfig } = require('../config');
const { SettingsStore, connectionSettings, readPrivate, redact, storedSettings } = require('../lib/settings');
const { prepareInstallation } = require('../lib/install-state');
const { importLegacy } = require('./legacy-settings');

// No input is echoed, including non-secret settings: a pasted token stays private.
function prompt(label, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY) throw new Error('Use an interactive terminal for setup and settings changes.');
  return new Promise((resolve, reject) => {
    let answer = '';
    function finish(error) {
      input.off('data', receive);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
      if (error) reject(error); else resolve(answer);
    }
    function receive(chunk) {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003' || char === '\u0004') return finish(new Error('Cancelled.'));
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u007f' || char === '\b') answer = answer.slice(0, -1);
        else if (char >= ' ') answer += char;
      }
    }
    input.setEncoding('utf8');
    input.on('data', receive);
    input.setRawMode(true);
    input.resume();
    output.write(label + ': ');
  });
}

function changeSetting(settings, key, value) {
  const parts = String(key || '').split('.');
  let target = settings;
  for (const part of parts.slice(0, -1)) {
    if (!Object.hasOwn(target, part) || !target[part] || typeof target[part] !== 'object' || Array.isArray(target[part])) throw new Error('Unknown settings path.');
    target = target[part];
  }
  const field = parts.at(-1);
  if (!Object.hasOwn(target, field) || ['__proto__', 'constructor', 'prototype'].includes(field)) throw new Error('Unknown settings path.');
  target[field] = value;
}

async function migrateSettings({ envFile = ENV_FILE, configFile = path.join(__dirname, '..', 'config.json'), keyFile, environment = process.env } = {}) {
  const original = fs.existsSync(envFile) ? readPrivate(envFile, 64 * 1024) : '';
  const legacy = { ...parseEnv(original), ...environment };
  configFile = legacy.CHIKO_CONFIG ? path.resolve(path.dirname(envFile), legacy.CHIKO_CONFIG) : configFile;
  const fromFile = fs.existsSync(configFile) ? JSON.parse(readPrivate(configFile)) : {};
  let settings = importLegacy(legacy, fromFile);
  const url = legacy.DATABASE_URL || (settings.storage === 'json' ? `json:${settings.dataDir || '.'}` : settings.mongoUrl);
  if (!url) throw new Error('No legacy database connection found. Choose a connection with npm run setup.');
  const connection = connectionSettings('/nonexistent/chikochan-connection', { DATABASE_URL: url, DB_NAME: settings.mongoDbName || '' });
  if (connection.storage === 'json') connection.dataDir = path.resolve(path.dirname(envFile), url.slice(5));
  const runtime = loadConfig({ ...settings, ...connection });
  settings.rateLimit = runtime.rateLimit;
  settings = storedSettings(settings);
  const prepared = prepareInstallation({ DATABASE_URL: url, ...(connection.mongoDbName ? { DB_NAME: connection.mongoDbName } : {}) }, envFile, true);
  let store;
  try {
    store = await new SettingsStore(connection, { keyFile }).open();
    const existing = await store.read();
    if (existing && !isDeepStrictEqual(existing, settings)) throw new Error('Database settings already exist; migration never overwrites them.');
    if (!existing) await store.save(settings);
    await store.read();
    prepared.commit();
    if (fs.existsSync(configFile)) fs.unlinkSync(configFile);
  } finally { prepared.release(); await store?.close(); }
}

async function main(argv = process.argv.slice(2)) {
  const [command, key, ...extra] = argv;
  if (extra.length || !['setup', 'get', 'set', 'migrate'].includes(command) || (command !== 'get' && command !== 'set' && key)) {
    throw new Error('Usage: settings.js setup | get [path] | set path | migrate. Values are entered privately, never as arguments.');
  }
  if (command === 'migrate') { await migrateSettings(); console.log('Settings migrated. Back up the private key separately; restart ChikoChan.'); return; }
  const connection = connectionSettings();
  const store = await new SettingsStore(connection).open();
  try {
    let settings = await store.read();
    if (command === 'setup') {
      if (settings) throw new Error('Setup is already complete. Use npm run settings -- set path.');
      const password = await prompt('Administrator password (12–256 characters; input hidden)');
      if (password.length < 12 || password.length > 256) throw new Error('Use a password with 12–256 characters.');
      if (password !== await prompt('Repeat password')) throw new Error('Passwords did not match.');
      settings = mergeConfig(DEFAULTS, {
        adminPassword: password,
        adminSessionSecret: crypto.randomBytes(32).toString('hex')
      });
      await store.save(settings);
      console.log('ChikoChan is ready. Back up .chiko-key separately from the database, then run npm start.');
      return;
    }
    if (!settings) throw new Error('Run npm run setup first.');
    settings = storedSettings(settings);
    if (command === 'get') {
      let value = redact(settings);
      for (const part of key ? key.split('.') : []) {
        if (!value || !Object.hasOwn(value, part)) throw new Error('Unknown settings path.');
        value = value[part];
      }
      console.log(JSON.stringify(value, null, 2));
    } else {
      if (!key) throw new Error('Specify the settings path, without a value.');
      const raw = await prompt('New value (JSON, or plain text for a string; input hidden)');
      let value;
      try { value = JSON.parse(raw); } catch { value = raw; }
      changeSetting(settings, key, value);
      await store.save(settings);
      console.log('Saved. Restart every ChikoChan process to apply the change.');
    }
  } finally { await store.close(); }
}

if (require.main === module) main().catch(error => {
  const safe = /^(Usage:|Unknown settings path|Setup is already|Run npm run setup|Use an interactive terminal|DATABASE_URL must|\.env permits|Settings key unavailable|Cannot unlock settings|Settings changed|Use a password with|Passwords did not match|Settings database unavailable|Unsupported settings schema|Database settings already exist|No legacy database connection)/;
  if (safe.test(error.message)) console.error(error.message);
  console.error('Settings operation failed. Check the command, input, database access, private file permissions, and .chiko-key. See README.md.');
  process.exitCode = 1;
});

module.exports = { changeSetting, main, migrateSettings, prompt };
