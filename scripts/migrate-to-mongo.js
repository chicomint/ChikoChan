'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { MongoClient } = require('mongodb');
const { loadConfig } = require('../config');
const { documentsFromData } = require('../lib/mongo-store');
const { createDefaultBoard, normalizeData } = require('../lib/store');

async function insertMissing(collection, documents) {
  if (!documents.length) return { inserted: 0, skipped: 0 };
  const ids = documents.map(document => document._id);
  const existing = new Set(await collection.distinct('_id', { _id: { $in: ids } }));
  const missing = documents.filter(document => !existing.has(document._id));
  if (missing.length) await collection.insertMany(missing, { ordered: false });
  return { inserted: missing.length, skipped: documents.length - missing.length };
}

async function main() {
  const config = loadConfig();
  if (!config.mongoUrl) throw new Error('Set MONGO_URL or MONGODB_URI before running the migration.');

  const sourcePath = config.dataFile;
  const backupPath = `${sourcePath}.backup`;
  if (!fs.existsSync(sourcePath)) throw new Error(`Source file not found: ${sourcePath}`);
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(sourcePath, backupPath, fs.constants.COPYFILE_EXCL);
    console.log(`Backup created: ${backupPath}`);
  } else {
    console.log(`Backup already exists: ${backupPath}`);
  }

  const parsed = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  const data = normalizeData(parsed, config.limits.maxCites, createDefaultBoard(config));
  const documents = documentsFromData(data);
  const client = new MongoClient(config.mongoUrl);

  try {
    await client.connect();
    const db = client.db(config.mongoDbName || undefined);
    await Promise.all([
      db.collection('posts').createIndex({ id: 1 }, { unique: true, name: 'post_id_unique' }),
      db.collection('posts').createIndex({ boardId: 1, threadId: 1 }, { name: 'board_thread_lookup' }),
      db.collection('posts').createIndex({ createdAt: -1 }, { name: 'latest_posts' }),
      db.collection('threads').createIndex({ boardId: 1, id: 1 }, { name: 'board_thread_id' }),
      db.collection('threads').createIndex({ boardId: 1, bumpedAt: -1 }, { name: 'board_bump_order' }),
      db.collection('threads').createIndex(
        { boardId: 1, archived: 1, archivedAt: -1 },
        { name: 'board_archive_order' }
      ),
      db.collection('media').createIndex({ sha256: 1 }, { name: 'media_sha256' }),
      db.collection('media').createIndex({ refCount: 1, createdAt: 1 }, { name: 'media_cleanup' }),
      db.collection('reports').createIndex(
        { status: 1, boardId: 1, updatedAt: -1 },
        { name: 'report_queue' }
      ),
      db.collection('reports').createIndex({ postId: 1, status: 1 }, { name: 'report_post_status' }),
      db.collection('staff').createIndex({ username: 1 }, { unique: true, name: 'staff_username_unique' }),
      db.collection('bans').createIndex(
        { active: 1, scope: 1, boardId: 1, target: 1, posterKey: 1, fileHash: 1, expiresAt: 1 },
        { name: 'active_sanction_lookup_v2' }
      ),
      db.collection('bans').createIndex({ appealId: 1 }, { unique: true, name: 'sanction_appeal_id' }),
      db.collection('appeals').createIndex(
        { status: 1, boardId: 1, updatedAt: -1 },
        { name: 'appeal_queue' }
      ),
      db.collection('appeals').createIndex({ sanctionId: 1 }, { unique: true, name: 'appeal_per_sanction' }),
      db.collection('trash').createIndex({ purgeAt: 1 }, { name: 'trash_expiration' }),
      db.collection('trash').createIndex({ boardId: 1, deletedAt: -1 }, { name: 'board_trash_queue' }),
      db.collection('revisions').createIndex(
        { postId: 1, editedAt: -1 },
        { name: 'post_revision_history' }
      ),
      db.collection('moderationLog').createIndex({ createdAt: -1 }, { name: 'moderation_recent' }),
      db.collection('mutationJournalEntries').createIndex(
        { mutationId: 1, index: 1 },
        { unique: true, name: 'mutation_entry_order' }
      ),
      db.collection('jobLeases').createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: 0, name: 'job_lease_expiration' }
      )
    ]);

    const summary = {};
    for (const name of [
      'customization', 'boards', 'threads', 'posts', 'media', 'reports', 'bans', 'appeals',
      'trash', 'revisions', 'staff', 'moderationLog'
    ]) {
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

main().catch(error => {
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
});
