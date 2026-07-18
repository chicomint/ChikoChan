'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadConfig } = require('../config');
const { JsonStore } = require('../lib/store');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chikochan-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('migrates legacy data and stores references and backlinks', t => {
  const directory = temporaryDirectory(t);
  fs.writeFileSync(path.join(directory, 'posts.json'), JSON.stringify({
    lastId: 1,
    threads: [{
      id: 10,
      name: 'OP',
      comment: 'hello',
      createdAt: 100,
      bumpedAt: 200,
      replies: [{ id: 11, name: 'Reply', comment: '>>10\n>>10', createdAt: 200 }]
    }]
  }));

  const config = loadConfig({ dataDir: directory });
  const store = new JsonStore(config);
  const data = store.read();

  assert.equal(data.version, 2);
  assert.equal(data.lastId, 11);
  assert.ok(data.meta.siteSecret.length >= 32);
  assert.deepEqual(data.threads[0].replies[0].references, [10]);
  assert.deepEqual(data.threads[0].backlinks, [{ id: 11, threadId: 10 }]);
});

test('refuses to erase malformed JSON', t => {
  const directory = temporaryDirectory(t);
  fs.writeFileSync(path.join(directory, 'posts.json'), '{ definitely not JSON');
  const config = loadConfig({ dataDir: directory });

  assert.throws(() => new JsonStore(config), /left untouched/);
  assert.equal(fs.readFileSync(path.join(directory, 'posts.json'), 'utf8'), '{ definitely not JSON');
});
