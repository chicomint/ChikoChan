'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { BoundedJobQueue } = require('../lib/jobs');

test('bounded jobs enforce concurrency and preserve idempotent results', async () => {
  const queue = new BoundedJobQueue({ concurrency: 2, timeoutMs: 1000, retryLimit: 0, maxQueue: 10 });
  let active = 0;
  let maximum = 0;
  let executions = 0;
  const handler = async () => {
    executions += 1;
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve));
    active -= 1;
    return { ok: true };
  };
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) =>
    queue.submit('synthetic', { index }, handler, { idempotencyKey: `job-${index}` })
  ));
  assert.equal(maximum, 2);
  assert.equal(results.every(result => result.ok), true);
  assert.deepEqual(await queue.submit('synthetic', {}, handler, { idempotencyKey: 'job-0' }), { ok: true });
  assert.equal(executions, 6);
  await queue.close();
  await assert.rejects(queue.submit('synthetic', {}, handler), error => error.status === 503);
});

test('timed-out and non-retryable media jobs enter a metadata-only dead letter state', async () => {
  const queue = new BoundedJobQueue({ concurrency: 1, timeoutMs: 20, retryLimit: 2, maxQueue: 2 });
  await assert.rejects(
    queue.submit('synthetic-timeout', { secret: 'must-not-be-copied-to-dead-letter' },
      () => new Promise(() => {})),
    error => error.code === 'MEDIA_JOB_TIMEOUT'
  );
  const status = queue.status();
  assert.equal(status.failed, 1);
  assert.equal(JSON.stringify(queue.deadLetters).includes('must-not-be-copied'), false);
  assert.equal(queue.deadLetters[0].attempts, 1);
  await queue.close();
});

test('only explicitly retryable failures use the configured retry budget', async () => {
  const queue = new BoundedJobQueue({ concurrency: 1, timeoutMs: 1000, retryLimit: 2, maxQueue: 4 });
  let attempts = 0;
  const result = await queue.submit('transient', {}, () => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error('transient');
      error.retryable = true;
      throw error;
    }
    return 'complete';
  });
  assert.equal(result, 'complete');
  assert.equal(attempts, 3);
  await queue.close();
});
