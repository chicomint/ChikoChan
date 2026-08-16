'use strict';

const crypto = require('node:crypto');
const { MongoClient } = require('mongodb');
const {
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
    boards: data.boards.map(board => ({ _id: board.id, ...board })),
    threads,
    posts,
    reports: data.reports.map(report => ({ _id: stableId('report', report), ...report })),
    bans: data.bans.map(ban => ({ _id: stableId('ban', ban), ...ban })),
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
    boards: (documents.boards || []).map(withoutId),
    threads,
    reports: (documents.reports || []).map(withoutId),
    bans: (documents.bans || []).map(withoutId),
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

    const state = await this.db.collection('metadata').findOne({ _id: 'state' });
    if (!state) {
      await this.persist(normalizeData({}, this.maximumCites, this.defaultBoard));
    }
    this.cache = await this.readFromMongo();
    return this;
  }

  async createIndexes() {
    await Promise.all([
      this.db.collection('posts').createIndex({ id: 1 }, { unique: true, name: 'post_id_unique' }),
      this.db.collection('posts').createIndex({ boardId: 1, threadId: 1 }, { name: 'board_thread_lookup' }),
      this.db.collection('posts').createIndex({ createdAt: -1 }, { name: 'latest_posts' }),
      this.db.collection('threads').createIndex({ boardId: 1, id: 1 }, { name: 'board_thread_id' }),
      this.db.collection('threads').createIndex({ boardId: 1, bumpedAt: -1 }, { name: 'board_bump_order' })
    ]);
  }

  async readFromMongo(session) {
    const names = ['metadata', 'boards', 'threads', 'posts', 'reports', 'bans', 'moderationLog'];
    const values = await Promise.all(names.map(name => this.db.collection(name).find({}, { session }).toArray()));
    const documents = Object.fromEntries(names.map((name, index) => [name, values[index]]));
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

  write(data) {
    return this.enqueue(async () => {
      const saved = await this.withTransaction(session => this.persist(data, session));
      this.cache = saved;
      return structuredClone(saved);
    });
  }

  update(mutator) {
    return this.enqueue(async () => {
      let result;
      const saved = await this.withTransaction(async session => {
        const data = await this.readFromMongo(session);
        result = await mutator(data);
        return this.persist(data, session);
      });
      this.cache = saved;
      return { data: structuredClone(saved), result };
    });
  }

  enqueue(operation) {
    const pending = this.queue.then(operation);
    this.queue = pending.catch(() => {});
    return pending;
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

module.exports = { MongoStore, dataFromDocuments, documentsFromData };
