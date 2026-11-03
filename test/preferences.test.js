'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { encryptionKey } = require('../lib/settings');
const { createApp } = require('../app');
const { cleanPreferences } = require('../lib/preferences');

const values = { 'chikochan-theme': 'dark', 'chikochan-hidden-posts': '["7"]', 'chikochan-post-password': 'synthetic-private-deletion-password' };

test('visitor preferences are encrypted, isolated by private cookie and survive a new browser page', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chiko-preferences-'));
  encryptionKey(path.join(directory, 'test-key'), true);
  const app = createApp({ storage: 'json', dataDir: directory, keyFile: path.join(directory, 'test-key') });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await app.locals.chikochan.uploads.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/preferences`;
  const first = await fetch(url);
  assert.equal((await first.json()).fresh, true);
  const cookie = first.headers.get('set-cookie').split(';')[0];
  assert.match(first.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const headers = { cookie, 'content-type': 'application/json' };
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify(values) })).status, 204);
  assert.deepEqual((await (await fetch(url, { headers: { cookie } })).json()).values, values);
  assert.equal((await (await fetch(url)).json()).fresh, true);
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://evil.test' }, body: JSON.stringify(values) })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers, body: '{' })).status, 400);
  const stored = fs.readFileSync(path.join(directory, 'preferences', cookie.split('=')[1] + '.json'), 'utf8');
  assert.ok(!stored.includes(values['chikochan-post-password']));
  assert.ok(!stored.includes('dark'));
});

test('preferences reject invalid themes, hidden IDs, oversized passwords and unknown settings', () => {
  assert.throws(() => cleanPreferences({ ...values, 'chikochan-theme': 'unknown' }));
  assert.throws(() => cleanPreferences({ ...values, 'chikochan-hidden-posts': '["../secret"]' }));
  assert.throws(() => cleanPreferences({ ...values, 'chikochan-post-password': 'a'.repeat(257) }));
  assert.throws(() => cleanPreferences({ ...values, 'site.title': 'overwrite' }));
});
