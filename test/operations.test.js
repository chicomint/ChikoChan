'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createLocalBackup } = require('../scripts/backup-local');
const { parseArguments: parseLoadArguments, runLoad } = require('../scripts/load-benchmark');
const { restoreLocalBackup } = require('../scripts/restore-local');
const { createLoadFixture } = require('../scripts/seed-load-fixture');
const { verifyParsedUpgrade } = require('../scripts/verify-upgrade');
const { parseArguments: parseMigrationArguments, prepareMigration } = require('../scripts/migrate-to-mongo');
const { SCHEMA_VERSION, createDefaultBoard } = require('../lib/store');

function temporaryDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fixtureConfig() {
  return {
    maximumCites: 45,
    defaultBoard: createDefaultBoard({
      board: { uri: 'chiko', title: 'ChikoChan' },
      site: { title: 'ChikoChan', description: 'Test' }
    })
  };
}

test('committed upgrade fixture is idempotent and preserves active and retained records', () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'legacy-upgrade.json');
  const parsed = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const result = verifyParsedUpgrade(parsed, fixtureConfig());

  assert.equal(result.data.version, SCHEMA_VERSION);
  assert.equal(result.data.threads[0].title, 'Legacy fixture thread');
  assert.equal(result.data.threads[0].replies[0].comment, '>>1\nPreserve this reply and backlink.');
  assert.deepEqual(result.data.threads[0].backlinks, [{ id: 2, threadId: 1 }]);
  assert.equal(result.data.media[0].refCount, 1);
  assert.equal(result.data.reports[0].moderatorNote, 'Fixture resolution retained');
  assert.equal(result.data.trash[0].post.comment, 'Retained trash content');
  assert.equal(result.data.revisions[0].before.comment, 'Old fixture body');
  assert.equal(result.data.moderationLog[0].detail, 'Synthetic audit record');
});

test('Mongo migration planner includes every normalized collection without writes', () => {
  const source = path.join(__dirname, 'fixtures', 'legacy-upgrade.json');
  const before = fs.readFileSync(source);
  const parsed = JSON.parse(before);
  const config = {
    limits: { maxCites: 45 },
    board: { uri: 'chiko', title: 'ChikoChan' },
    site: { title: 'ChikoChan', description: 'Test' }
  };
  const result = prepareMigration(parsed, config);

  assert.deepEqual(Object.keys(result.documents), [
    'metadata', 'customization', 'boards', 'threads', 'posts', 'media', 'mediaHashBans',
    'mediaDecisions', 'mediaProviderResults', 'reports', 'bans', 'appeals', 'trash',
    'revisions', 'staff', 'moderationLog'
  ]);
  assert.equal(result.documents.posts.length, 2);
  assert.deepEqual(parseMigrationArguments(['--dry-run', '--source', source]), { dryRun: true, source });
  assert.deepEqual(fs.readFileSync(source), before);
});

test('local backup and guarded restore verify checksums and include no environment file', t => {
  const root = temporaryDirectory(t, 'chikochan-backup-test-');
  const source = path.join(root, 'source');
  const backup = path.join(root, 'backup');
  const restored = path.join(root, 'restored');
  fs.mkdirSync(path.join(source, 'src'), { recursive: true });
  fs.mkdirSync(path.join(source, 'quarantine'), { recursive: true });
  fs.writeFileSync(path.join(source, 'posts.json'), '{"threads":[]}\n');
  fs.writeFileSync(path.join(source, 'src', 'safe.png'), 'synthetic-public-media');
  fs.writeFileSync(path.join(source, 'quarantine', 'pending.bin'), 'synthetic-private-media');
  fs.writeFileSync(path.join(source, '.env'), 'DO_NOT_COPY=this-file\n');

  const manifest = createLocalBackup(source, backup, { includeQuarantine: true });
  assert.equal(manifest.files.length, 3);
  assert.equal(manifest.files.some(entry => entry.path === '.env'), false);
  restoreLocalBackup(backup, restored);
  assert.equal(fs.readFileSync(path.join(restored, 'src', 'safe.png'), 'utf8'), 'synthetic-public-media');
  assert.equal(fs.readFileSync(path.join(restored, 'quarantine', 'pending.bin'), 'utf8'), 'synthetic-private-media');
  assert.equal(fs.existsSync(path.join(restored, '.env')), false);
  assert.equal(fs.statSync(path.join(restored, 'posts.json')).mode & 0o777, 0o600);
  assert.throws(() => restoreLocalBackup(backup, restored), /must not exist or must be empty/);

  fs.writeFileSync(path.join(backup, 'data', 'posts.json'), 'tampered');
  assert.throws(() => restoreLocalBackup(backup, path.join(root, 'tampered-restore')), /integrity check failed/);
});

test('load fixture generation remains bounded, harmless, and ID-unique', () => {
  const fixture = createLoadFixture({ threads: 20, replies: 5 });
  const ids = fixture.threads.flatMap(thread => [thread.id, ...thread.replies.map(reply => reply.id)]);
  assert.equal(ids.length, 120);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(fixture.lastId, Math.max(...ids));
  assert.equal(fixture.media.length, 0);
  assert.match(fixture.threads[0].comment, /Harmless generated text/);
  assert.throws(() => createLoadFixture({ threads: 100001 }), /between 0 and 100000/);
});

test('read-only load harness bounds inputs and reports status and latency', async () => {
  const options = parseLoadArguments([
    '--url', 'https://boards.example', '--path', '/healthz',
    '--requests', '12', '--concurrency', '3', '--timeout-ms', '1000'
  ]);
  let tick = 0;
  const result = await runLoad(options, {
    clock: () => ++tick,
    fetchImpl: async () => ({ status: 200, async arrayBuffer() { return new ArrayBuffer(0); } })
  });
  assert.equal(result.requests, 12);
  assert.equal(result.failures, 0);
  assert.deepEqual(result.statuses, { 200: 12 });
  assert.ok(result.p95Ms > 0);
  assert.throws(() => parseLoadArguments(['--url', 'https://user:secret@boards.example']), /without credentials/);
  assert.throws(() => parseLoadArguments(['--concurrency', '1001']), /between 1 and 1000/);
});
