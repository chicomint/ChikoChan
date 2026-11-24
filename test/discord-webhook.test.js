'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');
const { createApp } = require('../app');
const { closeApplication } = require('../lib/bootstrap');
const { encryptionKey } = require('../lib/settings');

test('configure a Discord webhook in Admin and send text-only links after posting', { timeout: 10_000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chiko-discord-'));
  const keyFile = path.join(directory, 'key');
  encryptionKey(keyFile, true);
  const deliveries = [];
  const warnings = [];
  const webhook = 'https://discord.com/api/webhooks/123456789012345678/example_token';
  const origin = 'https://chiko.example';
  const password = 'discord-test-admin-password';
  const app = createApp({
    storage: 'json',
    dataDir: directory,
    keyFile,
    adminPassword: password,
    adminSessionSecret: 'discord-test-admin-session-secret',
    features: { requireImageForThread: false },
    limits: { postRateLimit: 100 },
    discordWebhookFetch: async (url, options) => {
      deliveries.push({ url, options, payload: JSON.parse(options.body) });
      return new Response(null, { status: deliveries.length === 2 ? 404 : 204 });
    },
    logger: { warn: message => warnings.push(message), error: () => {} }
  });
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await closeApplication(app);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const { service, store } = app.locals.chikochan;
  const board = service.getDefaultBoard().uri;
  const form = (route, fields, headers) => fetch(base + route, {
    method: 'POST', body: new URLSearchParams(fields), headers, redirect: 'manual'
  });
  const settingsPath = '/admin/discord-webhook';
  assert.equal((await fetch(base + settingsPath, { redirect: 'manual' })).status, 303);

  const login = await form('/admin/login', { password });
  assert.equal(login.status, 303);
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0] };
  const page = await (await fetch(base + settingsPath, { headers })).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1];
  assert.equal((await form(settingsPath, { webhookUrl: webhook, siteOrigin: origin }, headers)).status, 403);
  assert.equal((await form(settingsPath, { csrf, webhookUrl: webhook.replace('discord.com', 'discord.com.example'), siteOrigin: origin }, headers)).status, 400);
  assert.equal((await form(settingsPath, { csrf, webhookUrl: webhook, siteOrigin: origin }, headers)).status, 303);
  const saved = store.read().meta.discordWebhook;
  assert.equal(saved.siteOrigin, origin);
  assert.ok(saved.encryptedUrl);
  assert.ok(!fs.readFileSync(store.filePath, 'utf8').includes(webhook));
  assert.ok(!(await (await fetch(base + settingsPath, { headers })).text()).includes(webhook));

  const thread = await form('/post?json=1', {
    board, name: 'chicomint#test-trip-secret', com: 'hi'
  });
  assert.equal(thread.status, 201);
  const threadBody = await thread.json();
  await waitFor(() => deliveries.length === 1);
  assert.equal(deliveries[0].url, webhook + '?wait=true');
  assert.equal(deliveries[0].options.redirect, 'error');
  assert.deepEqual(deliveries[0].payload, {
    content: `[>>/${board}/${threadBody.id}](${origin}${threadBody.url}) \`chicomint hi\``,
    allowed_mentions: { parse: [] },
    flags: 4
  });

  const reply = await form('/reply?json=1', {
    board, threadId: threadBody.id, com: '@everyone\n`test` ' + '🐱'.repeat(200)
  });
  assert.equal(reply.status, 201);
  const replyBody = await reply.json();
  await waitFor(() => warnings.includes('Discord webhook delivery failed.'));
  const replyText = deliveries[1].payload.content;
  assert.ok(replyText.startsWith(`[>>/${board}/${replyBody.id}](${origin}${replyBody.url}) \`Anonymous @everyone ˋtestˋ `));
  assert.ok(replyText.endsWith('…`'));
  assert.equal(replyText.match(/`/g).length, 2);

  assert.equal((await form(settingsPath, { csrf, siteOrigin: origin + ':8443' }, headers)).status, 303);
  assert.equal(store.read().meta.discordWebhook.encryptedUrl, saved.encryptedUrl);
  assert.equal((await form(settingsPath, { csrf, action: 'remove' }, headers)).status, 303);
  assert.equal(store.read().meta.discordWebhook, undefined);
  const later = await form('/reply?json=1', { board, threadId: threadBody.id, com: 'after removal' });
  assert.equal(later.status, 201);
  assert.equal(deliveries.length, 2);
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Discord delivery did not finish.');
}
