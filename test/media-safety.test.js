'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { MediaSafetyService, normalizeProviderResult } = require('../lib/media-safety');

const HASH = '1'.repeat(64);
const CONTENT_HASH = '2'.repeat(64);
const CANDIDATE = {
  sha256: HASH,
  contentSha256: CONTENT_HASH,
  imageMime: 'image/png',
  imageBytes: 68,
  _asset: { sourceSha256: HASH, contentSha256: CONTENT_HASH }
};

function boardService(hashBan = null) {
  const calls = [];
  return {
    calls,
    async findMediaHashBanRecord() { return hashBan; },
    async recordMediaDecision(value) { calls.push(['decision', value]); },
    async recordMediaProviderResult(value) { calls.push(['provider', value]); },
    async recordAutomatedMediaRejection(value) { calls.push(['reject', value]); }
  };
}

function config(overrides = {}) {
  return {
    mediaSafety: {
      knownIllegalProvider: 'none',
      failClosed: false,
      retainProviderResults: true,
      ...overrides
    }
  };
}

test('a persistent hash-ban rejects harmless synthetic media before provider work', async () => {
  const service = boardService({ id: 'ban' });
  const pipeline = new MediaSafetyService(config(), service, { logger: { warn() {}, error() {} } });
  await assert.rejects(
    pipeline.evaluate({ id: 'board-id' }, [CANDIDATE]),
    error => error.status === 403 && /cannot be posted/.test(error.message)
  );
  assert.equal(service.calls[0][0], 'decision');
  assert.equal(service.calls[0][1].reasonCode, 'hash-ban-match');
});

test('a mocked provider match records only normalized metadata and creates an automated ban', async () => {
  const service = boardService();
  const provider = {
    available: true,
    status: () => ({ name: 'mock-provider', available: true }),
    async check(input) {
      assert.deepEqual(Object.keys(input).sort(), ['bytes', 'contentSha256', 'mime', 'sha256']);
      return { matched: true, reasonCode: 'synthetic-match', providerReference: 'safe-fixture-1' };
    }
  };
  const pipeline = new MediaSafetyService(config({ knownIllegalProvider: 'mock-provider' }), service, {
    provider,
    logger: { warn() {}, error() {} }
  });
  await assert.rejects(pipeline.evaluate({ id: 'board-id' }, [CANDIDATE]), error => error.status === 403);
  assert.deepEqual(service.calls.map(call => call[0]), ['provider', 'reject']);
  assert.equal(JSON.stringify(service.calls).includes('response'), false);
});

test('invalid provider payloads and unavailable fail-closed providers never fabricate results', async () => {
  assert.throws(() => normalizeProviderResult({ matched: 'yes' }), /invalid result/);
  const service = boardService();
  const pipeline = new MediaSafetyService(config({
    knownIllegalProvider: 'unavailable-provider',
    failClosed: true
  }), service, { logger: { warn() {}, error() {} } });
  await assert.rejects(pipeline.evaluate({ id: 'board-id' }, [CANDIDATE]), error => error.status === 503);
  assert.deepEqual(service.calls, []);
});
