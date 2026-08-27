'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { LocalStorage, ObjectStorage, safeKey } = require('../lib/media-storage');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chikochan-storage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function objectConfig() {
  return {
    mediaStorage: {
      object: {
        endpoint: 'https://objects.example.test',
        region: 'us-east-1',
        quarantineBucket: 'chiko-quarantine',
        publicBucket: 'chiko-public',
        publicBaseUrl: 'https://media.example.test/assets',
        pathStyle: true,
        requestTimeoutMs: 5000,
        accessKeyId: 'synthetic-access-key',
        secretAccessKey: 'synthetic-secret-key',
        sessionToken: ''
      }
    }
  };
}

test('local storage keeps quarantine separate and promotes only an explicit safe key', async t => {
  const directory = temporaryDirectory(t);
  const uploadDir = path.join(directory, 'src');
  const quarantineDir = path.join(directory, 'quarantine');
  fs.mkdirSync(uploadDir);
  fs.mkdirSync(quarantineDir);
  const source = path.join(quarantineDir, 'random.upload');
  fs.writeFileSync(source, 'synthetic media');
  const storage = new LocalStorage({ uploadDir, quarantineDir });

  const sourceKey = await storage.stageFile(source);
  assert.equal(sourceKey, 'random.upload');
  assert.equal(fs.existsSync(path.join(uploadDir, 'approved.png')), false);
  await storage.promote(sourceKey, 'approved.png');
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(path.join(uploadDir, 'approved.png'), 'utf8'), 'synthetic media');
  assert.equal(await storage.hasApproved('approved.png'), true);
  await storage.hold('approved.png', 'held/asset/approved.png');
  assert.equal(await storage.hasApproved('approved.png'), false);
  assert.equal(await storage.hasQuarantine('held/asset/approved.png'), true);
  await storage.promote('held/asset/approved.png', 'approved.png');
  assert.equal(await storage.hasApproved('approved.png'), true);
  assert.equal(await storage.hasQuarantine('held/asset/approved.png'), false);
  assert.throws(() => safeKey('../outside.png'), /Invalid media storage key/);
});

test('object storage signs private staging and copy promotion without exposing its secret', async t => {
  const directory = temporaryDirectory(t);
  const source = path.join(directory, 'synthetic.png');
  fs.writeFileSync(source, 'synthetic media');
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    if (options.method === 'HEAD') return { ok: false, status: 404 };
    return { ok: true, status: 200 };
  };
  const storage = new ObjectStorage(objectConfig(), { fetchImpl });

  await storage.stageFile(source, 'pending/random.png', 'image/png');
  await storage.promote('pending/random.png', 'approved.png', 'image/png');

  assert.deepEqual(requests.map(entry => entry.options.method), ['PUT', 'HEAD', 'PUT', 'DELETE']);
  assert.match(requests[0].url, /chiko-quarantine\/pending\/random\.png$/);
  assert.match(requests[2].url, /chiko-public\/approved\.png$/);
  assert.equal(requests[2].options.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(requests[2].options.headers['x-amz-copy-source'], '/chiko-quarantine/pending/random.png');
  const serializedHeaders = JSON.stringify(requests.map(entry => entry.options.headers));
  assert.match(serializedHeaders, /AWS4-HMAC-SHA256/);
  assert.equal(serializedHeaders.includes('synthetic-secret-key'), false);
  assert.equal(storage.publicUrl('approved.png'), 'https://media.example.test/assets/approved.png');
});

test('object storage moves approved media back to private quarantine for moderation hold', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    if (options.method === 'HEAD') return { ok: false, status: 404 };
    return { ok: true, status: 200 };
  };
  const storage = new ObjectStorage(objectConfig(), { fetchImpl });

  await storage.hold('approved.png', 'held/asset/approved.png', 'image/png');

  assert.deepEqual(requests.map(entry => entry.options.method), ['HEAD', 'PUT', 'DELETE']);
  assert.match(requests[0].url, /chiko-quarantine\/held\/asset\/approved\.png$/);
  assert.match(requests[1].url, /chiko-quarantine\/held\/asset\/approved\.png$/);
  assert.equal(requests[1].options.headers['cache-control'], 'private, no-store');
  assert.equal(requests[1].options.headers['x-amz-copy-source'], '/chiko-public/approved.png');
  assert.match(requests[2].url, /chiko-public\/approved\.png$/);
});

test('object quarantine cleanup deletes only expired pending objects', async () => {
  const requests = [];
  const listing = `<?xml version="1.0" encoding="UTF-8"?>
    <ListBucketResult>
      <IsTruncated>false</IsTruncated>
      <Contents><Key>pending/old.png</Key><LastModified>2020-01-01T00:00:00.000Z</LastModified></Contents>
      <Contents><Key>pending/new.png</Key><LastModified>2030-01-01T00:00:00.000Z</LastModified></Contents>
    </ListBucketResult>`;
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      text: async () => listing
    };
  };
  const storage = new ObjectStorage(objectConfig(), { fetchImpl });
  const removed = await storage.cleanupQuarantine(Date.parse('2025-01-01T00:00:00Z'));
  assert.equal(removed, 1);
  assert.deepEqual(requests.map(entry => entry.options.method), ['GET', 'DELETE']);
  assert.match(requests[1].url, /pending\/old\.png$/);
});

test('object storage does not treat server failures as harmless missing objects', async () => {
  const storage = new ObjectStorage(objectConfig(), {
    fetchImpl: async () => ({ ok: false, status: 503 })
  });
  await assert.rejects(() => storage.hasApproved('approved.png'), /could not complete/);
});
