'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp } = require('../app');

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

async function testServer(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chikochan-http-'));
  const app = createApp({
    dataDir: directory,
    limits: { postRateLimit: 100, reportRateLimit: 100 },
    ...overrides
  });
  let server;
  const address = await new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', error => {
      if (error) reject(error);
      else resolve(server.address());
    });
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    app,
    directory,
    url: `http://127.0.0.1:${address.port}`
  };
}

async function createThread(url, values = {}) {
  const form = new FormData();
  form.set('name', values.name || 'Alice#rabbit');
  form.set('sub', values.subject || 'Test thread');
  form.set('com', values.comment || 'Opening post');
  form.set('pwd', values.password || 'op-password');
  form.set('upfile', new Blob([ONE_PIXEL_PNG], { type: 'image/png' }), 'pixel.png');
  const response = await fetch(`${url}/post?json=1`, { method: 'POST', body: form });
  const body = await response.text();
  assert.equal(response.status, 201, body);
  return JSON.parse(body);
}

async function createReply(url, threadId, comment, password = 'reply-password') {
  const form = new FormData();
  form.set('resto', String(threadId));
  form.set('name', 'Bob');
  form.set('com', comment);
  form.set('pwd', password);
  const response = await fetch(`${url}/post?json=1`, { method: 'POST', body: form });
  const body = await response.text();
  assert.equal(response.status, 201, body);
  return JSON.parse(body);
}

test('posts through compatibility fields and keeps backlinks in JSON', async t => {
  const server = await testServer(t);
  const thread = await createThread(server.url);
  const reply = await createReply(server.url, thread.threadId, `>>${thread.id}\nhello back`);
  const secondReply = await createReply(server.url, thread.threadId, `A second backlink: >>${thread.id}`);

  const stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  assert.deepEqual(stored.threads[0].backlinks, [
    { id: reply.id, threadId: thread.id },
    { id: secondReply.id, threadId: thread.id }
  ]);
  assert.deepEqual(stored.threads[0].replies[0].references, [thread.id]);
  assert.equal(stored.threads[0].title, 'Test thread');
  assert.match(stored.threads[0].trip, /^!/);
  assert.notEqual(stored.threads[0].passwordHash, 'op-password');
  assert.equal(stored.threads[0].posterKey.length > 20, true);

  const page = await fetch(`${server.url}/chiko/thread/${thread.id}`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, new RegExp(`class="backlink quotelink"[^>]+data-post-id="${reply.id}"`));
  assert.match(html, /class="postContainer opContainer"/);
  assert.match(html, /class="comment op-comment postMessage"/);
});

test('serves the 4chan-style board, catalog, threads, and thread APIs', async t => {
  const server = await testServer(t);
  const thread = await createThread(server.url);
  await createReply(server.url, thread.id, `>>${thread.id}`);

  const [boards, catalog, threads, page, threadApi] = await Promise.all([
    fetch(`${server.url}/boards.json`).then(response => response.json()),
    fetch(`${server.url}/chiko/catalog.json`).then(response => response.json()),
    fetch(`${server.url}/chiko/threads.json`).then(response => response.json()),
    fetch(`${server.url}/chiko/1.json`).then(response => response.json()),
    fetch(`${server.url}/chiko/thread/${thread.id}.json`).then(response => response.json())
  ]);

  assert.equal(boards.boards[0].board, 'chiko');
  assert.equal(catalog[0].threads[0].no, thread.id);
  assert.equal(threads[0].threads[0].replies, 1);
  assert.equal(page.threads[0].posts.length, 2);
  assert.deepEqual(threadApi.posts[0].backlinks, [thread.id + 1]);
  assert.deepEqual(threadApi.posts[1].references, [thread.id]);
  assert.equal(threadApi.posts[0].ext, '.png');
});

test('reports healthy and ready when JSON storage and uploads are writable', async t => {
  const server = await testServer(t);
  const [health, readiness] = await Promise.all([
    fetch(`${server.url}/healthz`),
    fetch(`${server.url}/readyz`)
  ]);

  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  assert.equal(readiness.status, 200);
  assert.deepEqual(await readiness.json(), { status: 'ready' });
  assert.equal(readiness.headers.get('cache-control'), 'no-store');
});

test('cross-thread citations point backlinks at the replying thread', async t => {
  const server = await testServer(t);
  const target = await createThread(server.url, { subject: 'Target' });
  const source = await createThread(server.url, { subject: 'Source', comment: `See >>${target.id}` });
  const stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  const targetPost = stored.threads.find(thread => thread.id === target.id);

  assert.deepEqual(targetPost.backlinks, [{ id: source.id, threadId: source.id }]);
  const html = await fetch(`${server.url}/chiko/thread/${target.id}`).then(response => response.text());
  assert.match(html, new RegExp(`href="/chiko/thread/${source.id}#p${source.id}"`));
});

test('password deletion removes incoming backlinks', async t => {
  const server = await testServer(t);
  const thread = await createThread(server.url);
  const reply = await createReply(server.url, thread.id, `>>${thread.id}`, 'remove-me');

  const response = await fetch(`${server.url}/delete?json=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ postIds: String(reply.id), pwd: 'remove-me' })
  });
  assert.equal(response.status, 200, await response.text());

  const stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  assert.equal(stored.threads[0].replies.length, 0);
  assert.deepEqual(stored.threads[0].backlinks, []);
});

test('escapes post HTML and renders dead citations without unsafe links', async t => {
  const server = await testServer(t);
  const thread = await createThread(server.url, { comment: '<script>alert(1)</script>\n>>99999' });
  const response = await fetch(`${server.url}/thread/${thread.id}`);
  const html = await response.text();

  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /class="deadlink" data-post-id="99999"/);
});

test('file-only deletion retains the post and removes its upload', async t => {
  const server = await testServer(t);
  const thread = await createThread(server.url, { password: 'file-password' });
  const before = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  const uploadPath = path.join(server.directory, before.threads[0].image);
  assert.equal(fs.existsSync(uploadPath), true);

  const response = await fetch(`${server.url}/delete?json=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ postIds: String(thread.id), pwd: 'file-password', fileOnly: '1' })
  });
  assert.equal(response.status, 200, await response.text());
  const after = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  assert.equal(after.threads.length, 1);
  assert.equal(after.threads[0].imageDeleted, true);
  assert.equal(after.threads[0].image, undefined);
  assert.equal(fs.existsSync(uploadPath), false);
});

test('#fortune name prepends a greentext fortune and hides the keyword', async t => {
  const server = await testServer(t, {
    features: { fortunes: true },
    fortunes: ['Good news will come to you by mail.', 'Bad Luck.']
  });
  const thread = await createThread(server.url, { name: '#fortune', comment: 'tell my fortune' });

  const stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  const op = stored.threads[0];
  assert.equal(op.name, 'Anonymous');
  assert.equal(op.trip, '');
  assert.match(op.comment, /^>Your fortune: (Good news will come to you by mail\.|Bad Luck\.)\ntell my fortune$/);

  const replyForm = new FormData();
  replyForm.set('resto', String(thread.id));
  replyForm.set('name', '#fortune');
  replyForm.set('com', 'reply comment');
  replyForm.set('pwd', 'reply-password');
  const replyResponse = await fetch(`${server.url}/post?json=1`, { method: 'POST', body: replyForm });
  const replyBody = await replyResponse.text();
  assert.equal(replyResponse.status, 201, replyBody);
  const reply = JSON.parse(replyBody);
  const replyStored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  const storedReply = replyStored.threads[0].replies.find(item => item.id === reply.id);
  assert.equal(storedReply.name, 'Anonymous');
  assert.match(storedReply.comment, /^>Your fortune: (Good news will come to you by mail\.|Bad Luck\.)\nreply comment$/);

  const page = await fetch(`${server.url}/chiko/thread/${thread.id}`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /<span class="greentext">&gt;Your fortune: /);
  assert.doesNotMatch(html, /#fortune/);
  assert.doesNotMatch(html, /Alice/);
});

test('#fortune as a tripcode password still produces a tripcode', async t => {
  const server = await testServer(t, { fortunes: ['Only fortune.'] });
  const thread = await createThread(server.url, { name: '#fortune#secret' });
  const stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  assert.notEqual(stored.threads[0].trip, '');
  assert.doesNotMatch(stored.threads[0].comment, /Your fortune:/);
});

test('admin reports, thread controls, and keyed bans work without storing raw IPs', async t => {
  const server = await testServer(t, {
    adminPassword: 'admin-test-password',
    adminSessionSecret: 'admin-test-session-secret'
  });
  const thread = await createThread(server.url);

  const reportResponse = await fetch(`${server.url}/report?json=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ postId: String(thread.id), reason: 'Integration test report' })
  });
  assert.equal(reportResponse.status, 201);

  const login = await fetch(`${server.url}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'admin-test-password' })
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const dashboard = await fetch(`${server.url}/admin`, { headers: { cookie } });
  const dashboardHtml = await dashboard.text();
  assert.equal(dashboard.status, 200);
  assert.match(dashboardHtml, /Integration test report/);
  const csrf = /name="csrf" value="([^"]+)"/.exec(dashboardHtml)?.[1];
  assert.ok(csrf);

  const lock = await fetch(`${server.url}/admin/thread-setting`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf, threadId: String(thread.id), flag: 'locked', value: '1' })
  });
  assert.equal(lock.status, 303);

  const ban = await fetch(`${server.url}/admin/ban`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({
      csrf,
      postId: String(thread.id),
      duration: '3600000',
      reason: 'Test ban'
    })
  });
  assert.equal(ban.status, 303);

  const stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  assert.equal(stored.threads[0].locked, true);
  assert.equal(stored.reports.length, 1);
  assert.equal(stored.bans.length, 1);
  assert.equal(stored.bans[0].reason, 'Test ban');
  assert.doesNotMatch(JSON.stringify(stored), /127\.0\.0\.1/);

  const rejectedForm = new FormData();
  rejectedForm.set('com', 'A banned thread attempt');
  rejectedForm.set('upfile', new Blob([ONE_PIXEL_PNG], { type: 'image/png' }), 'blocked.png');
  const rejected = await fetch(`${server.url}/post?json=1`, { method: 'POST', body: rejectedForm });
  assert.equal(rejected.status, 403);
  assert.match((await rejected.json()).error, /Posting is blocked/);
  assert.equal(fs.readdirSync(path.join(server.directory, 'src')).length, 1);
});
