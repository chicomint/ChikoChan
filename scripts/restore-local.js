'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { BACKUP_FORMAT, sha256 } = require('./backup-local');

function safeRelativePath(value) {
  const normalized = String(value || '');
  return normalized && !path.isAbsolute(normalized) && !normalized.includes('\\')
    && normalized.split('/').every(segment => segment && segment !== '.' && segment !== '..');
}

function restoreLocalBackup(backupDirectory, targetDirectory) {
  const backup = path.resolve(backupDirectory);
  const target = path.resolve(targetDirectory);
  const manifestPath = path.join(backup, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`Backup manifest not found: ${manifestPath}`);
  if (fs.existsSync(target) && fs.readdirSync(target).length) {
    throw new Error(`Restore target must not exist or must be empty: ${target}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.format !== BACKUP_FORMAT || !Array.isArray(manifest.files)) {
    throw new Error('Unsupported or malformed backup manifest.');
  }
  for (const entry of manifest.files) {
    if (!safeRelativePath(entry.path) || !/^[a-f0-9]{64}$/.test(String(entry.sha256 || ''))) {
      throw new Error('Backup manifest contains an unsafe file entry.');
    }
    const source = path.join(backup, 'data', ...entry.path.split('/'));
    if (!fs.existsSync(source) || fs.statSync(source).size !== Number(entry.bytes) || sha256(source) !== entry.sha256) {
      throw new Error(`Backup integrity check failed for ${entry.path}.`);
    }
  }
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const entry of manifest.files) {
    const source = path.join(backup, 'data', ...entry.path.split('/'));
    const destination = path.join(target, ...entry.path.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, 0o600);
  }
  return manifest;
}

function parseArguments(argv) {
  const values = { backup: '', target: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--backup') values.backup = argv[++index] || '';
    else if (argument === '--target') values.target = argv[++index] || '';
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!values.backup || !values.target) throw new Error('--backup and --target are required.');
  return values;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const manifest = restoreLocalBackup(args.backup, args.target);
  console.log(`Verified and restored ${manifest.files.length} files into new directory ${path.resolve(args.target)}`);
  console.log('Review the restored data before changing DATA_DIR.');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Restore failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { parseArguments, restoreLocalBackup, safeRelativePath };
