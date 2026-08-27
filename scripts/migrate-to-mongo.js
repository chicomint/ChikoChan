'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { MongoClient } = require('mongodb');
const { loadConfig } = require('../config');
const { MongoStore, documentsFromData } = require('../lib/mongo-store');
const { createDefaultBoard, normalizeData } = require('../lib/store');

async function insertMissing(collection, documents) {
  if (!documents.length) return { inserted: 0, skipped: 0 };
  const ids = documents.map(document => document._id);
  const existing = new Set(await collection.distinct('_id', { _id: { $in: ids } }));
  const missing = documents.filter(document => !existing.has(document._id));
  if (missing.length) await collection.insertMany(missing, { ordered: false });
  return { inserted: missing.length, skipped: documents.length - missing.length };
}

function parseArguments(argv) {
  const values = { dryRun: false, source: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') values.dryRun = true;
    else if (argument === '--source') values.source = argv[++index] || '';
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return values;
}

function prepareMigration(parsed, config) {
  const data = normalizeData(parsed, config.limits.maxCites, createDefaultBoard(config));
  return { data, documents: documentsFromData(data) };
}

async function main() {
  const config = loadConfig();
  const args = parseArguments(process.argv.slice(2));
  const sourcePath = path.resolve(args.source || config.dataFile);
  const backupPath = `${sourcePath}.backup`;
  if (!fs.existsSync(sourcePath)) throw new Error(`Source file not found: ${sourcePath}`);

  const parsed = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  const { data, documents } = prepareMigration(parsed, config);
  if (args.dryRun) {
    console.log('Migration dry-run summary (no files or database records changed):');
    for (const [name, entries] of Object.entries(documents)) console.log(`  ${name}: ${entries.length}`);
    return;
  }
  if (!config.mongoUrl) throw new Error('Set MONGO_URL or MONGODB_URI before running the migration.');
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(sourcePath, backupPath, fs.constants.COPYFILE_EXCL);
    console.log(`Backup created: ${backupPath}`);
  } else {
    console.log(`Backup already exists: ${backupPath}`);
  }
  const client = new MongoClient(config.mongoUrl);

  try {
    await client.connect();
    const db = client.db(config.mongoDbName || undefined);
    await MongoStore.prototype.createIndexes.call({ db });

    const summary = {};
    for (const name of Object.keys(documents).filter(name => name !== 'metadata')) {
      summary[name] = await insertMissing(db.collection(name), documents[name]);
    }

    const metadata = db.collection('metadata');
    const existingState = await metadata.findOne({ _id: 'state' });
    if (existingState) {
      await metadata.updateOne({ _id: 'state' }, { $max: { lastId: data.lastId } });
      summary.metadata = { inserted: 0, skipped: 1 };
    } else {
      await metadata.insertOne(documents.metadata[0]);
      summary.metadata = { inserted: 1, skipped: 0 };
    }

    console.log('Migration summary:');
    for (const [name, counts] of Object.entries(summary)) {
      console.log(`  ${name}: inserted ${counts.inserted}, skipped ${counts.skipped}`);
    }
    console.log(`Source retained: ${path.relative(process.cwd(), sourcePath) || sourcePath}`);
  } finally {
    await client.close();
  }
}

if (require.main === module) main().catch(error => {
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
});

module.exports = { insertMissing, main, parseArguments, prepareMigration };
