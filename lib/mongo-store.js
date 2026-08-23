'use strict';

const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { MongoClient } = require('mongodb');
const {
  SCHEMA_VERSION,
  createDefaultBoard,
  normalizeData
} = require('./store');

function withoutId(document) {
  if (!document) return document;
  const { _id, ...value } = document;
  return value;
}

function stableId(prefix, value) {
  return value.id || `${prefix}-${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function documentKey(id) {
  return `${typeof id}:${JSON.stringify(id)}`;
}

function documentChanges(before, after) {
  const changes = [];
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const name of names) {
    const previous = new Map((before[name] || []).map(document => [documentKey(document._id), document]));
    const next = new Map((after[name] || []).map(document => [documentKey(document._id), document]));

    for (const [key, document] of next) {
      const prior = previous.get(key);
      if (!prior || !isDeepStrictEqual(prior, document)) {
        changes.push({ collection: name, before: prior || null, after: document });
      }
    }
    for (const [key, document] of previous) {
      if (!next.has(key)) changes.push({ collection: name, before: document, after: null });
    }
  }

  return changes;
}

function documentsFromData(data) {
  const threads = [];
  const posts = [];

  for (const thread of data.threads) {
    const { replies, ...openingPost } = thread;
    threads.push({ _id: thread.id, ...openingPost });
    posts.push({ _id: thread.id, ...openingPost, threadId: thread.id, isThread: true });
    for (const reply of replies) {
      posts.push({
        _id: reply.id,
        ...reply,
        boardId: thread.boardId,
        threadId: thread.id,
        isThread: false
      });
    }
  }

  return {
    metadata: [{ _id: 'state', version: data.version, lastId: data.lastId, meta: data.meta }],
    customization: [{ _id: 'site', ...data.customization }],
    boards: data.boards.map(board => ({ _id: board.id, ...board })),
    threads,
    posts,
    media: data.media.map(asset => ({ _id: asset.id, ...asset })),
    reports: data.reports.map(report => ({ _id: stableId('report', report), ...report })),
    bans: data.bans.map(ban => ({ _id: stableId('ban', ban), ...ban })),
    appeals: data.appeals.map(appeal => ({ _id: appeal.id, ...appeal })),
    trash: data.trash.map(entry => ({ _id: entry.id, ...entry })),
    revisions: data.revisions.map(revision => ({ _id: revision.id, ...revision })),
    staff: data.staff.map(account => ({ _id: account.id, ...account })),
    moderationLog: data.moderationLog.map(entry => ({ _id: stableId('moderation', entry), ...entry }))
  };
}

function dataFromDocuments(documents) {
  const replies = new Map();
  for (const post of documents.posts || []) {
    if (post.isThread) continue;
    const reply = withoutId(post);
    const threadId = reply.threadId;
    delete reply.threadId;
    delete reply.boardId;
    delete reply.isThread;
    if (!replies.has(threadId)) replies.set(threadId, []);
    replies.get(threadId).push(reply);
  }

  const threads = (documents.threads || []).map(document => {
    const thread = withoutId(document);
    thread.replies = (replies.get(thread.id) || []).sort((left, right) => left.id - right.id);
    return thread;
  });
  const state = documents.metadata?.[0] || {};

  return {
    version: state.version,
    lastId: state.lastId,
    meta: state.meta,
    customization: withoutId(documents.customization?.[0]) || {},
    boards: (documents.boards || []).map(withoutId),
    threads,
    media: (documents.media || []).map(withoutId),
    reports: (documents.reports || []).map(withoutId),
    bans: (documents.bans || []).map(withoutId),
    appeals: (documents.appeals || []).map(withoutId),
    trash: (documents.trash || []).map(withoutId),
    revisions: (documents.revisions || []).map(withoutId),
    staff: (documents.staff || []).map(withoutId),
    moderationLog: (documents.moderationLog || []).map(withoutId)
  };
}

class MongoStore {
  constructor(config, options = {}) {
    if (!config.mongoUrl) throw new Error('MONGO_URL or MONGODB_URI is required for MongoDB storage.');
    this.maximumCites = config.limits.maxCites;
    this.defaultBoard = createDefaultBoard(config);
    this.client = options.client || new MongoClient(config.mongoUrl);
    this.ownsClient = !options.client;
    this.db = null;
    this.cache = null;
    this.queue = Promise.resolve();
    this.ready = this.initialize(config.mongoDbName);
  }

  async initialize(databaseName) {
    if (this.ownsClient) await this.client.connect();
    this.db = this.client.db(databaseName || undefined);
    const topology = await this.db.admin().command({ hello: 1 });
    this.supportsTransactions = Boolean(topology.setName || topology.msg === 'isdbgrid');
    await this.createIndexes();
    await this.recoverInterruptedMutation();

    let state = await this.db.collection('metadata').findOne({ _id: 'state' });
    if (!state) {
      await this.persist(normalizeData({}, this.maximumCites, this.defaultBoard));
      state = await this.db.collection('metadata').findOne({ _id: 'state' });
    }
    const documents = await this.readDocuments();
    this.cache = normalizeData(dataFromDocuments(documents), this.maximumCites, this.defaultBoard);
    if (Number(state.version) !== SCHEMA_VERSION) {
      const changes = documentChanges(documents, documentsFromData(this.cache));
      await this.commitChanges(changes);
    }
    return this;
  }

  async createIndexes() {
    await Promise.all([
      this.db.collection('posts').createIndex({ id: 1 }, { unique: true, name: 'post_id_unique' }),
      this.db.collection('posts').createIndex({ boardId: 1, threadId: 1 }, { name: 'board_thread_lookup' }),
      this.db.collection('posts').createIndex({ createdAt: -1 }, { name: 'latest_posts' }),
      this.db.collection('threads').createIndex({ boardId: 1, id: 1 }, { name: 'board_thread_id' }),
      this.db.collection('threads').createIndex({ boardId: 1, bumpedAt: -1 }, { name: 'board_bump_order' }),
      this.db.collection('threads').createIndex(
        { boardId: 1, archived: 1, archivedAt: -1 },
        { name: 'board_archive_order' }
      ),
      this.db.collection('media').createIndex({ sha256: 1 }, { name: 'media_sha256' }),
      this.db.collection('media').createIndex({ refCount: 1, createdAt: 1 }, { name: 'media_cleanup' }),
      this.db.collection('reports').createIndex(
        { status: 1, boardId: 1, updatedAt: -1 },
        { name: 'report_queue' }
      ),
      this.db.collection('reports').createIndex({ postId: 1, status: 1 }, { name: 'report_post_status' }),
      this.db.collection('staff').createIndex({ username: 1 }, { unique: true, name: 'staff_username_unique' }),
      this.db.collection('bans').createIndex(
        { active: 1, scope: 1, boardId: 1, target: 1, posterKey: 1, fileHash: 1, expiresAt: 1 },
        { name: 'active_sanction_lookup_v2' }
      ),
      this.db.collection('bans').createIndex({ appealId: 1 }, { unique: true, name: 'sanction_appeal_id' }),
      this.db.collection('appeals').createIndex(
        { status: 1, boardId: 1, updatedAt: -1 },
        { name: 'appeal_queue' }
      ),
      this.db.collection('appeals').createIndex({ sanctionId: 1 }, { unique: true, name: 'appeal_per_sanction' }),
      this.db.collection('trash').createIndex({ purgeAt: 1 }, { name: 'trash_expiration' }),
      this.db.collection('trash').createIndex({ boardId: 1, deletedAt: -1 }, { name: 'board_trash_queue' }),
      this.db.collection('revisions').createIndex(
        { postId: 1, editedAt: -1 },
        { name: 'post_revision_history' }
      ),
      this.db.collection('moderationLog').createIndex({ createdAt: -1 }, { name: 'moderation_recent' }),
      this.db.collection('jobLeases').createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: 0, name: 'job_lease_expiration' }
      ),
      this.db.collection('mutationJournalEntries').createIndex(
        { mutationId: 1, index: 1 },
        { unique: true, name: 'mutation_entry_order' }
      )
    ]);
  }

  async readDocuments(session) {
    const names = [
      'metadata', 'customization', 'boards', 'threads', 'posts', 'media', 'reports', 'bans',
      'appeals', 'trash', 'revisions', 'staff', 'moderationLog'
    ];
    const values = await Promise.all(names.map(name => this.db.collection(name).find({}, { session }).toArray()));
    return Object.fromEntries(names.map((name, index) => [name, values[index]]));
  }

  async readFromMongo(session) {
    const documents = await this.readDocuments(session);
    return normalizeData(dataFromDocuments(documents), this.maximumCites, this.defaultBoard);
  }

  read() {
    if (!this.cache) throw new Error('MongoStore is not ready. Await store.ready before reading.');
    return structuredClone(this.cache);
  }

  async replaceCollection(name, documents, session) {
    const collection = this.db.collection(name);
    const ids = documents.map(document => document._id);
    if (documents.length) {
      await collection.bulkWrite(documents.map(document => ({
        replaceOne: { filter: { _id: document._id }, replacement: document, upsert: true }
      })), { ordered: false, session });
      await collection.deleteMany({ _id: { $nin: ids } }, { session });
    } else {
      await collection.deleteMany({}, { session });
    }
  }

  async persist(data, session) {
    const normalized = normalizeData(data, this.maximumCites, this.defaultBoard);
    const documents = documentsFromData(normalized);
    for (const [name, entries] of Object.entries(documents)) {
      await this.replaceCollection(name, entries, session);
    }
    return normalized;
  }

  async applyChanges(changes, session, direction = 'after') {
    const grouped = new Map();
    for (const change of changes) {
      if (!grouped.has(change.collection)) grouped.set(change.collection, []);
      const document = direction === 'before' ? change.before : change.after;
      const alternate = direction === 'before' ? change.after : change.before;
      if (document) {
        grouped.get(change.collection).push({
          replaceOne: {
            filter: { _id: document._id },
            replacement: document,
            upsert: true
          }
        });
      } else if (alternate) {
        grouped.get(change.collection).push({ deleteOne: { filter: { _id: alternate._id } } });
      }
    }

    for (const [name, operations] of grouped) {
      if (operations.length) {
        await this.db.collection(name).bulkWrite(operations, { ordered: true, session });
      }
    }
  }

  async journaledChanges(changes) {
    if (!changes.length) return;
    const mutationId = crypto.randomUUID();
    const journal = this.db.collection('mutationJournal');
    const entries = this.db.collection('mutationJournalEntries');
    await journal.insertOne({
      _id: 'active',
      mutationId,
      phase: 'prepared',
      changeCount: changes.length,
      createdAt: new Date()
    });

    try {
      for (let offset = 0; offset < changes.length; offset += 500) {
        const batch = changes.slice(offset, offset + 500).map((change, batchIndex) => ({
          _id: `${mutationId}:${offset + batchIndex}`,
          mutationId,
          index: offset + batchIndex,
          ...change
        }));
        await entries.insertMany(batch, { ordered: true });
      }
    } catch (error) {
      await entries.deleteMany({ mutationId }).catch(() => {});
      await journal.deleteOne({ _id: 'active', mutationId }).catch(() => {});
      throw error;
    }

    try {
      await this.applyChanges(changes);
      await journal.updateOne(
        { _id: 'active', mutationId },
        { $set: { phase: 'committed', committedAt: new Date() } }
      );
    } catch (error) {
      try {
        await this.applyChanges([...changes].reverse(), undefined, 'before');
        await entries.deleteMany({ mutationId });
        await journal.deleteOne({ _id: 'active', mutationId });
      } catch {
        // Leave the prepared journal in place for deterministic recovery at startup.
      }
      throw error;
    }

    await entries.deleteMany({ mutationId }).catch(() => {});
    await journal.deleteOne({ _id: 'active', mutationId }).catch(() => {});
  }

  async recoverInterruptedMutation() {
    const journal = this.db.collection('mutationJournal');
    const entries = this.db.collection('mutationJournalEntries');
    const active = await journal.findOne({ _id: 'active' });
    if (!active) {
      await entries.deleteMany({}).catch(() => {});
      return;
    }

    const records = await entries.find({ mutationId: active.mutationId }).sort({ index: 1 }).toArray();
    const changes = records.map(({ _id, mutationId, index, ...change }) => change);
    if (active.phase !== 'committed') {
      await this.applyChanges(changes.reverse(), undefined, 'before');
    }
    await entries.deleteMany({ mutationId: active.mutationId });
    await journal.deleteOne({ _id: 'active', mutationId: active.mutationId });
  }

  async commitChanges(changes) {
    if (!changes.length) return;
    if (this.supportsTransactions) {
      await this.withTransaction(session => this.applyChanges(changes, session));
      return;
    }
    await this.journaledChanges(changes);
  }

  write(data) {
    return this.enqueue(async () => {
      const saved = normalizeData(data, this.maximumCites, this.defaultBoard);
      if (this.cache) {
        const changes = documentChanges(documentsFromData(this.cache), documentsFromData(saved));
        await this.commitChanges(changes);
      } else {
        await this.withTransaction(session => this.persist(saved, session));
      }
      this.cache = saved;
      return structuredClone(saved);
    });
  }

  update(mutator) {
    return this.enqueue(async () => {
      if (!this.cache) throw new Error('MongoStore is not ready. Await store.ready before updating.');
      const before = this.cache;
      const working = structuredClone(before);
      const result = await mutator(working);
      const saved = normalizeData(working, this.maximumCites, this.defaultBoard);
      const changes = documentChanges(documentsFromData(before), documentsFromData(saved));
      await this.commitChanges(changes);
      this.cache = saved;
      return { data: structuredClone(saved), result };
    });
  }

  enqueue(operation) {
    const pending = this.queue.then(operation);
    this.queue = pending.catch(() => {});
    return pending;
  }

  async acquireLease(name, ownerId, ttlMs, now = Date.now()) {
    const key = String(name || '');
    const owner = String(ownerId || '');
    try {
      const result = await this.db.collection('jobLeases').findOneAndUpdate(
        {
          _id: key,
          $or: [
            { expiresAt: { $lte: new Date(now) } },
            { ownerId: owner }
          ]
        },
        {
          $set: {
            ownerId: owner,
            acquiredAt: new Date(now),
            expiresAt: new Date(now + ttlMs)
          }
        },
        { upsert: true, returnDocument: 'after' }
      );
      const lease = result?.value || result;
      return lease?.ownerId === owner;
    } catch (error) {
      if (error?.code === 11000) return false;
      throw error;
    }
  }

  async releaseLease(name, ownerId) {
    const result = await this.db.collection('jobLeases').deleteOne({
      _id: String(name || ''),
      ownerId: String(ownerId || '')
    });
    return result.deletedCount === 1;
  }

  async withTransaction(operation) {
    if (!this.supportsTransactions) return operation(undefined);
    const session = this.client.startSession();
    try {
      let value;
      await session.withTransaction(async () => {
        value = await operation(session);
      });
      return value;
    } finally {
      await session.endSession();
    }
  }

  async close() {
    await this.queue;
    if (this.ownsClient) await this.client.close();
  }
}

module.exports = { MongoStore, dataFromDocuments, documentChanges, documentsFromData };
