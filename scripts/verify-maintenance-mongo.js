'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MongoMemoryReplSet } = require(process.argv[2] || 'mongodb-memory-server');
const { createApp } = require('../app');
const sharp = require('sharp');
// Optional integration runner; use an external mongodb-memory-server installation.
(async () => {
  const repl = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: '7.0.24' } });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chiko-mongo-check-'));
  let app;
  try {
    app = createApp({ storage: 'mongodb', mongoUrl: repl.getUri(), mongoDbName: 'maintenance', dataDir: directory, adminPassword: 'test-admin-password', adminSessionSecret: 'test-secret', features: { requireImageForThread: false } });
    const { store, service, uploads, config } = app.locals.chikochan;
    await store.ready;
    assert.equal(store.supportsTransactions, true);
    const actor = { id: 'legacy-root', role: 'root', scope: 'global', legacy: true, enabled: true };
    const boardId = service.getDefaultBoard().id;
    const buffer = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'red' } }).png().toBuffer();
    const filename = 'mongo-upload.upload';
    const filePath = path.join(config.quarantineDir, filename);
    fs.writeFileSync(filePath, buffer);
    const media = await uploads.validate({ path: filePath, filename, originalname: 'image.png', mimetype: 'image/png', size: buffer.length });
    await uploads.approveCandidate(media);
    const thread = await service.createThread({ comment: 'Mongo thread' }, [media], { boardId, clientKey: 'thread', address: '2001:db8::1' });
    await service.createReply(thread.id, { comment: 'Mongo reply', password: 'password' }, null, { clientKey: 'reply', address: '192.0.2.1' });
    await store.refreshCache();
    assert.equal(service.getData().threads[0].posterIp, '2001:db8::1');
    assert.equal(service.getData().threads[0].replies[0].posterIp, '192.0.2.1');
    const view = await service.publicThread(thread.id, boardId);
    assert.equal(view.thread.posterIp, undefined);
    assert.equal(view.thread.replies[0].posterIp, undefined);
    await service.sanctionPost(thread.id, { target: 'ip', scope: 'global', ipNetwork: '2001:db8::/64', reason: 'Spam', durationMs: 3600000 }, { actor });
    await assert.rejects(service.createThread({ comment: 'Blocked' }, null, { boardId, clientKey: 'other', address: '2001:db8::2' }), { status: 403 });
    await service.updateIpRetention('1', { actor });
    await service.performMaintenance(Date.now() + 2 * 86400000);
    assert.equal((await store.db.collection('posts').findOne({ _id: thread.id })).posterIp, undefined);
    assert.equal((await store.db.collection('threads').findOne({ _id: thread.id })).posterIp, undefined);
    const trash = await service.adminDelete(thread.id, { actor });
    await service.restoreTrash(trash.trashId, { actor });
    assert.equal(await uploads.verifyStoredRelative(media.image), true);
    const deleted = await service.adminDelete(thread.id, { actor });
    await service.purgeTrash({ id: deleted.trashId }, { actor });
    for (const collection of ['threads','posts','trash','media']) assert.equal(await store.db.collection(collection).countDocuments(), 0, collection);
    assert.equal(service.getData().meta.mediaDeletionJobs.length, 0);
    console.log('PASS Mongo replica set: targeted thread/reply capture, public projections, CIDR bans, cleanup, restore, permanent deletion and references');
  } finally {
    if (app) { await app.locals.chikochan.uploads.close(); await app.locals.chikochan.store.close(); }
    await repl.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
