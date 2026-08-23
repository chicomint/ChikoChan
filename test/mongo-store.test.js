'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { MongoStore, dataFromDocuments, documentChanges, documentsFromData } = require('../lib/mongo-store');
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
