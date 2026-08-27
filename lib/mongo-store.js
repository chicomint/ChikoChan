'use strict';

const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { MongoClient } = require('mongodb');
const {
  SCHEMA_VERSION,
  createDefaultBoard,
  normalizeData
} = require('./store');
const { formatBytes } = require('./utils');

const PUBLIC_POST_PROJECTION = { passwordHash: 0, posterKey: 0 };

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
    mediaHashBans: data.mediaHashBans.map(entry => ({ _id: entry.id, ...entry })),
    mediaDecisions: data.mediaDecisions.map(entry => ({ _id: entry.id, ...entry })),
    mediaProviderResults: data.mediaProviderResults.map(entry => ({ _id: entry.id, ...entry })),
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
    mediaHashBans: (documents.mediaHashBans || []).map(withoutId),
    mediaDecisions: (documents.mediaDecisions || []).map(withoutId),
    mediaProviderResults: (documents.mediaProviderResults || []).map(withoutId),
    reports: (documents.reports || []).map(withoutId),
    bans: (documents.bans || []).map(withoutId),
    appeals: (documents.appeals || []).map(withoutId),
    trash: (documents.trash || []).map(withoutId),
    revisions: (documents.revisions || []).map(withoutId),
    staff: (documents.staff || []).map(withoutId),
    moderationLog: (documents.moderationLog || []).map(withoutId)
  };
}

function publicPost(document) {
  const post = withoutId(document);
  delete post.threadId;
  delete post.boardId;
  delete post.isThread;
  delete post.passwordHash;
  delete post.posterKey;
  return post;
}

function publicThread(document) {
  const thread = publicPost(document);
  thread.boardId = String(document.boardId || '');
  return thread;
}

function hydrateThreads(threadDocuments, postDocuments = []) {
  const replies = new Map();
  for (const document of postDocuments) {
    if (document.isThread) continue;
    const threadId = Number(document.threadId);
    if (!replies.has(threadId)) replies.set(threadId, []);
    replies.get(threadId).push(publicPost(document));
  }
  for (const values of replies.values()) {
    values.sort((left, right) => Number(left.id) - Number(right.id));
  }
  return threadDocuments.map(document => {
    const thread = publicThread(document);
    thread.replies = replies.get(Number(thread.id)) || [];
    return thread;
  });
}

class MongoStore {
  constructor(config, options = {}) {
    if (!config.mongoUrl) throw new Error('MONGO_URL or MONGODB_URI is required for MongoDB storage.');
    this.maximumCites = config.limits.maxCites;
    this.defaultBoard = createDefaultBoard(config);
    this.client = options.client || new MongoClient(config.mongoUrl);
    this.kind = 'mongodb';
    this.supportsTargetedQueries = true;
    this.uploadDir = config.uploadDir;
    this.requireTransactions = config.mongo.requireTransactions;
    this.ownsClient = !options.client;
    this.db = null;
    this.cache = null;
    this.cacheDirty = false;
    this.queue = Promise.resolve();
    this.ready = this.initialize(config.mongoDbName);
  }

  async initialize(databaseName) {
    if (this.ownsClient) await this.client.connect();
    this.db = this.client.db(databaseName || undefined);
    const topology = await this.db.admin().command({ hello: 1 });
    this.supportsTransactions = Boolean(topology.setName || topology.msg === 'isdbgrid');
    if (this.requireTransactions && !this.supportsTransactions) {
      throw new Error('MongoDB transactions are required, but this deployment is not a replica set or sharded cluster.');
    }
    await this.createIndexes();
    await this.recoverInterruptedMutation();

    let state = await this.db.collection('metadata').findOne({ _id: 'state' });
    if (!state) {
      await this.persist(normalizeData({}, this.maximumCites, this.defaultBoard));
      state = await this.db.collection('metadata').findOne({ _id: 'state' });
    }
    const documents = await this.readDocuments();
    this.cache = normalizeData(dataFromDocuments(documents), this.maximumCites, this.defaultBoard);
    this.cacheDirty = false;
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
      this.db.collection('posts').createIndex({ threadId: 1, isThread: 1, id: 1 }, { name: 'thread_reply_order' }),
      this.db.collection('posts').createIndex({ createdAt: -1 }, { name: 'latest_posts' }),
      this.db.collection('posts').createIndex(
        { title: 'text', name: 'text', comment: 'text' },
        { name: 'public_post_search', weights: { title: 4, name: 2, comment: 1 } }
      ),
      this.db.collection('posts').createIndex({ 'attachments.sha256': 1 }, { name: 'post_attachment_hash' }),
      this.db.collection('boards').createIndex({ uri: 1 }, { unique: true, name: 'board_uri_unique' }),
      this.db.collection('boards').createIndex({ enabled: 1, order: 1 }, { name: 'public_board_order' }),
      this.db.collection('threads').createIndex({ boardId: 1, id: 1 }, { name: 'board_thread_id' }),
      this.db.collection('threads').createIndex(
        { boardId: 1, archived: 1, sticky: -1, bumpedAt: -1 },
        { name: 'board_bump_order_v2' }
      ),
      this.db.collection('threads').createIndex(
        { boardId: 1, archived: 1, archivedAt: -1 },
        { name: 'board_archive_order' }
      ),
      this.db.collection('threads').createIndex(
        { archived: 1, createdAt: -1, id: -1 },
        { name: 'overboard_latest' }
      ),
      this.db.collection('media').createIndex({ sha256: 1 }, { name: 'media_sha256' }),
      this.db.collection('media').createIndex({ contentSha256: 1 }, { name: 'media_content_sha256' }),
      this.db.collection('media').createIndex({ path: 1, state: 1 }, { name: 'public_media_path' }),
      this.db.collection('media').createIndex({ thumbnail: 1, state: 1 }, { name: 'public_thumbnail_path' }),
      this.db.collection('media').createIndex(
        { state: 1, createdAt: -1 },
        { name: 'media_state_queue' }
      ),
      this.db.collection('media').createIndex({ refCount: 1, createdAt: 1 }, { name: 'media_cleanup' }),
      this.db.collection('reports').createIndex(
        { status: 1, boardId: 1, updatedAt: -1 },
        { name: 'report_queue' }
      ),
      this.db.collection('mediaHashBans').createIndex(
        { sha256: 1, scope: 1, boardId: 1 },
        { unique: true, name: 'media_hash_ban_scope' }
      ),
      this.db.collection('mediaHashBans').createIndex(
        { active: 1, updatedAt: -1 },
        { name: 'active_media_hash_bans' }
      ),
      this.db.collection('mediaDecisions').createIndex(
        { sha256: 1, createdAt: -1 },
        { name: 'media_decision_hash_history' }
      ),
      this.db.collection('mediaDecisions').createIndex(
        { decision: 1, boardId: 1, createdAt: -1 },
        { name: 'media_decision_queue' }
      ),
      this.db.collection('mediaProviderResults').createIndex(
        { sha256: 1, provider: 1, checkedAt: -1 },
        { name: 'media_provider_hash_history' }
      ),
      this.db.collection('reports').createIndex({ postId: 1, status: 1 }, { name: 'report_post_status' }),
      this.db.collection('reports').createIndex(
        { openDedupeKey: 1 },
        { unique: true, sparse: true, name: 'open_report_deduplication' }
      ),
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
      this.db.collection('rateLimitBuckets').createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: 0, name: 'rate_limit_expiration' }
      ),
      this.db.collection('postingAuthorizations').createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: 0, name: 'posting_authorization_expiration' }
      ),
      this.db.collection('mutationJournalEntries').createIndex(
        { mutationId: 1, index: 1 },
        { unique: true, name: 'mutation_entry_order' }
      )
    ]);
  }

  async readDocuments(session) {
    const names = [
      'metadata', 'customization', 'boards', 'threads', 'posts', 'media', 'mediaHashBans',
      'mediaDecisions', 'mediaProviderResults', 'reports', 'bans', 'appeals', 'trash',
      'revisions', 'staff', 'moderationLog'
    ];
    const values = await Promise.all(names.map(name => this.db.collection(name).find({}, { session }).toArray()));
    return Object.fromEntries(names.map((name, index) => [name, values[index]]));
  }

  async readFromMongo(session) {
    const documents = await this.readDocuments(session);
    return normalizeData(dataFromDocuments(documents), this.maximumCites, this.defaultBoard);
  }

  async publicBoards(session) {
    const documents = await this.db.collection('boards')
      .find({ enabled: { $ne: false } }, { session })
      .sort({ order: 1, uri: 1 })
      .toArray();
    return documents.map(withoutId);
  }

  async boardByUri(uri, options = {}) {
    const document = await this.db.collection('boards').findOne({
      uri: String(uri || '').trim().toLowerCase(),
      ...(options.includeDisabled ? {} : { enabled: { $ne: false } })
    }, { session: options.session });
    return withoutId(document) || null;
  }

  async boardById(id, options = {}) {
    const document = await this.db.collection('boards').findOne({
      _id: String(id || ''),
      ...(options.includeDisabled ? {} : { enabled: { $ne: false } })
    }, { session: options.session });
    return withoutId(document) || null;
  }

  async customization() {
    const document = await this.db.collection('customization').findOne({ _id: 'site' });
    return withoutId(document) || {};
  }

  async moderationBoards(staff) {
    const filter = staff?.scope === 'boards'
      ? { _id: { $in: (staff.boardIds || []).map(String) } }
      : {};
    const documents = await this.db.collection('boards').find(filter)
      .sort({ order: 1, uri: 1 })
      .toArray();
    return documents.map(withoutId);
  }

  async readModerationQueue(queue, options = {}, staff) {
    const specs = {
      reports: { collection: 'reports', field: 'reports', sort: { updatedAt: -1, _id: -1 } },
      appeals: { collection: 'appeals', field: 'appeals', sort: { updatedAt: -1, _id: -1 } },
      trash: { collection: 'trash', field: 'trash', sort: { deletedAt: -1, _id: -1 } },
      revisions: { collection: 'revisions', field: 'revisions', sort: { editedAt: -1, _id: -1 } }
    };
    const spec = specs[queue];
    if (!spec) throw new Error('Unknown moderation queue.');
    const limit = Math.min(100, Math.max(1, Number(options.limit) || 50));
    const requestedPage = Number.parseInt(options.page, 10) || 1;
    const boards = await this.moderationBoards(staff);
    const allowedBoardIds = boards.map(board => board.id);
    const match = staff?.scope === 'boards' ? { boardId: { $in: allowedBoardIds } } : {};
    if (queue === 'reports') {
      if (['open', 'closed'].includes(options.status)) match.status = options.status;
      if (allowedBoardIds.includes(String(options.boardId || ''))) match.boardId = String(options.boardId);
    } else if (queue === 'appeals' && ['open', 'accepted', 'denied'].includes(options.status)) {
      match.status = options.status;
    } else if (queue === 'revisions') {
      const postId = Number(options.postId);
      if (Number.isSafeInteger(postId) && postId > 0) match.postId = postId;
    }
    const collection = this.db.collection(spec.collection);
    const total = await collection.countDocuments(match);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(totalPages, Math.max(1, requestedPage));
    const documents = await collection.find(match)
      .sort(spec.sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray();
    const data = {
      boards,
      threads: [],
      media: [],
      mediaHashBans: [],
      mediaDecisions: [],
      mediaProviderResults: [],
      reports: [],
      bans: [],
      appeals: [],
      trash: [],
      revisions: [],
      staff: [],
      moderationLog: []
    };
    data[spec.field] = documents.map(withoutId);
    if (queue === 'reports') {
      const threadIds = [...new Set(documents.map(document => Number(document.threadId)).filter(Number.isSafeInteger))];
      const [threadDocuments, postDocuments] = await Promise.all([
        threadIds.length
          ? this.db.collection('threads').find({ _id: { $in: threadIds } }, { projection: PUBLIC_POST_PROJECTION }).toArray()
          : [],
        this.threadDocuments(threadIds)
      ]);
      data.threads = hydrateThreads(threadDocuments, postDocuments);
    } else if (queue === 'appeals') {
      const sanctionIds = [...new Set(documents.map(document => String(document.sanctionId || '')).filter(Boolean))];
      const sanctions = sanctionIds.length
        ? await this.db.collection('bans').find({ _id: { $in: sanctionIds } }).toArray()
        : [];
      data.bans = sanctions.map(withoutId);
    }
    return { data, pageInfo: { queue, page, totalPages, total } };
  }

  async updateReportStatus(reportId, fields, context = {}) {
    const actor = context.actor || {};
    const scope = actor.scope === 'boards'
      ? { boardId: { $in: (actor.boardIds || []).map(String) } }
      : {};
    const expectedStatus = fields.action === 'reopened' ? 'closed' : 'open';
    const nextStatus = fields.action === 'reopened' ? 'open' : 'closed';
    const now = Date.now();
    const history = {
      action: fields.action,
      resolution: fields.resolution || '',
      note: fields.note || '',
      actorId: String(actor.id || ''),
      actorName: String(actor.username || ''),
      createdAt: now
    };
    const report = await this.withTransaction(async session => {
      const existing = await this.db.collection('reports').findOne({
        _id: String(reportId || ''),
        ...scope
      }, { session });
      if (!existing) {
        const error = new Error('Report not found.');
        error.status = 404;
        throw error;
      }
      if (existing.status !== expectedStatus) {
        const error = new Error(fields.action === 'reopened' ? 'Report is already open.' : 'Report is already closed.');
        error.status = 409;
        throw error;
      }
      const result = await this.db.collection('reports').findOneAndUpdate(
        { _id: existing._id, status: expectedStatus, ...scope },
        {
          $set: {
            status: nextStatus,
            updatedAt: now,
            closedAt: nextStatus === 'closed' ? now : 0,
            resolution: nextStatus === 'closed' ? fields.resolution : '',
            moderatorNote: nextStatus === 'closed' ? fields.note : ''
          },
          $push: { history: { $each: [history], $slice: -50 } }
        },
        { returnDocument: 'after', session }
      );
      const updated = result?.value || result;
      if (!updated) {
        const error = new Error('Report changed while this action was being applied.');
        error.status = 409;
        throw error;
      }
      const action = fields.action === 'reopened' ? 'report-reopen' : 'report-resolve';
      const detail = fields.action === 'reopened'
        ? `Reopened report for No.${existing.postId}`
        : `Resolved report for No.${existing.postId} as ${fields.resolution}`;
      const requestId = /^[A-Za-z0-9._-]{8,100}$/.test(String(context.requestId || ''))
        ? String(context.requestId)
        : '';
      const actionId = /^[A-Za-z0-9._-]{8,100}$/.test(String(context.actionId || ''))
        ? String(context.actionId)
        : crypto.randomUUID();
      await this.db.collection('moderationLog').insertOne({
        _id: actionId,
        id: actionId,
        actionId,
        requestId,
        action,
        detail,
        actorId: String(actor.id || ''),
        actorName: String(actor.username || actor.displayName || ''),
        boardId: String(existing.boardId || ''),
        createdAt: now
      }, { session });
      return withoutId(updated);
    });
    this.markCacheDirty();
    return report;
  }

  async siteMetadata() {
    const document = await this.db.collection('metadata').findOne(
      { _id: 'state' },
      { projection: { meta: 1, version: 1, lastId: 1 } }
    );
    return document ? { meta: document.meta || {}, version: document.version, lastId: document.lastId } : null;
  }

  async createReport(fields) {
    const target = await this.db.collection('posts').findOne(
      { _id: Number(fields.postId) },
      { projection: { id: 1, threadId: 1, boardId: 1 } }
    );
    if (!target) {
      const error = new Error('Post not found.');
      error.status = 404;
      throw error;
    }
    const now = Date.now();
    const report = {
      id: crypto.randomUUID(),
      postId: Number(target.id),
      threadId: Number(target.threadId),
      boardId: String(target.boardId || ''),
      category: fields.category,
      reason: fields.reason,
      reporterKey: fields.reporterKey,
      ...(fields.reporterKey ? {
        openDedupeKey: crypto.createHash('sha256')
          .update(`${target.id}:${fields.reporterKey}`)
          .digest('hex')
      } : {}),
      status: 'open',
      createdAt: now,
      updatedAt: now,
      closedAt: 0,
      resolution: '',
      moderatorNote: '',
      history: []
    };
    try {
      await this.db.collection('reports').insertOne({ _id: report.id, ...report });
    } catch (error) {
      if (error?.code === 11000) {
        const conflict = new Error('That report has already been submitted.');
        conflict.status = 409;
        throw conflict;
      }
      throw error;
    }
    this.markCacheDirty();
    return structuredClone(report);
  }

  async staffById(id, options = {}) {
    const document = await this.db.collection('staff').findOne(
      { _id: String(id || '') },
      options.includePassword ? {} : { projection: {
        passwordHash: 0,
        mfaSecret: 0,
        mfaRecoveryHashes: 0,
        mfaPendingSecret: 0,
        mfaPendingRecoveryHashes: 0,
        mfaLastCounter: 0
      } }
    );
    return withoutId(document) || null;
  }

  async staffByUsername(username) {
    const document = await this.db.collection('staff').findOne({ username: String(username || '') });
    return withoutId(document) || null;
  }

  async recordStaffLogin(account, authentication = {}) {
    const now = Date.now();
    const filter = {
      _id: String(account.id || ''),
      enabled: { $ne: false },
      passwordHash: account.passwordHash
    };
    const update = { $set: { lastLoginAt: now } };
    if (Number.isSafeInteger(authentication.totpCounter)) {
      filter.$or = [
        { mfaLastCounter: { $lt: authentication.totpCounter } },
        { mfaLastCounter: { $exists: false } }
      ];
      update.$set.mfaLastCounter = authentication.totpCounter;
    } else if (authentication.recoveryHash) {
      filter.mfaRecoveryHashes = authentication.recoveryHash;
      update.$pull = { mfaRecoveryHashes: authentication.recoveryHash };
    } else if (account.mfaEnabled === true) {
      return null;
    }
    const result = await this.db.collection('staff').findOneAndUpdate(
      filter,
      update,
      { returnDocument: 'after', projection: {
        passwordHash: 0,
        mfaSecret: 0,
        mfaRecoveryHashes: 0,
        mfaPendingSecret: 0,
        mfaPendingRecoveryHashes: 0,
        mfaLastCounter: 0
      } }
    );
    return withoutId(result?.value || result) || null;
  }

  async threadDocuments(threadIds, session) {
    const ids = [...new Set(threadIds.map(Number).filter(Number.isSafeInteger))];
    if (!ids.length) return [];
    return this.db.collection('posts').find({
      threadId: { $in: ids },
      isThread: false
    }, { projection: PUBLIC_POST_PROJECTION, session }).sort({ id: 1 }).toArray();
  }

  async publicDataForThreads(threadDocuments, session) {
    const replies = await this.threadDocuments(threadDocuments.map(document => document.id), session);
    return {
      boards: await this.publicBoards(session),
      threads: hydrateThreads(threadDocuments, replies),
      customization: {},
      media: [],
      reports: [],
      bans: [],
      appeals: [],
      trash: [],
      revisions: [],
      staff: [],
      moderationLog: []
    };
  }

  async boardStats(boardId, session) {
    const rows = await this.db.collection('threads').aggregate([
      { $match: { boardId: String(boardId || ''), archived: { $ne: true } } },
      {
        $lookup: {
          from: 'posts',
          let: { thread: '$id' },
          pipeline: [
            { $match: { $expr: { $and: [
              { $eq: ['$threadId', '$$thread'] },
              { $eq: ['$isThread', false] }
            ] } } },
            { $count: 'count' }
          ],
          as: 'replyTotal'
        }
      },
      { $project: { replies: { $ifNull: [{ $arrayElemAt: ['$replyTotal.count', 0] }, 0] } } },
      { $group: { _id: null, threadCount: { $sum: 1 }, replyCount: { $sum: '$replies' } } }
    ], { session }).toArray();
    const threadCount = Number(rows[0]?.threadCount) || 0;
    const replyCount = Number(rows[0]?.replyCount) || 0;
    return {
      threadCount,
      replyCount,
      postCount: threadCount + replyCount,
      line: `${threadCount} thread${threadCount === 1 ? '' : 's'} · ${replyCount} repl${replyCount === 1 ? 'y' : 'ies'}`
    };
  }

  async siteStats() {
    const rows = await this.db.collection('threads').aggregate([
      { $match: { archived: { $ne: true } } },
      {
        $lookup: {
          from: 'posts',
          let: { thread: '$id' },
          pipeline: [
            { $match: { $expr: { $and: [
              { $eq: ['$threadId', '$$thread'] },
              { $eq: ['$isThread', false] }
            ] } } },
            { $count: 'count' }
          ],
          as: 'replyTotal'
        }
      },
      { $project: { replies: { $ifNull: [{ $arrayElemAt: ['$replyTotal.count', 0] }, 0] } } },
      { $group: { _id: null, threadCount: { $sum: 1 }, replyCount: { $sum: '$replies' } } }
    ]).toArray();
    const threadCount = Number(rows[0]?.threadCount) || 0;
    const replyCount = Number(rows[0]?.replyCount) || 0;
    const postCount = threadCount + replyCount;
    const boardCount = await this.db.collection('boards').countDocuments({ enabled: { $ne: false } });
    let activeContent = 0;
    try {
      activeContent = (await this.db.collection('media').aggregate([
        { $match: { state: 'approved', refCount: { $gt: 0 } } },
        { $group: { _id: null, bytes: { $sum: '$bytes' } } }
      ]).toArray())[0]?.bytes || 0;
    } catch {
      activeContent = 0;
    }
    return {
      threadCount,
      replyCount,
      postCount,
      boardCount,
      activeContent,
      activeContentText: formatBytes(activeContent),
      line: `${postCount} post${postCount === 1 ? '' : 's'} · ${boardCount} board${boardCount === 1 ? '' : 's'}`
    };
  }

  async readThread(threadId, boardId = '') {
    const id = Number.parseInt(threadId, 10);
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const document = await this.db.collection('threads').findOne({
      _id: id,
      ...(boardId ? { boardId: String(boardId) } : {})
    }, { projection: PUBLIC_POST_PROJECTION });
    if (!document) return null;
    const data = await this.publicDataForThreads([document]);
    const thread = data.threads[0];
    const board = data.boards.find(candidate => candidate.id === thread.boardId) || null;
    if (!board) return null;
    return { data, thread, board, stats: await this.boardStats(board.id) };
  }

  async readBoardPage(boardId, page = 1, perPage = 10) {
    const currentPage = Number.parseInt(page, 10);
    if (!Number.isSafeInteger(currentPage) || currentPage < 1) return null;
    const match = { boardId: String(boardId || ''), archived: { $ne: true } };
    const totalThreads = await this.db.collection('threads').countDocuments(match);
    const totalPages = Math.max(1, Math.ceil(totalThreads / perPage));
    if (currentPage > totalPages) return null;
    const documents = await this.db.collection('threads').find(match, { projection: PUBLIC_POST_PROJECTION })
      .sort({ sticky: -1, bumpedAt: -1, id: -1 })
      .skip((currentPage - 1) * perPage)
      .limit(perPage)
      .toArray();
    const data = await this.publicDataForThreads(documents);
    const board = data.boards.find(candidate => candidate.id === String(boardId || '')) || null;
    if (!board) return null;
    return {
      data,
      board,
      threads: data.threads,
      allThreads: data.threads,
      page: currentPage,
      totalPages,
      stats: await this.boardStats(board.id)
    };
  }

  async readCatalog(boardId, options = {}) {
    const limit = Math.min(250, Math.max(1, Number(options.limit) || 100));
    const page = Math.max(1, Number.parseInt(options.page, 10) || 1);
    const match = { boardId: String(boardId || ''), archived: { $ne: true } };
    const totalThreads = await this.db.collection('threads').countDocuments(match);
    const documents = await this.db.collection('threads').find(match, { projection: PUBLIC_POST_PROJECTION })
      .sort({ sticky: -1, bumpedAt: -1, id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray();
    const data = await this.publicDataForThreads(documents);
    return {
      data,
      threads: data.threads,
      page,
      totalPages: Math.max(1, Math.ceil(totalThreads / limit)),
      stats: await this.boardStats(boardId)
    };
  }

  async readArchive(boardId, options = {}) {
    const limit = Math.min(250, Math.max(1, Number(options.limit) || 100));
    const page = Math.max(1, Number.parseInt(options.page, 10) || 1);
    const match = { boardId: String(boardId || ''), archived: true };
    const totalThreads = await this.db.collection('threads').countDocuments(match);
    const documents = await this.db.collection('threads').find(match, { projection: PUBLIC_POST_PROJECTION })
      .sort({ archivedAt: -1, id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray();
    const data = await this.publicDataForThreads(documents);
    return {
      data,
      threads: data.threads,
      page,
      totalPages: Math.max(1, Math.ceil(totalThreads / limit)),
      stats: await this.boardStats(boardId)
    };
  }

  async readOverboard(options = {}) {
    const limit = Math.min(50, Math.max(1, Number(options.limit) || 20));
    const rawPage = options.page === undefined || options.page === '' ? '1' : String(options.page);
    if (!/^[1-9]\d*$/.test(rawPage)) return null;
    const currentPage = Number(rawPage);
    if (!Number.isSafeInteger(currentPage)) return null;
    const tag = String(options.tag || '');
    const boards = (await this.publicBoards()).filter(board =>
      (options.sfw !== true || board.sfw !== false)
      && (!tag || (Array.isArray(board.tags) && board.tags.includes(tag))));
    const boardMap = new Map(boards.map(board => [board.id, board]));
    const match = { boardId: { $in: [...boardMap.keys()] }, archived: { $ne: true } };
    const totalThreads = await this.db.collection('threads').countDocuments(match);
    const totalPages = Math.max(1, Math.ceil(totalThreads / limit));
    if (currentPage > totalPages) return null;
    const documents = await this.db.collection('threads')
      .find(match, { projection: PUBLIC_POST_PROJECTION })
      .sort({ createdAt: -1, id: -1 })
      .skip((currentPage - 1) * limit)
      .limit(limit)
      .toArray();
    const data = await this.publicDataForThreads(documents);
    const attachments = documents.flatMap(document => Array.isArray(document.attachments)
      ? document.attachments
      : (document.image ? [document] : []));
    const assetIds = [...new Set(attachments.map(attachment => String(attachment.assetId || '')).filter(Boolean))];
    const paths = [...new Set(attachments.flatMap(attachment => [attachment.image, attachment.thumbnail]).filter(Boolean))];
    if (assetIds.length || paths.length) {
      const mediaDocuments = await this.db.collection('media').find({
        state: 'approved',
        refCount: { $gt: 0 },
        $or: [
          ...(assetIds.length ? [{ _id: { $in: assetIds } }] : []),
          ...(paths.length ? [{ path: { $in: paths } }, { thumbnail: { $in: paths } }] : [])
        ]
      }).toArray();
      data.media = mediaDocuments.map(withoutId);
    }
    return {
      data,
      entries: data.threads.flatMap(thread => {
        const board = boardMap.get(thread.boardId);
        return board ? [{ post: thread, thread, threadId: thread.id, board }] : [];
      }),
      page: currentPage,
      totalPages
    };
  }

  async approvedMedia(filename) {
    const expected = `src/${String(filename || '')}`;
    const document = await this.db.collection('media').findOne({
      state: 'approved',
      refCount: { $gt: 0 },
      $or: [{ path: expected }, { thumbnail: expected }]
    });
    return withoutId(document) || null;
  }

  async findMediaHashBan(hashes, boardId) {
    const candidates = [...new Set((Array.isArray(hashes) ? hashes : [hashes])
      .map(value => String(value || '').toLowerCase())
      .filter(value => /^[a-f0-9]{64}$/.test(value)))];
    if (!candidates.length) return null;
    const document = await this.db.collection('mediaHashBans').findOne({
      active: { $ne: false },
      sha256: { $in: candidates },
      $or: [{ scope: 'global' }, { scope: 'board', boardId: String(boardId || '') }]
    });
    return withoutId(document) || null;
  }

  async insertMediaDecision(decision, session) {
    await this.db.collection('mediaDecisions').insertOne(
      { _id: decision.id, ...decision },
      { session }
    );
    this.markCacheDirty();
    return structuredClone(decision);
  }

  async insertMediaProviderResult(result, session) {
    await this.db.collection('mediaProviderResults').insertOne(
      { _id: result.id, ...result },
      { session }
    );
    this.markCacheDirty();
    return structuredClone(result);
  }

  async recordAutomatedMediaRejection(fields) {
    let value;
    await this.withTransaction(async session => {
      const now = Date.now();
      const sha256 = String(fields.sha256 || '').toLowerCase();
      const hashBanId = crypto.randomUUID();
      const hashBanResult = await this.db.collection('mediaHashBans').findOneAndUpdate(
        { sha256, scope: 'global', boardId: '' },
        {
          $set: { active: true, updatedAt: now },
          $setOnInsert: {
            _id: hashBanId,
            id: hashBanId,
            sha256,
            scope: 'global',
            boardId: '',
            reason: 'Matched configured media safety provider.',
            moderatorNote: `Provider: ${String(fields.provider || '').slice(0, 80)}`,
            sourceSanctionId: '',
            createdAt: now,
            createdById: 'system',
            createdByName: 'media-safety'
          }
        },
        { upsert: true, returnDocument: 'after', session }
      );
      const decision = {
        id: crypto.randomUUID(),
        sha256,
        contentSha256: String(fields.contentSha256 || '').toLowerCase(),
        boardId: String(fields.boardId || ''),
        decision: 'rejected',
        reasonCode: String(fields.reasonCode || 'provider-match').replace(/[^a-z0-9:_-]/gi, '').slice(0, 80),
        reason: 'Matched configured media safety provider.',
        provider: String(fields.provider || '').replace(/[^a-z0-9._-]/gi, '').slice(0, 80),
        providerReference: String(fields.providerReference || '').replace(/\0/g, '').trim().slice(0, 200),
        actorId: 'system',
        actorName: 'media-safety',
        createdAt: now
      };
      await this.insertMediaDecision(decision, session);
      const logId = crypto.randomUUID();
      await this.db.collection('moderationLog').insertOne({
        _id: logId,
        id: logId,
        action: 'media-provider-reject',
        detail: `Rejected media hash ${sha256}`,
        actorId: 'system',
        actorName: 'media-safety',
        boardId: decision.boardId,
        createdAt: now
      }, { session });
      value = { hashBan: withoutId(hashBanResult?.value || hashBanResult), decision };
    });
    this.markCacheDirty();
    return value;
  }

  async latestPublicPosts(limit = 50) {
    const documents = await this.db.collection('posts').aggregate([
      { $lookup: { from: 'threads', localField: 'threadId', foreignField: '_id', as: 'thread' } },
      { $unwind: '$thread' },
      { $match: { 'thread.archived': { $ne: true } } },
      { $sort: { createdAt: -1, id: -1 } },
      { $limit: Math.min(500, Math.max(1, Number(limit) || 50)) },
      { $project: { passwordHash: 0, posterKey: 0, 'thread.passwordHash': 0, 'thread.posterKey': 0 } }
    ]).toArray();
    const boards = await this.publicBoards();
    const boardMap = new Map(boards.map(board => [board.id, board]));
    return documents.flatMap(document => {
      const board = boardMap.get(document.thread.boardId);
      if (!board) return [];
      const { thread: joinedThread, ...postDocument } = document;
      return [{
        post: publicPost(postDocument),
        threadId: Number(document.threadId),
        thread: publicPost(joinedThread),
        board
      }];
    });
  }

  async readHome() {
    const [boards, stats, latestPosts] = await Promise.all([
      this.publicBoards(),
      this.siteStats(),
      this.latestPublicPosts(200)
    ]);
    return {
      data: { boards, threads: [], customization: {} },
      boards,
      stats,
      latestPosts: latestPosts.slice(0, 30),
      latestImageCandidates: latestPosts
    };
  }

  async searchPosts(query, limit = 100) {
    const term = String(query || '').trim().slice(0, 100);
    if (!term) return { query: '', results: [], data: { boards: await this.publicBoards(), threads: [] } };
    const documents = await this.db.collection('posts').find(
      { $text: { $search: term } },
      { projection: PUBLIC_POST_PROJECTION }
    ).sort({ score: { $meta: 'textScore' }, createdAt: -1 }).limit(Math.min(100, limit)).toArray();
    const threadIds = [...new Set(documents.map(document => Number(document.threadId)))];
    const threadDocuments = await this.db.collection('threads')
      .find({ _id: { $in: threadIds } }, { projection: PUBLIC_POST_PROJECTION })
      .toArray();
    const data = await this.publicDataForThreads(threadDocuments);
    const locations = new Map();
    for (const thread of data.threads) {
      locations.set(thread.id, { post: thread, threadId: thread.id, thread });
      for (const reply of thread.replies) locations.set(reply.id, { post: reply, threadId: thread.id, thread });
    }
    return { query: term, results: documents.map(document => locations.get(document.id)).filter(Boolean), data };
  }

  read() {
    if (!this.cache) throw new Error('MongoStore is not ready. Await store.ready before reading.');
    return structuredClone(this.cache);
  }

  markCacheDirty() {
    this.cacheDirty = true;
  }

  async refreshCache() {
    this.cache = await this.readFromMongo();
    this.cacheDirty = false;
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
      if (!this.cache) {
        await this.withTransaction(session => this.persist(saved, session));
      } else if (this.supportsTransactions) {
        await this.withTransaction(async session => {
          const before = await this.readFromMongo(session);
          const changes = documentChanges(documentsFromData(before), documentsFromData(saved));
          await this.applyChanges(changes, session);
        });
      } else {
        const before = await this.readFromMongo();
        const changes = documentChanges(documentsFromData(before), documentsFromData(saved));
        await this.journaledChanges(changes);
      }
      this.cache = saved;
      this.cacheDirty = false;
      return structuredClone(saved);
    });
  }

  update(mutator) {
    return this.enqueue(async () => {
      if (!this.cache) throw new Error('MongoStore is not ready. Await store.ready before updating.');
      let result;
      let saved;
      if (this.supportsTransactions) {
        // Keep the snapshot read and writes in one transaction. MongoDB will
        // retry the callback on a transient conflict instead of allowing a
        // stale application instance to silently overwrite another instance.
        await this.withTransaction(async session => {
          const before = await this.readFromMongo(session);
          const working = structuredClone(before);
          result = await mutator(working);
          saved = normalizeData(working, this.maximumCites, this.defaultBoard);
          const changes = documentChanges(documentsFromData(before), documentsFromData(saved));
          await this.applyChanges(changes, session);
        });
      } else {
        const before = await this.readFromMongo();
        const working = structuredClone(before);
        result = await mutator(working);
        saved = normalizeData(working, this.maximumCites, this.defaultBoard);
        const changes = documentChanges(documentsFromData(before), documentsFromData(saved));
        await this.journaledChanges(changes);
      }
      this.cache = saved;
      this.cacheDirty = false;
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

  async healthCheck() {
    await this.ready;
    const result = await this.db.command({ ping: 1 });
    return Number(result?.ok) === 1;
  }

  async close() {
    await this.queue;
    if (this.ownsClient) await this.client.close();
  }
}

module.exports = {
  MongoStore,
  dataFromDocuments,
  documentChanges,
  documentsFromData,
  hydrateThreads
};
