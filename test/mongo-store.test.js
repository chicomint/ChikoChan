'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { dataFromDocuments, documentsFromData } = require('../lib/mongo-store');
const { createDefaultBoard, normalizeData } = require('../lib/store');

const config = {
  board: { uri: 'chiko', title: 'ChikoChan' },
  site: { title: 'ChikoChan', description: 'Test' }
};

test('Mongo documents preserve the JsonStore data contract', () => {
  const input = normalizeData({
    lastId: 2,
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
  assert.deepEqual(documents.posts.map(post => post.id), [1, 2]);
  assert.equal(documents.posts[1].boardId, 'chiko');
  assert.equal(documents.posts[1].threadId, 1);
  assert.equal(documents.posts[1].isThread, false);
  assert.equal(documents.posts[1].fortune, 'Excellent Luck');

  const output = normalizeData(dataFromDocuments(documents), 45, createDefaultBoard(config));
  assert.deepEqual(output, input);
});
