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
    const thread = await service.createThread({ title: 'Mongo catalog fixture', comment: 'Mongo thread' }, [media], { boardId });
    const reply = await service.createReply(thread.id, { comment: 'Mongo reply', password: 'password' }, null, { boardUri: boardId });
    const { db } = store;
    const oldIp = { posterIp: '2001:db8::1', posterKey: 'old-poster', posterId: 'old-id', ipCapturedAt: Date.now() };
    await db.collection('metadata').updateOne({ _id: 'state' }, { $set: { version: 18, 'meta.ipRetentionDays': 0 } });
    await db.collection('posts').updateMany({}, { $set: oldIp });
    await db.collection('threads').updateMany({}, { $set: oldIp });
    await db.collection('bans').insertOne({ _id: 'legacy', id: 'legacy', target: 'ip', ipNetwork: '192.0.2.0/24', appealId: 'legacy-appeal' });
    await db.collection('appeals').insertOne({ _id: 'legacy-appeal', id: 'legacy-appeal', sanctionId: 'legacy', status: 'open' });
    await db.collection('bans').createIndex({ target: 1, active: 1, scope: 1, boardId: 1, expiresAt: 1 }, { name: 'active_ip_bans' });
    await db.collection('rateLimitBuckets').insertOne({ _id: 'legacy-address-derived-bucket', expiresAt: new Date(Date.now() + 60000) });
    const report = await service.reportPost(reply.id, 'Keep report');
    await db.collection('reports').updateOne({ _id: report.id }, { $set: { reporterKey: 'old-reporter', openDedupeKey: 'legacy-dedupe' } });
    await store.initialize(config.mongoDbName);
    const contents = await store.readDocuments();
    assert.doesNotMatch(JSON.stringify(contents), /posterIp|posterKey|reporterKey|ipCapturedAt|ipRetentionDays|ipNetwork|old-reporter|legacy-dedupe|2001:db8|192\.0\.2/);
    assert.equal(await db.collection('rateLimitBuckets').countDocuments(), 0);
    assert.equal(await db.collection('appeals').countDocuments(), 0);
    assert.equal((await db.collection('bans').indexes()).some(index => index.name === 'active_ip_bans'), false);
    const view = await service.publicThread(thread.id, boardId);
    assert.equal(view.thread.comment, 'Mongo thread');
    assert.equal(view.thread.replies[0].comment, 'Mongo reply');
    assert.equal((await service.publicCatalog(view.board, 1, { q: '.*' })).threads.length, 0);
    assert.equal((await service.publicCatalog(view.board, 1, { q: 'CATALOG', sort: 'newest' })).threads.length, 1);
    await service.resolveReport(report.id, 'dismissed', '', { actor });
    await service.reportPost(reply.id, 'Keep report');
    await assert.rejects(service.reopenReport(report.id, { actor }), { status: 409 });
    await assert.rejects(service.sanctionPost(thread.id, { target: 'ip', reason: 'Legacy request' }, { actor }), { status: 400 });
    const trash = await service.adminDelete(thread.id, { actor });
    await service.restoreTrash(trash.trashId, { actor });
    assert.equal(await uploads.verifyStoredRelative(media.image), true);
    const deleted = await service.adminDelete(thread.id, { actor });
    await service.purgeTrash({ id: deleted.trashId }, { actor });
    for (const collection of ['threads','posts','trash','media']) assert.equal(await store.db.collection(collection).countDocuments(), 0, collection);
    assert.equal(service.getData().meta.mediaDeletionJobs.length, 0);
    console.log('PASS Mongo replica set: legacy identifier purge, targeted posts, catalog, reporting, restore and permanent deletion');
  } finally {
    if (app) { await app.locals.chikochan.uploads.close(); await app.locals.chikochan.store.close(); }
    await repl.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
