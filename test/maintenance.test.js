'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadConfig } = require('../config');
const { BoardService } = require('../lib/board');
const { MaintenanceRunner } = require('../lib/maintenance');
const { JsonStore } = require('../lib/store');
const { UploadManager } = require('../lib/uploads');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chikochan-maintenance-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('JSON maintenance leases exclude competing owners until expiry', async t => {
  const directory = temporaryDirectory(t);
  const store = new JsonStore(loadConfig({ storage: 'json', dataDir: directory }));
  assert.equal(await store.acquireLease('job', 'owner-a', 1000, 100), true);
  assert.equal(await store.acquireLease('job', 'owner-b', 1000, 500), false);
  assert.equal(await store.acquireLease('job', 'owner-b', 1000, 1100), true);
  assert.equal(await store.releaseLease('job', 'owner-a'), false);
  assert.equal(await store.releaseLease('job', 'owner-b'), true);
});

test('lease-protected maintenance expires sanctions, archives overflow, and safely cleans retained media', async t => {
  const directory = temporaryDirectory(t);
  const config = loadConfig({
    storage: 'json',
    dataDir: directory,
    limits: { maxThreads: 1 },
    maintenance: {
      enabled: true,
      startupDelayMs: 0,
      intervalMs: 10000,
      leaseMs: 10000
    }
  });
  const store = new JsonStore(config);
  const uploads = new UploadManager(config);
  const service = new BoardService(config, store, uploads);
  const sourceDirectory = path.join(directory, 'src');
  fs.writeFileSync(path.join(sourceDirectory, 'orphan.png'), 'orphan');
  fs.writeFileSync(path.join(sourceDirectory, 'trash.png'), 'trash');

  const data = store.read();
  data.boards[0].settings.maxThreads = 1;
  data.threads = [{
    id: 1,
    boardId: data.boards[0].id,
    name: 'Old',
    comment: 'Old thread',
    createdAt: 100,
    bumpedAt: 100,
    replies: []
  }, {
    id: 2,
    boardId: data.boards[0].id,
    name: 'New',
    comment: 'New thread',
    createdAt: 200,
    bumpedAt: 200,
    replies: []
  }];
  data.bans = [{
    id: 'expired-ban',
    kind: 'ban',
    target: 'poster',
    scope: 'global',
    posterKey: 'P'.repeat(43),
    reason: 'Expired',
    active: true,
    createdAt: 100,
    updatedAt: 100,
    expiresAt: 500
  }];
  data.media = [{
    id: 'orphan-asset',
    kind: 'image',
    path: 'src/orphan.png',
    mime: 'image/png',
    createdAt: 100,
    refCount: 0
  }, {
    id: 'trash-asset',
    kind: 'image',
    path: 'src/trash.png',
    mime: 'image/png',
    createdAt: 100,
    refCount: 1
  }];
  data.trash = [{
    id: 'expired-trash',
    kind: 'reply',
    boardId: data.boards[0].id,
    threadId: 2,
    postId: 3,
    position: 0,
    post: {
      id: 3,
      name: 'Removed',
      comment: 'Expired trash',
      createdAt: 300,
      image: 'src/trash.png',
      imageName: 'trash.png',
      imageMime: 'image/png',
      assetId: 'trash-asset'
    },
    deletedAt: 300,
    purgeAt: 500
  }];
  store.write(data);

  const runner = new MaintenanceRunner(config, store, service, {
    ownerId: 'test-runner',
    logger: { error() {}, warn() {} }
  });
  const result = await runner.executeCycle(1000);
  assert.deepEqual(result, {
    status: 'completed',
    startedAt: 1000,
    finishedAt: result.finishedAt,
    expiredSanctions: 1,
    archivedThreads: 1,
    orphanAssets: 1,
    purgedTrash: 1,
    purgedQuarantineFiles: 0
  });

  const saved = store.read();
  assert.equal(saved.bans[0].active, false);
  assert.equal(saved.bans[0].liftedAt, 1000);
  assert.equal(saved.threads.find(thread => thread.id === 1).archived, true);
  assert.equal(saved.threads.find(thread => thread.id === 2).archived, false);
  assert.equal(saved.trash.length, 0);
  assert.equal(saved.media.length, 0);
  assert.equal(fs.existsSync(path.join(sourceDirectory, 'orphan.png')), false);
  assert.equal(fs.existsSync(path.join(sourceDirectory, 'trash.png')), false);
  assert.equal(saved.moderationLog.at(-1).action, 'maintenance');
});

test('maintenance skips a cycle when another instance holds the lease', async () => {
  let performed = false;
  const runner = new MaintenanceRunner(
    { maintenance: { enabled: true, startupDelayMs: 0, intervalMs: 10000, leaseMs: 10000 } },
    {
      acquireLease: async () => false,
      releaseLease: async () => { throw new Error('must not release an unowned lease'); }
    },
    {
      performMaintenance: async () => { performed = true; },
      purgeExpiredTrash: async () => { performed = true; }
    }
  );
  const result = await runner.executeCycle(1000);
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'lease-held');
  assert.equal(performed, false);
});
