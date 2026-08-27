'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const BACKUP_FORMAT = 1;

function filesBelow(root, relative = '') {
  const directory = path.join(root, relative);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing symbolic link in backup source: ${child}`);
    return entry.isDirectory() ? filesBelow(root, child) : [child];
  });
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertFreshDirectory(directory) {
  if (fs.existsSync(directory) && fs.readdirSync(directory).length) {
    throw new Error(`Destination must not exist or must be empty: ${directory}`);
  }
}

function createLocalBackup(sourceDirectory, destinationDirectory, options = {}) {
  const source = path.resolve(sourceDirectory);
  const destination = path.resolve(destinationDirectory);
  const sourceFile = path.join(source, 'posts.json');
  if (!fs.existsSync(sourceFile)) throw new Error(`Source posts.json not found: ${sourceFile}`);
  if (destination === source || destination.startsWith(`${source}${path.sep}`)) {
    throw new Error('Backup destination must be outside the source data directory.');
  }
  assertFreshDirectory(destination);
  const payload = path.join(destination, 'data');
  fs.mkdirSync(payload, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(sourceFile).isSymbolicLink()) throw new Error('Refusing symbolic-link posts.json.');
  fs.copyFileSync(sourceFile, path.join(payload, 'posts.json'), fs.constants.COPYFILE_EXCL);
  for (const name of ['src', ...(options.includeQuarantine ? ['quarantine'] : [])]) {
    const input = path.join(source, name);
    if (fs.existsSync(input)) fs.cpSync(input, path.join(payload, name), { recursive: true, errorOnExist: true });
  }
  const files = filesBelow(payload).sort().map(relative => {
    const filePath = path.join(payload, relative);
    fs.chmodSync(filePath, 0o600);
    return { path: relative.split(path.sep).join('/'), bytes: fs.statSync(filePath).size, sha256: sha256(filePath) };
  });
  const manifest = {
    format: BACKUP_FORMAT,
    createdAt: new Date().toISOString(),
    quarantineIncluded: options.includeQuarantine === true,
    files
  };
  fs.writeFileSync(path.join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

function parseArguments(argv) {
  const values = { source: '', destination: '', includeQuarantine: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--source') values.source = argv[++index] || '';
    else if (argument === '--destination') values.destination = argv[++index] || '';
    else if (argument === '--include-quarantine') values.includeQuarantine = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!values.source || !values.destination) throw new Error('--source and --destination are required.');
  return values;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const manifest = createLocalBackup(args.source, args.destination, args);
  console.log(`Backup created with ${manifest.files.length} files at ${path.resolve(args.destination)}`);
  console.log('The backup intentionally excludes .env and other credentials.');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Backup failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { BACKUP_FORMAT, createLocalBackup, parseArguments, sha256 };
