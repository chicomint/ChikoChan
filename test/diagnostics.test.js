'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadConfig } = require('../config');
const { diagnose } = require('../lib/diagnostics');
const { JsonStore } = require('../lib/store');
const { UploadManager } = require('../lib/uploads');

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chikochan-diagnostics-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = loadConfig({ storage: 'json', dataDir: directory });
  const store = new JsonStore(config);
  const uploads = new UploadManager(config);
  return { config, directory, store, uploads };
}

test('diagnostics report healthy media without exposing configuration secrets', async t => {
  const context = setup(t);
  fs.writeFileSync(path.join(context.directory, 'src', 'known.png'), ONE_PIXEL_PNG);
  const data = context.store.read();
  data.threads = [{
    id: 1,
    boardId: data.boards[0].id,
    name: 'Poster',
    comment: 'Known file',
    createdAt: 100,
    bumpedAt: 100,
    image: 'src/known.png',
    imageName: 'known.png',
    imageMime: 'image/png',
    width: 1,
    height: 1,
    replies: []
  }];
  context.store.write(data);

  const report = await diagnose(context.config, context.store, context.uploads);
  assert.equal(report.ok, true);
  assert.deepEqual(report.summary, { errors: 0, warnings: 0 });
  assert.equal(report.counts.posts, 1);
  assert.equal(report.counts.attachments, 1);
  assert.equal(JSON.stringify(report).includes('siteSecret'), false);
});

test('diagnostics flag missing, untracked, and forbidden privacy fields without deleting files or values', async t => {
  const context = setup(t);
  const knownPath = path.join(context.directory, 'src', 'known.png');
  const untrackedPath = path.join(context.directory, 'src', 'untracked.png');
  fs.writeFileSync(knownPath, ONE_PIXEL_PNG);
  fs.writeFileSync(untrackedPath, ONE_PIXEL_PNG);
  const data = context.store.read();
  data.threads = [{
    id: 1,
    boardId: data.boards[0].id,
    name: 'Poster',
    comment: 'Broken file',
    ipAddress: '203.0.113.44',
    createdAt: 100,
    bumpedAt: 100,
    image: 'src/known.png',
    imageName: 'known.png',
    imageMime: 'image/png',
    width: 1,
    height: 1,
    replies: []
  }];
  context.store.write(data);
  fs.unlinkSync(knownPath);

  const report = await diagnose(context.config, context.store, context.uploads);
  const codes = new Set(report.issues.map(entry => entry.code));
  assert.equal(report.ok, false);
  assert.equal(codes.has('media-file-missing'), true);
  assert.equal(codes.has('untracked-upload-file'), true);
  assert.equal(codes.has('raw-network-field'), true);
  assert.equal(fs.existsSync(untrackedPath), true);
  assert.equal(JSON.stringify(report).includes('203.0.113.44'), false);
});
