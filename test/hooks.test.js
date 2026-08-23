'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadConfig } = require('../config');
const { HookRegistry } = require('../lib/hooks');

test('extension hooks accept only allowlisted startup registrations and immutable payloads', async () => {
  const seen = [];
  const registry = new HookRegistry(loadConfig(), {
    beforePost(payload) {
      assert.equal(Object.isFrozen(payload), true);
      assert.equal(Object.isFrozen(payload.text), true);
      seen.push(payload.text.comment);
    },
    afterPost: [payload => seen.push(payload.postId)]
  });
  await registry.runBlocking('beforePost', { text: { comment: 'safe' } });
  registry.notify('afterPost', { postId: 12 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, ['safe', 12]);
  assert.equal(registry.handlers, undefined);

  assert.throws(
    () => new HookRegistry(loadConfig(), { beforePermissionCheck() {} }),
    /Unknown extension hook/
  );
  assert.throws(
    () => new HookRegistry(loadConfig(), { beforePost: 'not a function' }),
    /at most 10 functions/
  );
});

test('blocking hooks may reject but infrastructure failures become bounded service errors', async () => {
  const rejected = new HookRegistry(loadConfig(), {
    beforePost() {
      const error = new Error('Local posting policy');
      error.status = 409;
      throw error;
    }
  });
  await assert.rejects(
    () => rejected.runBlocking('beforePost', {}),
    error => error.status === 409 && error.message === 'Local posting policy'
  );

  let logged = '';
  const timedOut = new HookRegistry(loadConfig({ extensions: { hookTimeoutMs: 50 } }), {
    beforeUpload: () => new Promise(() => {})
  }, {
    logger: { error(message) { logged = message; } }
  });
  await assert.rejects(
    () => timedOut.runBlocking('beforeUpload', {}),
    error => error.status === 503 && /safety extension/.test(error.message)
  );
  assert.match(logged, /timed out/);
});

test('observational hook failures are isolated from completed application actions', async () => {
  let logged = '';
  const registry = new HookRegistry(loadConfig(), {
    reportCreated() { throw new Error('observer failed'); }
  }, {
    logger: { error(message) { logged = message; } }
  });
  registry.notify('reportCreated', { reportId: 'report-one' });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(logged, /Observational extension hook reportCreated failed/);
});
