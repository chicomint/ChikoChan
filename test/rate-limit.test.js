'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MemoryRateLimitStore,
  RateLimiter,
  RedisRateLimitStore
} = require('../lib/rate-limit');

function config(limit = 2) {
  return {
    rateLimit: {
      operations: { replyCreate: { windowMs: 60000, limit } }
    }
  };
}

test('two limiter instances sharing one store enforce one common budget', async () => {
  const store = new MemoryRateLimitStore();
  const first = new RateLimiter(config(), store);
  const second = new RateLimiter(config(), store);
  await first.consume('replyCreate', 'same-private-identity');
  await second.consume('replyCreate', 'same-private-identity');
  await assert.rejects(
    first.consume('replyCreate', 'same-private-identity'),
    error => error.status === 429 && error.retryAfterSeconds >= 1
  );
  await first.consume('replyCreate', 'different-private-identity');
});

test('Redis limiter uses an atomic script and health check without embedding identities in keys', async () => {
  const calls = [];
  const client = {
    async eval(script, options) {
      calls.push({ script, options });
      return calls.length;
    },
    async sendCommand(arguments_) {
      assert.deepEqual(arguments_, ['PING']);
      return 'PONG';
    }
  };
  const store = new RedisRateLimitStore(client, 'unit');
  const first = await store.consume('opaque-key', 1, 60000, 1000);
  const second = await store.consume('opaque-key', 1, 60000, 1000);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.equal(calls[0].options.keys[0].includes('opaque-key'), true);
  assert.match(calls[0].script, /INCR/);
  assert.equal(await store.healthCheck(), true);
});
