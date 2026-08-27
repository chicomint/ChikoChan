'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MongoStore,
  dataFromDocuments,
  documentChanges,
  documentsFromData,
  hydrateThreads
} = require('../lib/mongo-store');
const { MongoPostRepository } = require('../lib/mongo-post-repository');
const { createDefaultBoard, normalizeData } = require('../lib/store');

const config = {
  board: { uri: 'chiko', title: 'ChikoChan' },
  site: { title: 'ChikoChan', description: 'Test' }
};

test('Mongo documents preserve the JsonStore data contract', () => {
  const input = normalizeData({
    lastId: 2,
    boards: [{
      id: 'chiko',
      uri: 'chiko',
      name: 'ChikoChan',
      createdAt: 50,
      rules: [{ id: 'rule-one', text: 'Stay on topic.', createdAt: 60, updatedAt: 60 }]
    }],
    staff: [{
      id: 'staff-one',
      username: 'test.mod',
      displayName: 'Test Moderator',
      passwordHash: 'scrypt$BwcHBwcHBwcHBwcHBwcHBw$GKYWtQJHPAUWMYDDM64Z3uAtYBUxFuquueA16wVbm9M',
      role: 'moderator',
      scope: 'boards',
      boardIds: ['chiko'],
      enabled: true,
      sessionVersion: 2,
      createdAt: 75,
      updatedAt: 80
    }],
    reports: [{
      id: 'report-one',
      postId: 1,
      threadId: 1,
      boardId: 'chiko',
      category: 'spam',
      reason: 'Test report',
      reporterKey: 'A'.repeat(43),
      status: 'open',
      createdAt: 150,
      history: []
    }],
    trash: [{
      id: 'trash-one',
      kind: 'reply',
      boardId: 'chiko',
      threadId: 1,
      postId: 3,
      post: { id: 3, name: 'Removed', comment: 'Trash snapshot', createdAt: 175 },
      deletedAt: 180,
      purgeAt: 300,
      deletedByName: 'test.mod'
    }],
    revisions: [{
      id: 'revision-one',
      postId: 2,
      threadId: 1,
      boardId: 'chiko',
      before: { name: 'Reply', comment: 'before' },
      after: { name: 'Reply', comment: '>>1' },
      reason: 'Correction',
      editedAt: 190,
      editedByName: 'test.mod'
    }],
    threads: [{
      id: 1,
      boardId: 'chiko',
      name: 'OP',
      comment: 'opening',
      createdAt: 100,
      bumpedAt: 200,
      replies: [{ id: 2, name: 'Reply', comment: '>>1', fortune: 'Excellent Luck', createdAt: 200 }]
    }]
  }, 45, createDefaultBoard(config));

  const documents = documentsFromData(input);
  assert.equal(documents.posts.length, 2);
  assert.equal(documents.customization.length, 1);
  assert.deepEqual(documents.posts.map(post => post.id), [1, 2]);
  assert.equal(documents.posts[1].boardId, 'chiko');
  assert.equal(documents.posts[1].threadId, 1);
  assert.equal(documents.posts[1].isThread, false);
  assert.equal(documents.posts[1].fortune, 'Excellent Luck');
  assert.equal(documents.boards[0].rules[0].text, 'Stay on topic.');
  assert.equal(documents.staff[0].username, 'test.mod');
  assert.equal(documents.staff[0].passwordHash.startsWith('scrypt$'), true);
  assert.equal(documents.reports[0].boardId, 'chiko');
  assert.equal(documents.trash[0].post.id, 3);
  assert.equal(documents.revisions[0].postId, 2);

  const output = normalizeData(dataFromDocuments(documents), 45, createDefaultBoard(config));
  assert.deepEqual(output, input);
});

test('Mongo mutations only write changed documents', () => {
  const defaultBoard = createDefaultBoard(config);
  const before = normalizeData({
    lastId: 1,
    boards: [defaultBoard],
    threads: [{
      id: 1,
      boardId: 'chiko',
      name: 'OP',
      comment: 'opening',
      createdAt: 100,
      bumpedAt: 100,
      replies: []
    }]
  }, 45, defaultBoard);
  const after = structuredClone(before);
  after.lastId = 2;
  after.threads[0].bumpedAt = 200;
  after.threads[0].replies.push({
    id: 2,
    name: 'Reply',
    trip: '',
    comment: '>>1',
    createdAt: 200,
    references: [],
    backlinks: [],
    spoiler: false
  });

  const normalizedAfter = normalizeData(after, 45, defaultBoard);
  const changes = documentChanges(documentsFromData(before), documentsFromData(normalizedAfter));
  const changedCollections = changes.map(change => change.collection);

  assert.deepEqual(changedCollections.sort(), ['metadata', 'posts', 'posts', 'threads']);
  assert.equal(changes.some(change => change.collection === 'boards'), false);
  assert.equal(changes.some(change => change.collection === 'reports'), false);
  assert.equal(changes.find(change => change.after?._id === 2)?.before, null);
});

test('Mongo document diff represents removals without replacing unrelated collections', () => {
  const before = {
    boards: [{ _id: 'chiko', id: 'chiko' }],
    reports: [{ _id: 'one', reason: 'first' }, { _id: 'two', reason: 'second' }]
  };
  const after = {
    boards: [{ _id: 'chiko', id: 'chiko' }],
    reports: [{ _id: 'two', reason: 'updated' }]
  };
  const changes = documentChanges(before, after);

  assert.equal(changes.length, 2);
  assert.deepEqual(changes.map(change => change.collection), ['reports', 'reports']);
  assert.deepEqual(changes.find(change => change.before?._id === 'one').after, null);
  assert.equal(changes.find(change => change.after?._id === 'two').before.reason, 'second');
});

test('targeted thread hydration joins only the requested reply documents and strips credentials', () => {
  const threads = hydrateThreads([{
    _id: 10,
    id: 10,
    boardId: 'chiko',
    comment: 'Opening',
    passwordHash: 'private',
    posterKey: 'private-poster'
  }], [{
    _id: 12,
    id: 12,
    boardId: 'chiko',
    threadId: 10,
    isThread: false,
    comment: 'Second',
    passwordHash: 'private'
  }, {
    _id: 11,
    id: 11,
    boardId: 'chiko',
    threadId: 10,
    isThread: false,
    comment: 'First'
  }]);
  assert.deepEqual(threads[0].replies.map(reply => reply.id), [11, 12]);
  assert.equal(threads[0].boardId, 'chiko');
  assert.equal(Object.hasOwn(threads[0], 'passwordHash'), false);
  assert.equal(Object.hasOwn(threads[0], 'posterKey'), false);
  assert.equal(Object.hasOwn(threads[0].replies[1], 'passwordHash'), false);
});

test('Mongo overboard loads only approved referenced media for public previews', async () => {
  const calls = [];
  const thread = {
    _id: 10,
    id: 10,
    boardId: 'chiko',
    comment: 'Opening',
    createdAt: 100,
    attachments: [{ assetId: 'asset-1', image: 'src/image.png', thumbnail: 'src/thumb.png' }]
  };
  const store = Object.create(MongoStore.prototype);
  store.publicBoards = async () => [{ id: 'chiko', uri: 'chiko', enabled: true, tags: ['safe'], sfw: true }];
  store.publicDataForThreads = async documents => ({
    boards: await store.publicBoards(),
    threads: hydrateThreads(documents),
    media: []
  });
  store.db = {
    collection(name) {
      if (name === 'threads') {
        return {
          async countDocuments(match) {
            calls.push({ name, operation: 'count', match });
            return 1;
          },
          find(match) {
            calls.push({ name, operation: 'find', match });
            return {
              sort() { return this; },
              skip() { return this; },
              limit() { return this; },
              async toArray() { return [thread]; }
            };
          }
        };
      }
      assert.equal(name, 'media');
      return {
        find(match) {
          calls.push({ name, operation: 'find', match });
          return {
            async toArray() {
              return [{ _id: 'asset-1', id: 'asset-1', path: 'src/image.png', state: 'approved', refCount: 1 }];
            }
          };
        }
      };
    }
  };

  const view = await store.readOverboard({ page: '1', limit: 20, sfw: true, tag: 'safe' });
  assert.equal(view.entries.length, 1);
  assert.equal(view.data.media.length, 1);
  assert.equal(view.data.media[0].state, 'approved');
  const mediaCall = calls.find(call => call.name === 'media');
  assert.deepEqual(mediaCall.match, {
    state: 'approved',
    refCount: { $gt: 0 },
    $or: [
      { _id: { $in: ['asset-1'] } },
      { path: { $in: ['src/image.png', 'src/thumb.png'] } },
      { thumbnail: { $in: ['src/image.png', 'src/thumb.png'] } }
    ]
  });
});

test('Mongo moderation queues paginate and enforce board scope in the repository query', async () => {
  const calls = [];
  const report = {
    _id: 'report-3',
    id: 'report-3',
    postId: 12,
    threadId: 10,
    boardId: 'chiko',
    reason: 'Scoped fixture',
    status: 'open',
    createdAt: 300,
    updatedAt: 300,
    history: []
  };
  const thread = { _id: 10, id: 10, boardId: 'chiko', comment: 'Opening', createdAt: 100 };
  const reply = {
    _id: 12,
    id: 12,
    boardId: 'chiko',
    threadId: 10,
    isThread: false,
    comment: 'Reported reply',
    createdAt: 200
  };
  const cursor = (name, documents) => ({
    sort(value) { calls.push({ name, operation: 'sort', value }); return this; },
    skip(value) { calls.push({ name, operation: 'skip', value }); return this; },
    limit(value) { calls.push({ name, operation: 'limit', value }); return this; },
    async toArray() { return documents; }
  });
  const store = Object.create(MongoStore.prototype);
  store.moderationBoards = async () => [{ id: 'chiko', uri: 'chiko', name: 'ChikoChan', enabled: true }];
  store.db = {
    collection(name) {
      if (name === 'reports') {
        return {
          async countDocuments(match) { calls.push({ name, operation: 'count', match }); return 3; },
          find(match) { calls.push({ name, operation: 'find', match }); return cursor(name, [report]); }
        };
      }
      if (name === 'threads') {
        return { find(match) { calls.push({ name, operation: 'find', match }); return cursor(name, [thread]); } };
      }
      assert.equal(name, 'posts');
      return { find(match) { calls.push({ name, operation: 'find', match }); return cursor(name, [reply]); } };
    }
  };

  const view = await store.readModerationQueue('reports', {
    status: 'open',
    boardId: 'chiko',
    page: '2',
    limit: 2
  }, { scope: 'boards', boardIds: ['chiko'] });

  assert.deepEqual(view.pageInfo, { queue: 'reports', page: 2, totalPages: 2, total: 3 });
  assert.deepEqual(view.data.reports.map(item => item.id), ['report-3']);
  assert.equal(view.data.threads[0].boardId, 'chiko');
  assert.deepEqual(view.data.threads[0].replies.map(item => item.id), [12]);
  assert.deepEqual(calls.find(call => call.name === 'reports' && call.operation === 'find').match, {
    boardId: 'chiko',
    status: 'open'
  });
  assert.equal(calls.some(call => call.name === 'reports' && call.operation === 'skip' && call.value === 2), true);
  assert.equal(calls.some(call => call.name === 'reports' && call.operation === 'limit' && call.value === 2), true);
});

test('Mongo report resolution is transactional, board-scoped, and request-correlated', async () => {
  const calls = [];
  const existing = {
    _id: 'report-1',
    id: 'report-1',
    postId: 12,
    boardId: 'chiko',
    status: 'open',
    history: []
  };
  const store = Object.create(MongoStore.prototype);
  store.withTransaction = operation => operation('session-1');
  store.markCacheDirty = () => { store.cacheDirty = true; };
  store.db = {
    collection(name) {
      if (name === 'reports') {
        return {
          async findOne(filter, options) {
            calls.push({ name, operation: 'findOne', filter, options });
            return existing;
          },
          async findOneAndUpdate(filter, update, options) {
            calls.push({ name, operation: 'findOneAndUpdate', filter, update, options });
            return { ...existing, status: 'closed', resolution: 'action-taken' };
          }
        };
      }
      assert.equal(name, 'moderationLog');
      return {
        async insertOne(document, options) {
          calls.push({ name, operation: 'insertOne', document, options });
          return { insertedId: document._id };
        }
      };
    }
  };

  const result = await store.updateReportStatus('report-1', {
    action: 'resolved',
    resolution: 'action-taken',
    note: 'Synthetic resolution'
  }, {
    actor: { id: 'staff-1', username: 'scope.mod', scope: 'boards', boardIds: ['chiko'] },
    requestId: 'request-123',
    actionId: 'action-123'
  });

  assert.equal(result.status, 'closed');
  assert.equal(store.cacheDirty, true);
  assert.deepEqual(calls[0], {
    name: 'reports',
    operation: 'findOne',
    filter: { _id: 'report-1', boardId: { $in: ['chiko'] } },
    options: { session: 'session-1' }
  });
  const update = calls.find(call => call.operation === 'findOneAndUpdate');
  assert.deepEqual(update.filter, { _id: 'report-1', status: 'open', boardId: { $in: ['chiko'] } });
  assert.equal(update.update.$push.history.$slice, -50);
  const log = calls.find(call => call.name === 'moderationLog').document;
  assert.equal(log.requestId, 'request-123');
  assert.equal(log.actionId, 'action-123');
  assert.equal(log.boardId, 'chiko');
  assert.equal(log.actorName, 'scope.mod');
});

test('atomic Mongo counter allocation remains unique across simulated application repositories', async () => {
  let lastId = 200;
  const calls = [];
  const store = {
    db: {
      collection(name) {
        assert.equal(name, 'metadata');
        return {
          async findOneAndUpdate(filter, update, options) {
            calls.push({ filter, update, options });
            lastId += update.$inc.lastId;
            return { _id: 'state', lastId };
          }
        };
      }
    }
  };
  const first = new MongoPostRepository({}, store, {});
  const second = new MongoPostRepository({}, store, {});
  const ids = await Promise.all(Array.from({ length: 100 }, (_, index) =>
    (index % 2 ? first : second).nextPostId(undefined)
  ));
  assert.equal(new Set(ids).size, 100);
  assert.deepEqual([...ids].sort((left, right) => left - right),
    Array.from({ length: 100 }, (_, index) => 201 + index));
  assert.deepEqual(calls[0].filter, { _id: 'state' });
  assert.deepEqual(calls[0].update, { $inc: { lastId: 1 } });
  assert.equal(calls[0].options.returnDocument, 'after');
});

test('Mongo maintenance leases use one atomic expiry-or-owner update', async () => {
  let updateCall;
  let deleteCall;
  const store = Object.create(MongoStore.prototype);
  store.db = {
    collection(name) {
      assert.equal(name, 'jobLeases');
      return {
        async findOneAndUpdate(filter, update, options) {
          updateCall = { filter, update, options };
          return { _id: 'maintenance:core', ownerId: 'owner-a' };
        },
        async deleteOne(filter) {
          deleteCall = filter;
          return { deletedCount: 1 };
        }
      };
    }
  };

  assert.equal(await store.acquireLease('maintenance:core', 'owner-a', 1000, 500), true);
  assert.deepEqual(updateCall, {
    filter: {
      _id: 'maintenance:core',
      $or: [
        { expiresAt: { $lte: new Date(500) } },
        { ownerId: 'owner-a' }
      ]
    },
    update: {
      $set: {
        ownerId: 'owner-a',
        acquiredAt: new Date(500),
        expiresAt: new Date(1500)
      }
    },
    options: { upsert: true, returnDocument: 'after' }
  });
  assert.equal(await store.releaseLease('maintenance:core', 'owner-a'), true);
  assert.deepEqual(deleteCall, { _id: 'maintenance:core', ownerId: 'owner-a' });

  store.db.collection = () => ({
    async findOneAndUpdate() {
      const error = new Error('duplicate lease');
      error.code = 11000;
      throw error;
    }
  });
  assert.equal(await store.acquireLease('maintenance:core', 'owner-b', 1000, 500), false);
});

test('legacy Mongo updates read and write through the same transaction session', async () => {
  const defaultBoard = createDefaultBoard(config);
  const initial = normalizeData({
    lastId: 1,
    boards: [defaultBoard],
    threads: []
  }, 45, defaultBoard);
  const session = { id: 'transaction-session' };
  const calls = [];
  const store = Object.create(MongoStore.prototype);
  store.cache = structuredClone(initial);
  store.supportsTransactions = true;
  store.maximumCites = 45;
  store.defaultBoard = defaultBoard;
  store.enqueue = operation => operation();
  store.withTransaction = operation => operation(session);
  store.readFromMongo = async receivedSession => {
    calls.push(['read', receivedSession]);
    return structuredClone(initial);
  };
  store.applyChanges = async (changes, receivedSession) => {
    calls.push(['write', receivedSession, changes]);
  };

  const transaction = await store.update(data => {
    data.customization.title = 'Updated safely';
    return 'result';
  });

  assert.equal(transaction.result, 'result');
  assert.equal(transaction.data.customization.title, 'Updated safely');
  assert.equal(calls[0][0], 'read');
  assert.equal(calls[0][1], session);
  assert.equal(calls[1][0], 'write');
  assert.equal(calls[1][1], session);
  assert.equal(calls[1][2].some(change => change.collection === 'customization'), true);
});

test('Mongo staff login atomically rejects TOTP replay and consumes recovery hashes', async () => {
  const calls = [];
  const store = Object.create(MongoStore.prototype);
  store.db = {
    collection(name) {
      assert.equal(name, 'staff');
      return {
        async findOneAndUpdate(filter, update, options) {
          calls.push({ filter, update, options });
          return { _id: 'staff-one', id: 'staff-one', username: 'mfa.mod', mfaEnabled: true };
        }
      };
    }
  };
  const account = {
    id: 'staff-one',
    passwordHash: 'synthetic-password-hash',
    mfaEnabled: true
  };

  await store.recordStaffLogin(account, { totpCounter: 123 });
  assert.deepEqual(calls[0].filter.$or, [
    { mfaLastCounter: { $lt: 123 } },
    { mfaLastCounter: { $exists: false } }
  ]);
  assert.equal(calls[0].update.$set.mfaLastCounter, 123);
  assert.equal(calls[0].options.projection.mfaSecret, 0);

  await store.recordStaffLogin(account, { recoveryHash: 'R'.repeat(43) });
  assert.equal(calls[1].filter.mfaRecoveryHashes, 'R'.repeat(43));
  assert.deepEqual(calls[1].update.$pull, { mfaRecoveryHashes: 'R'.repeat(43) });
});
