'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const { ENV_FILE } = require('../config');

const PLATFORM_HELP = 'Configure STORAGE=mongodb, MONGO_URL (or MONGODB_URI), MONGO_DB_NAME, '
  + 'ADMIN_PASSWORD, and ADMIN_SESSION_SECRET in your hosting platform, then restart ChikoChan. '
  + 'Use an independent random value of at least 32 bytes for ADMIN_SESSION_SECRET. '
  + 'SITE_NAME and SITE_DESCRIPTION are optional. On ephemeral hosts, use platform variables '
  + 'instead of a temporary .env; set INSTALLER_DISABLED=true to disable web setup. '
  + 'Production also requires the security settings documented in README.md.';

function readEnvironment(filename = ENV_FILE) {
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024) {
      throw new Error('The environment file cannot safely be updated.');
    }
    return fs.readFileSync(filename, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw new Error('The environment file cannot safely be updated.');
  }
}

function installedEnvironment(env) {
  return /^(true|1|yes)$/i.test(env.CHIKO_INSTALLED || '')
    || env.STORAGE === 'json'
    || Boolean(env.MONGO_URL?.trim() || env.MONGODB_URI?.trim());
}

function installationRequired(config, env = process.env) {
  return !installedEnvironment(env) && config.storage === 'mongodb' && !config.mongoUrl;
}

// Node's env-file parser does not interpret JSON/backslash quote escaping.
// Choose a delimiter it can round-trip, including literal multiline values.
function environmentLine(key, value) {
  const text = String(value);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || text.includes('\0') || text.includes('\r')) {
    throw new Error('A setting cannot be represented safely in an environment file.');
  }
  for (const delimiter of ['"', "'", '`', '']) {
    if (delimiter && text.includes(delimiter)) continue;
    const line = `${key}=${delimiter}${text}${delimiter}\n`;
    if (parseEnv(line)[key] === text && Object.keys(parseEnv(line)).length === 1) return line;
  }
  throw new Error('A setting contains a combination of quotes that cannot be saved in an environment file.');
}

function mergeEnvironment(original, settings) {
  const values = { ...parseEnv(original), ...settings };
  return '# ChikoChan configuration. Keep this file private.\n'
    + Object.entries(values).map(([key, value]) => environmentLine(key, value)).join('');
}

function configurationWritable(filename = ENV_FILE) {
  let probe;
  try {
    readEnvironment(filename);
    // Replacement uses rename, so the directory must be writable too.
    fs.accessSync(path.dirname(filename), fs.constants.W_OK);
    if (fs.existsSync(filename)) fs.accessSync(filename, fs.constants.W_OK);
    probe = path.join(path.dirname(filename), `.tmp-install-probe-${crypto.randomBytes(12).toString('hex')}`);
    const fd = fs.openSync(probe, 'wx', 0o600);
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  } finally {
    if (probe) {
      try { fs.rmSync(probe, { force: true }); } catch { /* A changed filesystem remains unavailable. */ }
    }
  }
}

// The lock serializes installers in different Node processes. Stage the private
// file first, initialize the existing store/app, then commit configuration and
// the durable installation marker together with one atomic rename.
function prepareInstallation(settings, filename = ENV_FILE) {
  const lock = `${filename}.install-lock`;
  let lockFd;
  let staged;
  let original;
  try {
    lockFd = fs.openSync(lock, 'wx', 0o600);
    original = readEnvironment(filename);
    if (installedEnvironment(parseEnv(original))) throw new Error('Installation is already configured.');
    const content = mergeEnvironment(original, { ...settings, CHIKO_INSTALLED: 'true' });
    staged = path.join(path.dirname(filename), `.tmp-install-${crypto.randomBytes(12).toString('hex')}`);
    const fd = fs.openSync(staged, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, content, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    if (staged) fs.rmSync(staged, { force: true });
    if (lockFd !== undefined) {
      fs.closeSync(lockFd);
      fs.rmSync(lock, { force: true });
    }
    throw new Error('Configuration could not be saved safely. Another installation may be running.');
  }
  function release() {
    // Cleanup must not turn an already committed installation into a failure.
    try { if (staged) fs.rmSync(staged, { force: true }); } catch { /* Private temporary file. */ }
    try { fs.closeSync(lockFd); } catch { /* Already closed. */ }
    try { fs.rmSync(lock, { force: true }); } catch { /* A persisted marker still locks setup. */ }
  }
  return {
    commit() {
      // Do not overwrite settings changed externally while MongoDB initialized.
      if (readEnvironment(filename) !== original) throw new Error('Configuration changed during installation.');
      fs.renameSync(staged, filename);
      staged = null;
    },
    release
  };
}

module.exports = {
  PLATFORM_HELP, configurationWritable, environmentLine, installedEnvironment,
  installationRequired, mergeEnvironment, prepareInstallation, readEnvironment
};
