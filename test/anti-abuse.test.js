'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadConfig } = require('../config');
const { TURNSTILE_VERIFY_URL, TurnstileAdapter } = require('../lib/anti-abuse');

function adapterConfig(overrides = {}) {
  return loadConfig({
    antiAbuse: {
      turnstile: {
        enabled: true,
        siteKey: 'public-site-key',
        secretKey: 'private-secret-key',
        allowedHostnames: ['boards.example'],
        ...overrides
      }
    }
  });
}

function providerResponse(value, ok = true) {
  return {
    ok,
    text: async () => JSON.stringify(value)
  };
}

test('Turnstile validates action and hostname without disclosing a remote address', async () => {
  let request;
  const adapter = new TurnstileAdapter(adapterConfig(), {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return providerResponse({ success: true, action: 'post', hostname: 'boards.example' });
    }
  });

  const result = await adapter.verify('valid-token');
  assert.deepEqual(result, { success: true, action: 'post', hostname: 'boards.example' });
  assert.equal(request.url, TURNSTILE_VERIFY_URL);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.body.get('secret'), 'private-secret-key');
  assert.equal(request.options.body.get('response'), 'valid-token');
  assert.match(request.options.body.get('idempotency_key'), /^[a-f0-9-]{36}$/);
  assert.equal(request.options.body.has('remoteip'), false);
  assert.equal(request.options.redirect, 'error');
});

test('Turnstile rejects missing, failed, replay-like, action, and hostname responses', async () => {
  let calls = 0;
  const missing = new TurnstileAdapter(adapterConfig(), {
    fetchImpl: async () => {
      calls += 1;
      return providerResponse({ success: true, action: 'post', hostname: 'boards.example' });
    }
  });
  await assert.rejects(() => missing.verify(''), error => error.status === 400);
  await assert.rejects(() => missing.verify('x'.repeat(2049)), error => error.status === 400);
  assert.equal(calls, 0);

  for (const result of [
    { success: false, 'error-codes': ['timeout-or-duplicate'] },
    { success: true, action: 'login', hostname: 'boards.example' },
    { success: true, action: 'post', hostname: 'other.example' }
  ]) {
    const adapter = new TurnstileAdapter(adapterConfig(), {
      fetchImpl: async () => providerResponse(result)
    });
    await assert.rejects(() => adapter.verify('invalid-token'), error => error.status === 400);
  }
});

test('Turnstile provider outages follow the explicit closed or open policy', async () => {
  const unavailable = async () => { throw new Error('network unavailable'); };
  const closed = new TurnstileAdapter(adapterConfig({ failureMode: 'closed' }), {
    fetchImpl: unavailable,
    logger: { warn() {} }
  });
  await assert.rejects(() => closed.verify('token'), error => error.status === 503);

  let warning = '';
  const open = new TurnstileAdapter(adapterConfig({ failureMode: 'open' }), {
    fetchImpl: unavailable,
    logger: { warn(message) { warning = message; } }
  });
  assert.deepEqual(await open.verify('token'), {
    success: true,
    bypassed: 'provider-unavailable'
  });
  assert.match(warning, /failureMode is open/);
});
