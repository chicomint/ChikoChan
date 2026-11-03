'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const { MongoClient } = require('mongodb');
const { DEFAULTS, ENV_FILE, loadConfig, mergeConfig } = require('../config');

const KEY_FILE = path.join(__dirname, '..', '.chiko-key');
const DATABASE_FIELDS = new Set(['DATABASE_URL', 'DB_NAME']);
const PRIVATE = /password|secret|token|key(?:id)?$|redisUrl/i;
const DERIVED = ['rootDir', 'dataFile', 'uploadDir', 'quarantineDir', 'configPath', 'store', 'mongoUrl', 'mongoDbName', 'storage', 'url', 'name', 'keyFile'];

function readPrivate(filename, maxBytes = 1024 * 1024) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes
      || (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid()))) {
      throw new Error('Private configuration files must belong to this account with mode 600.');
    }
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}

function connectionSettings(filename = ENV_FILE, environment = process.env) {
  const local = fs.existsSync(filename) ? parseEnv(readPrivate(filename, 64 * 1024)) : {};
  if (Object.keys(local).some(key => !DATABASE_FIELDS.has(key))) {
    throw new Error('.env permits database connection fields only. Run npm run migrate:settings first.');
  }
  const url = environment.DATABASE_URL || local.DATABASE_URL || 'json:./data';
  const name = environment.DB_NAME || local.DB_NAME || '';
  if (/^json:.+/.test(url)) return { storage: 'json', dataDir: path.resolve(path.dirname(filename), url.slice(5)), url, name: '' };
  if (/^mongodb(?:\+srv)?:\/\//.test(url)) return { storage: 'mongodb', mongoUrl: url, mongoDbName: name, url, name };
  throw new Error('DATABASE_URL must use json:, mongodb://, or mongodb+srv://.');
}

function encryptionKey(filename = KEY_FILE, create = false) {
  if (create && !fs.existsSync(filename)) {
    fs.writeFileSync(filename, crypto.randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  }
  let key;
  try { key = readPrivate(filename, 100).trim(); }
  catch { throw new Error('Settings key unavailable. Restore the private .chiko-key file; see README.md.'); }
  if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('Invalid settings key file.');
  return Buffer.from(key, 'hex');
}

function storedSettings(settings) {
  const values = mergeConfig(DEFAULTS, settings);
  for (const key of DERIVED) delete values[key];
  delete values.deployment.isProduction;
  if (values.site.pages) {
    values.site.pages = Object.fromEntries(Object.entries(values.site.pages).map(([key, page]) => [key, {
      title: page.title, content: page.content
    }]));
  }
  return values;
}

function redact(value, key = '') {
  if (PRIVATE.test(key)) return value ? '[private]' : '';
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  return value;
}

class SettingsStore {
  constructor(connection, { keyFile = KEY_FILE, client, id = 'application', normalize = storedSettings, validate } = {}) {
    if (id !== 'application' && !/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid settings record ID.');
    this.id = id;
    this.normalize = normalize;
    this.validate = validate || (settings => loadConfig({ ...settings, ...connection }));
    this.connection = connection;
    this.keyFile = keyFile;
    this.client = client;
    this.file = connection.storage === 'json' ? path.join(connection.dataDir, id === 'application' ? 'settings.json' : `preferences/${id}.json`) : '';
    this.revision = 0;
  }

  async open() {
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    } else {
      try {
        this.client ||= new MongoClient(this.connection.mongoUrl, { serverSelectionTimeoutMS: 5000 });
        await this.client.connect();
        this.collection = this.client.db(this.connection.mongoDbName || undefined).collection('settings');
      } catch {
        await this.client?.close().catch(() => {});
        throw new Error('Settings database unavailable. Check database connection and access permissions.');
      }
    }
    return this;
  }

  async read() {
    let record;
    try { record = this.file ? (fs.existsSync(this.file) ? JSON.parse(readPrivate(this.file)) : null) : await this.collection.findOne({ _id: this.id }); }
    catch { throw new Error('Could not read settings. Check database access and private file permissions.'); }
    if (!record) { this.revision = 0; return null; }
    if (record.version !== 1) throw new Error('Unsupported settings schema. Upgrade ChikoChan before opening this database.');
    const key = encryptionKey(this.keyFile);
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
      decipher.setAAD(Buffer.from(`chikochan:settings:1:${this.id}:${record.revision}`));
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
      const settings = JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.value, 'base64')), decipher.final()]).toString('utf8'));
      this.revision = record.revision;
      return settings;
    } catch { throw new Error('Cannot unlock settings. Restore the matching key and database backup.'); }
  }

  async save(settings) {
    this.validate(settings);
    const key = encryptionKey(this.keyFile, this.id === 'application' && this.revision === 0);
    const iv = crypto.randomBytes(12);
    const revision = this.revision + 1;
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`chikochan:settings:1:${this.id}:${revision}`));
    const value = Buffer.concat([cipher.update(JSON.stringify(this.normalize(settings))), cipher.final()]);
    const record = { _id: this.id, version: 1, revision, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), value: value.toString('base64') };
    if (this.file) {
      const lock = `${this.file}.lock`;
      let fd;
      const staged = `${this.file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
      try {
        fd = fs.openSync(lock, 'wx', 0o600);
        const previous = fs.existsSync(this.file) ? JSON.parse(readPrivate(this.file)).revision : 0;
        if (previous !== this.revision) throw new Error('Settings changed. Read again before saving.');
        const stagedFd = fs.openSync(staged, 'wx', 0o600);
        try { fs.writeFileSync(stagedFd, JSON.stringify(record) + '\n'); fs.fsyncSync(stagedFd); }
        finally { fs.closeSync(stagedFd); }
        fs.renameSync(staged, this.file);
      } finally {
        fs.rmSync(staged, { force: true });
        if (fd !== undefined) { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
      }
    } else {
      try {
        if (!this.revision) await this.collection.insertOne(record);
        else if (!(await this.collection.replaceOne({ _id: this.id, revision: this.revision }, record)).matchedCount) {
          throw new Error('Conflict');
        }
      } catch { throw new Error('Settings could not be saved. Check access or read again after a concurrent update.'); }
    }
    this.revision = revision;
  }

  async close() { await this.client?.close(); }
}

async function configuredSettings(options = {}) {
  const connection = connectionSettings(options.envFile);
  const store = await new SettingsStore(connection, options).open();
  try {
    const settings = await store.read();
    if (!settings) throw new Error('Setup required. Run npm run setup or open /install locally.');
    return loadConfig({ ...settings, ...connection });
  } finally { await store.close(); }
}

module.exports = { DATABASE_FIELDS, KEY_FILE, SettingsStore, configuredSettings, connectionSettings, encryptionKey, readPrivate, redact, storedSettings };
