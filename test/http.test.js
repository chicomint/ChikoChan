'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp } = require('../app');

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);
const ONE_PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');

async function testServer(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chikochan-http-'));
  const app = createApp({
    storage: 'json',
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
  if (values.fortune) form.set('fortune', values.fortune);
  form.set(
    'upfile',
    new Blob([values.file || ONE_PIXEL_PNG], { type: values.mime || 'image/png' }),
    values.filename || 'pixel.png'
  );
  const response = await fetch(`${url}/post?json=1`, { method: 'POST', body: form });
  const body = await response.text();
  assert.equal(response.status, 201, body);
  return JSON.parse(body);
}

function commandAvailable(command) {
  const result = childProcess.spawnSync(command, ['-version'], {
    shell: false,
    stdio: 'ignore',
    timeout: 2000
  });
  return !result.error && result.status === 0;
}

const FFMPEG_AVAILABLE = commandAvailable('ffmpeg');
const VIDEO_TOOLS_AVAILABLE = FFMPEG_AVAILABLE && commandAvailable('ffprobe');

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

async function createImageReply(url, threadId, comment = 'image reply') {
  const form = new FormData();
  form.set('resto', String(threadId));
  form.set('name', 'Image poster');
  form.set('com', comment);
  form.set('pwd', 'image-reply-password');
  form.set('upfile', new Blob([ONE_PIXEL_GIF], { type: 'image/gif' }), 'pixel.gif');
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
  const opHeaderStart = html.indexOf(`id="pi${thread.id}"`);
  const opHeaderEnd = html.indexOf('</div>', opHeaderStart);
  const firstBacklink = html.indexOf(`data-post-id="${reply.id}"`, opHeaderStart);
  assert.ok(opHeaderStart >= 0 && firstBacklink < opHeaderEnd, 'backlink should be inside the post header');
  assert.doesNotMatch(html, /Replies:/);
  assert.match(html, new RegExp(`class="quotelink" href="#p${thread.id}" data-post-id="${thread.id}"`));
  assert.match(html, /class="postContainer opContainer"/);
  assert.match(html, /class="comment op-comment postMessage"/);
  assert.match(html, new RegExp(`class="post-menu"[\\s\\S]+aria-label="Post actions for No\\.${thread.id}"`));
  assert.match(html, new RegExp(`id="pi${thread.id}"[\\s\\S]+class="report-control"[\\s\\S]+</div>`));
  assert.match(html, /<time class="date-time dateTime" datetime="[^"]+">\d{2}\/\d{2}\/\d{2}\([A-Z][a-z]{2}\)\d{2}:\d{2}:\d{2}<\/time>/);
  assert.doesNotMatch(html, /<time class="date-time dateTime"[^>]*>[^<]*ago<\/time>/);
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

  const homeHtml = await fetch(server.url).then(result => result.text());
  assert.doesNotMatch(homeHtml, /class="latest-image-link"/);
});

test('deduplicated media remains until its final post reference is deleted', async t => {
  const server = await testServer(t);
  const first = await createThread(server.url, { subject: 'First reference', password: 'first-file-password' });
  const second = await createThread(server.url, { subject: 'Second reference', password: 'second-file-password' });
  let stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));

  assert.equal(stored.media.length, 1);
  assert.equal(stored.media[0].refCount, 2);
  assert.equal(stored.threads[0].image, stored.threads[1].image);
  const sharedPath = path.join(server.directory, stored.media[0].path);
  assert.equal(fs.existsSync(sharedPath), true);

  const firstDeletion = await fetch(`${server.url}/delete?json=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ postIds: String(first.id), pwd: 'first-file-password', fileOnly: '1' })
  });
  assert.equal(firstDeletion.status, 200, await firstDeletion.text());
  stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  assert.equal(stored.media[0].refCount, 1);
  assert.equal(fs.existsSync(sharedPath), true);

  const secondDeletion = await fetch(`${server.url}/delete?json=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ postIds: String(second.id), pwd: 'second-file-password', fileOnly: '1' })
  });
  assert.equal(secondDeletion.status, 200, await secondDeletion.text());
  stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  assert.equal(stored.media.length, 0);
  assert.equal(fs.existsSync(sharedPath), false);
});

test('opt-in multiple attachments preserve legacy APIs, moderation, restore, and cleanup', async t => {
  const server = await testServer(t, {
    adminPassword: 'admin-test-password',
    adminSessionSecret: 'admin-test-session-secret',
    limits: { maxFilesPerPost: 2, postRateLimit: 100, reportRateLimit: 100 }
  });
  const boardForm = await fetch(`${server.url}/chiko/`).then(response => response.text());
  assert.match(boardForm, /name="upfile"[^>]+ multiple/);
  assert.match(boardForm, /Up to 2 files/);

  const form = new FormData();
  form.set('sub', 'Two attachments');
  form.set('com', 'Both files belong to one post.');
  form.set('pwd', 'multi-file-password');
  form.set('spoiler', '1');
  form.append('upfile', new Blob([ONE_PIXEL_PNG], { type: 'image/png' }), 'first.png');
  form.append('upfile', new Blob([ONE_PIXEL_GIF], { type: 'image/gif' }), 'second<&>.gif');
  const response = await fetch(`${server.url}/post?json=1`, { method: 'POST', body: form });
  const responseBody = await response.text();
  assert.equal(response.status, 201, responseBody);
  const created = JSON.parse(responseBody);

  let stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  let post = stored.threads[0];
  assert.equal(post.attachments.length, 2);
  assert.equal(post.image, post.attachments[0].image);
  assert.equal(post.assetId, post.attachments[0].assetId);
  assert.equal(post.attachments[1].imageName, 'second<&>.gif');
  assert.equal(post.attachments.every(attachment => attachment.spoiler), true);
  assert.equal(stored.media.length, 2);
  assert.deepEqual(stored.media.map(asset => asset.refCount), [1, 1]);
  const filePaths = stored.media.map(asset => path.join(server.directory, asset.path));
  assert.equal(filePaths.every(filePath => fs.existsSync(filePath)), true);

  const [threadHtml, threadApi] = await Promise.all([
    fetch(`${server.url}/chiko/thread/${created.id}`).then(result => result.text()),
    fetch(`${server.url}/chiko/thread/${created.id}.json`).then(result => result.json())
  ]);
  assert.match(threadHtml, /data-attachment-count="2"/);
  assert.equal((threadHtml.match(/class="post-attachment"/g) || []).length, 2);
  assert.match(threadHtml, /second&lt;&amp;&gt;\.gif/);
  assert.doesNotMatch(threadHtml, /second<&>\.gif/);
  assert.equal(threadApi.posts[0].filename, 'first');
  assert.equal(threadApi.posts[0].extra_files.length, 1);
  assert.equal(threadApi.posts[0].extra_files[0].filename, 'second<&>');
  assert.equal(threadApi.posts[0].images, 2);

  const login = await fetch(`${server.url}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'admin-test-password' })
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const dashboardHtml = await fetch(`${server.url}/admin`, { headers: { cookie } })
    .then(result => result.text());
  const csrf = /name="csrf" value="([^"]+)"/.exec(dashboardHtml)?.[1];
  assert.ok(csrf);

  const invalidHash = await fetch(`${server.url}/admin/sanction`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({
      csrf,
      postId: String(created.id),
      kind: 'ban',
      target: 'file',
      fileHash: 'c'.repeat(64),
      scope: 'global',
      duration: '0',
      reason: 'Invalid selected hash',
      reasonVisible: '1'
    })
  });
  assert.equal(invalidHash.status, 400);

  const secondHash = post.attachments[1].sha256;
  const sanction = await fetch(`${server.url}/admin/sanction`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({
      csrf,
      postId: String(created.id),
      kind: 'ban',
      target: 'file',
      fileHash: secondHash,
      scope: 'global',
      duration: '0',
      reason: 'Blocked attachment',
      reasonVisible: '1'
    })
  });
  assert.equal(sanction.status, 303, await sanction.text());
  stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  assert.equal(stored.bans[0].fileHash, secondHash);

  const secondAttachmentId = post.attachments[1].id;
  const missingAttachment = await fetch(`${server.url}/admin/delete`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({
      csrf,
      postId: String(created.id),
      fileOnly: '1',
      attachmentId: 'missing-attachment',
      reason: 'Invalid attachment'
    })
  });
  assert.equal(missingAttachment.status, 404);

  const trashSecond = await fetch(`${server.url}/admin/delete`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({
      csrf,
      postId: String(created.id),
      fileOnly: '1',
      attachmentId: secondAttachmentId,
      reason: 'Review second file'
    })
  });
  assert.equal(trashSecond.status, 303, await trashSecond.text());
  stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  assert.equal(stored.threads[0].attachments.length, 1);
  assert.equal(stored.threads[0].imageDeleted, undefined);
  assert.equal(stored.trash[0].attachmentId, secondAttachmentId);
  assert.equal(stored.trash[0].post.attachments.length, 1);
  assert.equal(stored.trash[0].post.attachments[0].imageName, 'second<&>.gif');
  assert.deepEqual(stored.media.map(asset => asset.refCount), [1, 1]);
  const oneFileHtml = await fetch(`${server.url}/chiko/thread/${created.id}`).then(result => result.text());
  assert.match(oneFileHtml, /data-attachment-count="1"/);
  assert.doesNotMatch(oneFileHtml, /second&lt;&amp;&gt;\.gif/);

  const restoreSecond = await fetch(`${server.url}/admin/trash/restore`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf, trashId: stored.trash[0].id })
  });
  assert.equal(restoreSecond.status, 303, await restoreSecond.text());
  stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  assert.equal(stored.threads[0].attachments.length, 2);
  assert.equal(stored.threads[0].attachments[1].id, secondAttachmentId);
  assert.equal(stored.trash.length, 0);

  const trash = await fetch(`${server.url}/admin/delete`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({
      csrf,
      postId: String(created.id),
      fileOnly: '1',
      reason: 'Review both files'
    })
  });
  assert.equal(trash.status, 303, await trash.text());
  stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  assert.equal(stored.threads[0].attachments.length, 0);
  assert.equal(stored.threads[0].imageDeleted, true);
  assert.equal(stored.trash[0].post.attachments.length, 2);
  assert.deepEqual(stored.media.map(asset => asset.refCount), [1, 1]);
  assert.equal(filePaths.every(filePath => fs.existsSync(filePath)), true);

  const restore = await fetch(`${server.url}/admin/trash/restore`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf, trashId: stored.trash[0].id })
  });
  assert.equal(restore.status, 303, await restore.text());
  stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  assert.equal(stored.trash.length, 0);
  assert.equal(stored.threads[0].attachments.length, 2);

  const deletion = await fetch(`${server.url}/delete?json=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      postIds: String(created.id),
      pwd: 'multi-file-password',
      fileOnly: '1'
    })
  });
  assert.equal(deletion.status, 200, await deletion.text());
  stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  assert.equal(stored.media.length, 0);
  assert.equal(filePaths.some(filePath => fs.existsSync(filePath)), false);

  const overLimit = new FormData();
  overLimit.set('com', 'Three files are over this board limit.');
  overLimit.append('upfile', new Blob([ONE_PIXEL_PNG], { type: 'image/png' }), 'one.png');
  overLimit.append('upfile', new Blob([ONE_PIXEL_GIF], { type: 'image/gif' }), 'two.gif');
  overLimit.append('upfile', new Blob([ONE_PIXEL_PNG], { type: 'image/png' }), 'three.png');
  const rejected = await fetch(`${server.url}/post?json=1`, { method: 'POST', body: overLimit });
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /at most 2 attachments/);
  assert.equal(fs.readdirSync(path.join(server.directory, 'src')).length, 0);

  const bannedFile = new FormData();
  bannedFile.set('com', 'This hash is banned.');
  bannedFile.set('upfile', new Blob([ONE_PIXEL_GIF], { type: 'image/gif' }), 'blocked.gif');
  const blocked = await fetch(`${server.url}/post?json=1`, { method: 'POST', body: bannedFile });
  assert.equal(blocked.status, 403);
  assert.match((await blocked.json()).error, /Posting is blocked: Blocked attachment/);
  assert.equal(fs.readdirSync(path.join(server.directory, 'src')).length, 0);
});

test('rejects upload MIME spoofing before storing a post', async t => {
  const server = await testServer(t);
  const form = new FormData();
  form.set('com', 'Spoofed upload');
  form.set('upfile', new Blob([ONE_PIXEL_PNG], { type: 'application/octet-stream' }), 'spoof.png');
  const response = await fetch(`${server.url}/post?json=1`, { method: 'POST', body: form });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.match(body.error, /MIME type does not match/);
  assert.equal(fs.readdirSync(path.join(server.directory, 'src')).length, 0);
});

test('optional Turnstile protects public posts without IP disclosure and bypasses verified staff', async t => {
  const validations = [];
  const server = await testServer(t, {
    adminPassword: 'admin-test-password',
    adminSessionSecret: 'admin-test-session-secret',
    antiAbuse: {
      turnstile: {
        enabled: true,
        siteKey: 'public-site-key',
        secretKey: 'private-secret-key',
        allowedHostnames: ['boards.example']
      }
    },
    turnstileFetch: async (url, options) => {
      validations.push({ url, body: new URLSearchParams(options.body) });
      const token = options.body.get('response');
      return {
        ok: true,
        text: async () => JSON.stringify(token === 'valid-token'
          ? { success: true, action: 'post', hostname: 'boards.example' }
          : { success: false, 'error-codes': ['invalid-input-response'] })
      };
    }
  });

  const boardResponse = await fetch(`${server.url}/chiko/`);
  const boardHtml = await boardResponse.text();
  const csp = boardResponse.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src 'self' https:\/\/challenges\.cloudflare\.com/);
  assert.match(csp, /frame-src https:\/\/challenges\.cloudflare\.com/);
  assert.match(boardHtml, /data-turnstile-form/);
  assert.match(boardHtml, /data-sitekey="public-site-key"/);
  assert.match(boardHtml, /turnstile\/v0\/api\.js\?render=explicit/);
  assert.doesNotMatch(boardHtml, /private-secret-key/);

  function publicPost(token) {
    const form = new FormData();
    form.set('sub', 'Verified thread');
    form.set('com', 'CAPTCHA-protected body');
    form.set('pwd', 'captcha-password');
    form.set('upfile', new Blob([ONE_PIXEL_PNG], { type: 'image/png' }), 'captcha.png');
    if (token !== undefined) form.set('cf-turnstile-response', token);
    return fetch(`${server.url}/post?json=1`, { method: 'POST', body: form });
  }

  const missing = await publicPost(undefined);
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /Human verification failed/);
  assert.equal(validations.length, 0);
  assert.equal(fs.readdirSync(path.join(server.directory, 'src')).length, 0);

  const invalid = await publicPost('invalid-token');
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /Human verification failed/);
  assert.equal(validations.length, 1);
  assert.equal(fs.readdirSync(path.join(server.directory, 'src')).length, 0);

  const accepted = await publicPost('valid-token');
  const acceptedBody = await accepted.text();
  assert.equal(accepted.status, 201, acceptedBody);
  const created = JSON.parse(acceptedBody);
  assert.equal(validations.length, 2);
  assert.equal(validations[1].body.get('response'), 'valid-token');
  assert.equal(validations[1].body.has('remoteip'), false);
  assert.equal(validations[1].body.get('secret'), 'private-secret-key');

  const login = await fetch(`${server.url}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'admin-test-password' })
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const staffPage = await fetch(
    `${server.url}/admin/post?board=chiko&threadId=${created.id}`,
    { headers: { cookie } }
  );
  const staffHtml = await staffPage.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(staffHtml)?.[1];
  assert.ok(csrf);
  assert.doesNotMatch(staffHtml, /data-turnstile-form|data-turnstile-widget/);

  const staffForm = new FormData();
  staffForm.set('csrf', csrf);
  staffForm.set('board', 'chiko');
  staffForm.set('resto', String(created.id));
  staffForm.set('com', 'Verified staff bypasses the public CAPTCHA adapter.');
  const staffReply = await fetch(`${server.url}/admin/post`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie },
    body: staffForm
  });
  assert.equal(staffReply.status, 303, await staffReply.text());
  assert.equal(validations.length, 2);
});

test('explicit extension hooks can reject or observe but cannot bypass moderation boundaries', async t => {
  const observed = [];
  const server = await testServer(t, {
    adminPassword: 'admin-test-password',
    adminSessionSecret: 'admin-test-session-secret',
    extensionHooks: {
      beforeUpload: payload => observed.push({ name: 'beforeUpload', payload }),
      afterUpload: payload => observed.push({ name: 'afterUpload', payload }),
      beforePost(payload) {
        observed.push({ name: 'beforePost', payload });
        if (payload.text.comment.includes('blocked by hook')) {
          const error = new Error('Rejected by the configured posting policy.');
          error.status = 409;
          throw error;
        }
      },
      afterPost: payload => observed.push({ name: 'afterPost', payload }),
      reportCreated: payload => observed.push({ name: 'reportCreated', payload }),
      moderationAction: payload => observed.push({ name: 'moderationAction', payload })
    }
  });

  const blockedForm = new FormData();
  blockedForm.set('com', 'blocked by hook');
  blockedForm.set('pwd', 'private-delete-password');
  blockedForm.set('upfile', new Blob([ONE_PIXEL_PNG], { type: 'image/png' }), 'blocked.png');
  const blocked = await fetch(`${server.url}/post?json=1`, { method: 'POST', body: blockedForm });
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /configured posting policy/);
  assert.equal(fs.readdirSync(path.join(server.directory, 'src')).length, 0);

  const accepted = await createThread(server.url, { comment: 'accepted by hooks' });
  await new Promise(resolve => setImmediate(resolve));
  const beforePost = observed.find(entry => entry.name === 'beforePost'
    && entry.payload.text.comment === 'accepted by hooks');
  assert.ok(beforePost);
  assert.equal(Object.isFrozen(beforePost.payload), true);
  const serialized = JSON.stringify(observed);
  assert.equal(serialized.includes('private-delete-password'), false);
  assert.equal(serialized.includes('clientKey'), false);
  assert.equal(serialized.includes('path'), false);
  assert.equal(observed.some(entry => entry.name === 'afterUpload'), true);
  assert.equal(observed.some(entry => entry.name === 'afterPost' && entry.payload.postId === accepted.id), true);

  const report = await fetch(`${server.url}/report?json=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      postId: String(accepted.id),
      category: 'spam',
      reason: 'Hook-observed report'
    })
  });
  assert.equal(report.status, 201, await report.text());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observed.some(entry => entry.name === 'reportCreated'), true);

  const unauthorized = await fetch(`${server.url}/admin/thread-setting`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ threadId: String(accepted.id), flag: 'locked', value: '1' })
  });
  assert.equal(unauthorized.status, 303);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observed.some(entry => entry.name === 'moderationAction'), false);

  const login = await fetch(`${server.url}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'admin-test-password' })
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const dashboard = await fetch(`${server.url}/admin`, { headers: { cookie } });
  const csrf = /name="csrf" value="([^"]+)"/.exec(await dashboard.text())?.[1];
  const locked = await fetch(`${server.url}/admin/thread-setting`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({
      csrf,
      threadId: String(accepted.id),
      flag: 'locked',
      value: '1'
    })
  });
  assert.equal(locked.status, 303);
  await new Promise(resolve => setImmediate(resolve));
  const moderation = observed.find(entry => entry.name === 'moderationAction');
  assert.deepEqual(moderation.payload, {
    action: 'thread-setting',
    boardUri: '',
    actorRole: 'root'
  });
});

test('keeps image posting available when optional media processors are missing', async t => {
  const server = await testServer(t, {
    features: { videoUploads: true },
    media: {
      ffmpegPath: 'missing-chikochan-ffmpeg',
      ffprobePath: 'missing-chikochan-ffprobe'
    }
  });
  assert.equal(server.app.locals.chikochan.uploads.videoAvailable, false);
  const page = await fetch(`${server.url}/chiko/`).then(response => response.text());
  assert.doesNotMatch(page, /video\/webm/);

  await createThread(server.url, { subject: 'Image fallback works' });
  const video = new FormData();
  video.set('com', 'Unavailable video attempt');
  video.set('upfile', new Blob([Buffer.from('1a45dfa39f4282847765626d', 'hex')], { type: 'video/webm' }), 'clip.webm');
  const rejected = await fetch(`${server.url}/post?json=1`, { method: 'POST', body: video });
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /Only JPG, PNG, GIF, and WEBP/);
});

test('generates and uses a real image thumbnail when FFmpeg is available', {
  skip: !FFMPEG_AVAILABLE
}, async t => {
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'chikochan-image-fixture-'));
  t.after(() => fs.rmSync(fixtureDirectory, { recursive: true, force: true }));
  const fixturePath = path.join(fixtureDirectory, 'large.png');
  const generated = childProcess.spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'color=c=pink:s=640x480', '-frames:v', '1',
    fixturePath
  ], { encoding: 'utf8', shell: false, timeout: 15000 });
  if (generated.status !== 0) {
    t.skip(`FFmpeg cannot create the image fixture: ${generated.stderr || generated.error?.message || 'unknown error'}`);
    return;
  }

  const server = await testServer(t);
  const thread = await createThread(server.url, {
    file: fs.readFileSync(fixturePath),
    filename: 'large.png',
    password: 'thumbnail-password'
  });
  const stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  const asset = stored.media[0];
  assert.equal(asset.kind, 'image');
  assert.match(asset.thumbnail, /^src\/thumb-[a-z0-9-]+\.jpg$/);
  assert.ok(asset.thumbnailWidth <= 320 && asset.thumbnailHeight <= 320);
  assert.equal(fs.existsSync(path.join(server.directory, asset.thumbnail)), true);

  const html = await fetch(`${server.url}/chiko/thread/${thread.id}`).then(response => response.text());
  assert.match(html, /class="post-img" src="\/src\/thumb-[^"]+\.jpg"/);
  assert.match(html, /data-full-src="\/src\/[^"]+\.png"/);
  assert.match(html, /data-thumbnail-src="\/src\/thumb-[^"]+\.jpg"/);
});

test('escapes long hostile filenames in media metadata and download controls', async t => {
  const server = await testServer(t);
  const filename = `${'long-name-'.repeat(14)}\"><img src=x onerror=alert(1)>.png`;
  const thread = await createThread(server.url, { filename });
  const html = await fetch(`${server.url}/chiko/thread/${thread.id}`).then(response => response.text());

  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
  assert.match(html, /(?:&quot;|%22)&gt;&lt;img src=x onerror=alert\(1\)&gt;\.png/);
  assert.match(html, /class="file-download"/);
});

test('posts, serves, renders, and deletes validated WebM and MP4 video assets', {
  skip: !VIDEO_TOOLS_AVAILABLE
}, async t => {
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'chikochan-video-fixture-'));
  t.after(() => fs.rmSync(fixtureDirectory, { recursive: true, force: true }));
  const fixturePath = path.join(fixtureDirectory, 'fixture.webm');
  const generated = childProcess.spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:r=10:d=0.5',
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-an',
    fixturePath
  ], { encoding: 'utf8', shell: false, timeout: 15000 });
  if (generated.status !== 0) {
    t.skip(`FFmpeg cannot create the WebM fixture: ${generated.stderr || generated.error?.message || 'unknown error'}`);
    return;
  }
  const mp4FixturePath = path.join(fixtureDirectory, 'fixture.mp4');
  let mp4Generated = null;
  for (const codec of ['libx264', 'libopenh264']) {
    mp4Generated = childProcess.spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-f', 'lavfi', '-i', 'color=c=green:s=64x48:r=10:d=0.5',
      '-c:v', codec, '-pix_fmt', 'yuv420p', '-an',
      mp4FixturePath
    ], { encoding: 'utf8', shell: false, timeout: 15000 });
    if (mp4Generated.status === 0) break;
  }

  const server = await testServer(t);
  assert.equal(server.app.locals.chikochan.uploads.videoAvailable, true);
  const form = new FormData();
  form.set('name', 'Video poster');
  form.set('sub', 'Validated video');
  form.set('com', 'A small browser-compatible WebM.');
  form.set('pwd', 'video-password');
  form.set('spoiler', '1');
  form.set('upfile', new Blob([fs.readFileSync(fixturePath)], { type: 'video/webm' }), 'safe-clip.webm');
  const response = await fetch(`${server.url}/post?json=1`, { method: 'POST', body: form });
  const body = await response.text();
  assert.equal(response.status, 201, body);
  const created = JSON.parse(body);

  let stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  const post = stored.threads[0];
  const asset = stored.media[0];
  assert.equal(asset.kind, 'video');
  assert.equal(asset.mime, 'video/webm');
  assert.equal(asset.videoCodec, 'vp9');
  assert.equal(asset.refCount, 1);
  assert.equal(post.assetId, asset.id);
  assert.equal(post.mediaKind, 'video');
  assert.ok(post.durationMs > 0 && post.durationMs <= 1000);
  assert.equal(fs.existsSync(path.join(server.directory, asset.path)), true);
  assert.equal(fs.existsSync(path.join(server.directory, asset.thumbnail)), true);

  const html = await fetch(`${server.url}/chiko/thread/${created.threadId}`).then(result => result.text());
  assert.match(html, /<video class="post-video" controls preload="metadata" playsinline poster="\/src\/thumb-[^"]+\.jpg"/);
  assert.match(html, /<source src="\/src\/[^"]+\.webm" type="video\/webm">/);
  assert.match(html, /data-reveal-spoiler/);
  assert.match(html, /class="file-download"/);

  const videoUrl = `${server.url}/${post.image}`;
  const range = await fetch(videoUrl, { headers: { range: 'bytes=0-15' } });
  assert.equal(range.status, 206);
  assert.match(range.headers.get('content-range') || '', /^bytes 0-15\/\d+$/);
  assert.equal((await range.arrayBuffer()).byteLength, 16);

  const api = await fetch(`${server.url}/chiko/thread/${created.threadId}.json`).then(result => result.json());
  assert.equal(api.posts[0].ext, '.webm');
  assert.equal(api.posts[0].media_type, 'video');
  assert.equal(api.posts[0].video_codec, 'vp9');
  assert.ok(api.posts[0].duration > 0);

  const originalPath = path.join(server.directory, asset.path);
  const thumbnailPath = path.join(server.directory, asset.thumbnail);
  const deletion = await fetch(`${server.url}/delete?json=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ postIds: String(created.id), pwd: 'video-password', fileOnly: '1' })
  });
  assert.equal(deletion.status, 200, await deletion.text());
  stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  assert.equal(stored.media.length, 0);
  assert.equal(stored.threads[0].imageDeleted, true);
  assert.equal(fs.existsSync(originalPath), false);
  assert.equal(fs.existsSync(thumbnailPath), false);

  if (mp4Generated?.status === 0) {
    const mp4Form = new FormData();
    mp4Form.set('sub', 'Validated MP4');
    mp4Form.set('com', 'A small H.264 MP4.');
    mp4Form.set('pwd', 'mp4-password');
    mp4Form.set('upfile', new Blob([fs.readFileSync(mp4FixturePath)], { type: 'video/mp4' }), 'safe-clip.mp4');
    const mp4Response = await fetch(`${server.url}/post?json=1`, { method: 'POST', body: mp4Form });
    const mp4Body = await mp4Response.text();
    assert.equal(mp4Response.status, 201, mp4Body);
    const mp4Post = JSON.parse(mp4Body);
    const mp4Stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
    const storedPost = mp4Stored.threads.find(thread => thread.id === mp4Post.id);
    const mp4Asset = mp4Stored.media.find(item => item.id === storedPost.assetId);
    assert.equal(mp4Asset.mime, 'video/mp4');
    assert.equal(mp4Asset.videoCodec, 'h264');
    const mp4Html = await fetch(`${server.url}/chiko/thread/${mp4Post.id}`).then(result => result.text());
    assert.match(mp4Html, /<source src="\/src\/[^"]+\.mp4" type="video\/mp4">/);
    const mp4OriginalPath = path.join(server.directory, mp4Asset.path);
    const mp4ThumbnailPath = path.join(server.directory, mp4Asset.thumbnail);
    const mp4Deletion = await fetch(`${server.url}/delete?json=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ postIds: String(mp4Post.id), pwd: 'mp4-password', fileOnly: '1' })
    });
    assert.equal(mp4Deletion.status, 200, await mp4Deletion.text());
    assert.equal(fs.existsSync(mp4OriginalPath), false);
    assert.equal(fs.existsSync(mp4ThumbnailPath), false);
  }
});

test('#fortune stores trusted metadata and renders a server-only fortune element', async t => {
  const server = await testServer(t, {
    features: { fortunes: true },
    fortunes: ['Good news will come to you by mail.', 'Bad Luck.']
  });
  const thread = await createThread(server.url, { name: '#fortune', comment: 'tell my fortune' });

  const stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  const op = stored.threads[0];
  assert.equal(op.name, 'Anonymous');
  assert.equal(op.trip, '');
  assert.equal(op.comment, 'tell my fortune');
  assert.match(op.fortune, /^(Good news will come to you by mail\.|Bad Luck\.)$/);

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
  assert.equal(storedReply.comment, 'reply comment');
  assert.match(storedReply.fortune, /^(Good news will come to you by mail\.|Bad Luck\.)$/);

  const page = await fetch(`${server.url}/chiko/thread/${thread.id}`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /<span class="fortune" title="Server-generated fortune">Your fortune: /);
  assert.doesNotMatch(html, /<span class="greentext">&gt;Your fortune: /);
  assert.doesNotMatch(html, /#fortune/);
  assert.doesNotMatch(html, /Alice/);

  const threadApi = await fetch(`${server.url}/chiko/thread/${thread.id}.json`).then(response => response.json());
  assert.equal(threadApi.posts[0].fortune, op.fortune);
  assert.match(threadApi.posts[0].com, /class="fortune"/);
});

test('typed fortune imitations remain ordinary escaped greentext', async t => {
  const server = await testServer(t, { fortunes: ['Server result.'] });
  const thread = await createThread(server.url, {
    comment: '>Your fortune: Bad Luck\n>ordinary greentext\n<span class="fortune">forged</span>',
    fortune: 'Forged metadata.'
  });

  const stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  assert.equal(stored.threads[0].fortune, undefined);

  const html = await fetch(`${server.url}/chiko/thread/${thread.id}`).then(response => response.text());
  assert.match(html, /<span class="greentext">&gt;Your fortune: Bad Luck<\/span>/);
  assert.match(html, /<span class="greentext">&gt;ordinary greentext<\/span>/);
  assert.match(html, /&lt;span class=&quot;fortune&quot;&gt;forged&lt;\/span&gt;/);
  assert.doesNotMatch(html, /class="fortune"/);
});

test('homepage shows compact recent posts and deduplicated valid image links', async t => {
  const server = await testServer(t);
  const first = await createThread(server.url, { subject: 'First image' });
  const second = await createThread(server.url, { subject: 'Duplicate image' });
  const imageReply = await createImageReply(server.url, first.id);

  const html = await fetch(server.url).then(response => response.text());
  assert.match(html, /<h2>Latest Images<\/h2>/);
  assert.match(html, /<h2>Latest Posts<\/h2>/);
  assert.match(html, new RegExp(`class="latest-image-link" href="/chiko/thread/${first.id}#p${imageReply.id}"`));
  assert.match(html, new RegExp(`class="latest-post-reference" href="/chiko/thread/${first.id}#p${first.id}"`));
  assert.equal((html.match(/class="latest-image-link"/g) || []).length, 2);
  assert.equal((html.match(/class="latest-post-reference"/g) || []).length, 3);
  assert.match(html, new RegExp(`href="/chiko/thread/(?:${first.id}|${second.id})#p(?:${first.id}|${second.id})"`));
});

test('#fortune as a tripcode password still produces a tripcode', async t => {
  const server = await testServer(t, { fortunes: ['Only fortune.'] });
  const thread = await createThread(server.url, { name: '#fortune#secret' });
  const stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  assert.notEqual(stored.threads[0].trip, '');
  assert.doesNotMatch(stored.threads[0].comment, /Your fortune:/);
});

test('capcodes require the staff posting boundary and expose only the verified role', async t => {
  const server = await testServer(t, {
    adminPassword: 'admin-test-password',
    adminSessionSecret: 'admin-test-session-secret'
  });

  const forged = new FormData();
  forged.set('com', 'Forged staff post');
  forged.set('capcode', '1');
  forged.set('upfile', new Blob([ONE_PIXEL_PNG], { type: 'image/png' }), 'forged.png');
  const forgedResponse = await fetch(`${server.url}/post?json=1`, { method: 'POST', body: forged });
  assert.equal(forgedResponse.status, 403);
  assert.match((await forgedResponse.json()).error, /authenticated staff posting form/);
  assert.equal(fs.readdirSync(path.join(server.directory, 'src')).length, 0);

  const login = await fetch(`${server.url}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'admin-test-password' })
  });
  assert.equal(login.status, 303);
  assert.match(login.headers.get('set-cookie'), /Path=\/admin/);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const formPage = await fetch(`${server.url}/admin/post?board=chiko`, { headers: { cookie } });
  const formHtml = await formPage.text();
  assert.equal(formPage.status, 200);
  assert.match(formHtml, /Display verified ## Root capcode/);
  const csrf = /name="csrf" value="([^"]+)"/.exec(formHtml)?.[1];
  assert.ok(csrf);

  const staffForm = new FormData();
  staffForm.set('csrf', csrf);
  staffForm.set('board', 'chiko');
  staffForm.set('resto', '0');
  staffForm.set('name', 'Site Staff');
  staffForm.set('sub', 'Verified announcement');
  staffForm.set('com', 'This is an authenticated staff post.');
  staffForm.set('capcode', '1');
  staffForm.set('upfile', new Blob([ONE_PIXEL_PNG], { type: 'image/png' }), 'staff.png');
  const posted = await fetch(`${server.url}/admin/post`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie },
    body: staffForm
  });
  assert.equal(posted.status, 303);

  const stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  assert.equal(stored.threads[0].capcode, 'root');
  assert.equal(stored.threads[0].staffId, undefined);
  assert.equal(stored.threads[0].staffName, undefined);
  assert.match(stored.moderationLog[0].actorName, /environment-admin/);

  const [threadHtml, threadApi] = await Promise.all([
    fetch(`${server.url}/chiko/thread/${stored.threads[0].id}`).then(response => response.text()),
    fetch(`${server.url}/chiko/thread/${stored.threads[0].id}.json`).then(response => response.json())
  ]);
  assert.match(threadHtml, /class="capcode"[^>]*>## Root<\/span>/);
  assert.doesNotMatch(threadHtml, /environment-admin/);
  assert.equal(threadApi.posts[0].capcode, 'root');
});

test('staff edits, archives, trash restoration, and expiry preserve public and media invariants', async t => {
  const server = await testServer(t, {
    adminPassword: 'admin-test-password',
    adminSessionSecret: 'admin-test-session-secret'
  });
  const thread = await createThread(server.url, { subject: 'Lifecycle thread', comment: 'Original body' });
  const reply = await createReply(server.url, thread.id, 'Original reply');
  const login = await fetch(`${server.url}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'admin-test-password' })
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const dashboard = await fetch(`${server.url}/admin`, { headers: { cookie } });
  const dashboardHtml = await dashboard.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(dashboardHtml)?.[1];
  assert.ok(csrf);

  const beforeEdit = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  const bumpedAt = beforeEdit.threads[0].bumpedAt;
  const missingCsrf = await fetch(`${server.url}/admin/edit`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ postId: String(reply.id), comment: 'Unauthorized edit', reason: 'No token' })
  });
  assert.equal(missingCsrf.status, 403);

  const editedComment = `Edited safely <script>alert(1)</script>\n>>${thread.id}`;
  const edit = await fetch(`${server.url}/admin/edit`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({
      csrf,
      postId: String(reply.id),
      comment: editedComment,
      reason: 'Correct misleading text'
    })
  });
  assert.equal(edit.status, 303, await edit.text());
  let stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  assert.equal(stored.threads[0].bumpedAt, bumpedAt);
  assert.equal(stored.threads[0].replies[0].comment, editedComment);
  assert.equal(stored.revisions.length, 1);
  assert.equal(stored.revisions[0].before.comment, 'Original reply');
  assert.match(stored.revisions[0].editedByName, /environment-admin/);

  const editedPage = await fetch(`${server.url}/chiko/thread/${thread.id}`).then(response => response.text());
  assert.match(editedPage, /class="post-edited"[^>]*>\[Edited\]<\/time>/);
  assert.match(editedPage, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(editedPage, /environment-admin/);
  assert.doesNotMatch(editedPage, /<script>alert\(1\)<\/script>/);
  const revisionsPage = await fetch(`${server.url}/admin/revisions?postId=${reply.id}`, { headers: { cookie } });
  assert.equal(revisionsPage.status, 200);
  assert.match(await revisionsPage.text(), /Correct misleading text/);

  const archive = await fetch(`${server.url}/admin/thread-setting`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf, threadId: String(thread.id), flag: 'archived', value: '1' })
  });
  assert.equal(archive.status, 303);
  const [boardHtml, archiveHtml, archivedHtml, archiveApi] = await Promise.all([
    fetch(`${server.url}/chiko/`).then(response => response.text()),
    fetch(`${server.url}/chiko/archive`).then(response => response.text()),
    fetch(`${server.url}/chiko/thread/${thread.id}`).then(response => response.text()),
    fetch(`${server.url}/chiko/archive.json`).then(response => response.json())
  ]);
  assert.doesNotMatch(boardHtml, new RegExp(`id="t${thread.id}"`));
  assert.match(archiveHtml, new RegExp(`href="/chiko/thread/${thread.id}"`));
  assert.match(archivedHtml, /\[Archived\]/);
  assert.match(archivedHtml, /archived and read-only/);
  assert.doesNotMatch(archivedHtml, /class="quote-reply-link/);
  assert.deepEqual(archiveApi, [thread.id]);
  const blockedReply = new FormData();
  blockedReply.set('resto', String(thread.id));
  blockedReply.set('com', 'Cannot reply to archive');
  const blocked = await fetch(`${server.url}/post?json=1`, { method: 'POST', body: blockedReply });
  assert.equal(blocked.status, 403);

  const unarchive = await fetch(`${server.url}/admin/thread-setting`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf, threadId: String(thread.id), flag: 'archived', value: '0' })
  });
  assert.equal(unarchive.status, 303);
  stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  assert.equal(stored.threads[0].bumpedAt, bumpedAt);

  const filePath = path.join(server.directory, stored.threads[0].image);
  const trashFile = await fetch(`${server.url}/admin/delete`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({
      csrf,
      postId: String(thread.id),
      fileOnly: '1',
      reason: 'Review attachment'
    })
  });
  assert.equal(trashFile.status, 303);
  stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  assert.equal(stored.threads[0].imageDeleted, true);
  assert.equal(stored.trash[0].kind, 'attachment');
  assert.equal(stored.media[0].refCount, 1);
  assert.equal(fs.existsSync(filePath), true);
  const deletedFilePage = await fetch(`${server.url}/chiko/thread/${thread.id}`).then(response => response.text());
  assert.match(deletedFilePage, /File deleted\./);

  const restoreFile = await fetch(`${server.url}/admin/trash/restore`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf, trashId: stored.trash[0].id })
  });
  assert.equal(restoreFile.status, 303);
  stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  assert.equal(stored.trash.length, 0);
  assert.ok(stored.threads[0].image);

  const trashThread = async () => fetch(`${server.url}/admin/delete`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf, postId: String(thread.id), reason: 'Temporary removal' })
  });
  assert.equal((await trashThread()).status, 303);
  stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  assert.equal(stored.threads.length, 0);
  assert.equal(stored.trash[0].kind, 'thread');
  const restoreThread = await fetch(`${server.url}/admin/trash/restore`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf, trashId: stored.trash[0].id })
  });
  assert.equal(restoreThread.status, 303);
  stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  assert.equal(stored.threads[0].bumpedAt, bumpedAt);
  assert.equal(stored.threads[0].replies[0].id, reply.id);

  assert.equal((await trashThread()).status, 303);
  stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  stored.trash[0].purgeAt = Date.now() - 1;
  fs.writeFileSync(path.join(server.directory, 'posts.json'), `${JSON.stringify(stored, null, 2)}\n`);
  const purge = await fetch(`${server.url}/admin/trash/purge`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf })
  });
  assert.equal(purge.status, 303);
  stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  assert.equal(stored.trash.length, 0);
  assert.equal(stored.media.length, 0);
  assert.equal(fs.existsSync(filePath), false);
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

test('scoped sanctions, warnings, upload-hash bans, and appeals preserve privacy', async t => {
  const server = await testServer(t, {
    adminPassword: 'admin-test-password',
    adminSessionSecret: 'admin-test-session-secret'
  });
  const original = await createThread(server.url, { subject: 'Sanction source', password: 'source-password' });

  const login = await fetch(`${server.url}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'admin-test-password' })
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const dashboard = await fetch(`${server.url}/admin`, { headers: { cookie } });
  const dashboardHtml = await dashboard.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(dashboardHtml)?.[1];
  assert.ok(csrf);

  const adminPost = (route, values) => fetch(`${server.url}${route}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf, ...values })
  });
  const attempt = async (boardUri, file = ONE_PIXEL_PNG, mime = 'image/png', filename = 'pixel.png') => {
    const form = new FormData();
    form.set('sub', `Attempt ${Date.now()}`);
    form.set('com', 'Sanction behavior attempt');
    form.set('pwd', 'attempt-password');
    form.set('upfile', new Blob([file], { type: mime }), filename);
    const route = boardUri ? `/${boardUri}/post?json=1` : '/post?json=1';
    const response = await fetch(`${server.url}${route}`, { method: 'POST', body: form });
    const body = await response.json();
    return { response, body };
  };

  const addBoard = await adminPost('/admin/boards/add', {
    uri: 'g',
    name: 'Technology',
    description: 'Technology board',
    category: 'Interests',
    enabled: '1'
  });
  assert.equal(addBoard.status, 303, await addBoard.text());

  const warning = await adminPost('/admin/sanction', {
    postId: String(original.id),
    kind: 'warning',
    target: 'poster',
    scope: 'board',
    duration: '0',
    reason: 'Please review the board rules.',
    reasonVisible: '1',
    moderatorNote: 'First-contact warning.'
  });
  assert.equal(warning.status, 303, await warning.text());
  const warnedAttempt = await attempt('chiko');
  assert.equal(warnedAttempt.response.status, 403);
  assert.match(warnedAttempt.body.error, /Staff warning: Please review the board rules/);
  const afterWarning = await attempt('chiko');
  assert.equal(afterWarning.response.status, 201, JSON.stringify(afterWarning.body));

  const localBan = await adminPost('/admin/sanction', {
    postId: String(original.id),
    kind: 'ban',
    target: 'poster',
    scope: 'board',
    duration: '3600000',
    reason: 'Local posting restriction.',
    reasonVisible: '1',
    moderatorNote: 'Visible only to staff.'
  });
  assert.equal(localBan.status, 303, await localBan.text());
  const locallyBlocked = await attempt('chiko');
  assert.equal(locallyBlocked.response.status, 403);
  assert.match(locallyBlocked.body.error, /Local posting restriction/);
  assert.match(locallyBlocked.body.appealUrl, /^\/appeals\/[a-f0-9-]+$/);

  const otherBoard = await attempt('g', ONE_PIXEL_GIF, 'image/gif', 'other.gif');
  assert.equal(otherBoard.response.status, 201, JSON.stringify(otherBoard.body));
  const publicAppealPage = await fetch(`${server.url}${locallyBlocked.body.appealUrl}`).then(response => response.text());
  assert.match(publicAppealPage, /Local posting restriction/);
  assert.doesNotMatch(publicAppealPage, /Visible only to staff/);

  const appealSubmission = await fetch(`${server.url}${locallyBlocked.body.appealUrl}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ message: 'I reviewed the rule and will avoid repeating the issue.' })
  });
  assert.equal(appealSubmission.status, 303, await appealSubmission.text());
  let stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  assert.equal(stored.appeals.length, 1);
  assert.equal(stored.appeals[0].status, 'open');

  const appealsPage = await fetch(`${server.url}/admin/appeals`, { headers: { cookie } });
  const appealsHtml = await appealsPage.text();
  assert.equal(appealsPage.status, 200);
  assert.match(appealsHtml, /I reviewed the rule/);
  assert.doesNotMatch(appealsHtml, /127\.0\.0\.1/);
  const accepted = await adminPost('/admin/appeals/resolve', {
    appealId: stored.appeals[0].id,
    decision: 'accepted',
    note: 'Restriction lifted after review.'
  });
  assert.equal(accepted.status, 303, await accepted.text());
  const afterAppeal = await attempt('chiko');
  assert.equal(afterAppeal.response.status, 201, JSON.stringify(afterAppeal.body));

  const fileBan = await adminPost('/admin/sanction', {
    postId: String(original.id),
    kind: 'ban',
    target: 'file',
    scope: 'board',
    duration: '0',
    reason: 'Internal banned-file reason.',
    reasonVisible: '0',
    moderatorNote: 'Hash-only sanction.'
  });
  assert.equal(fileBan.status, 303, await fileBan.text());
  const hashBlocked = await attempt('chiko');
  assert.equal(hashBlocked.response.status, 403);
  assert.doesNotMatch(hashBlocked.body.error, /Internal banned-file reason/);
  const differentFile = await attempt('chiko', ONE_PIXEL_GIF, 'image/gif', 'allowed.gif');
  assert.equal(differentFile.response.status, 201, JSON.stringify(differentFile.body));

  stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  assert.equal(stored.bans.length, 3);
  assert.equal(stored.bans.find(item => item.kind === 'warning').deliveredAt > 0, true);
  assert.equal(stored.bans.find(item => item.kind === 'warning').active, false);
  assert.equal(stored.bans.find(item => item.target === 'poster' && item.kind === 'ban').active, false);
  assert.equal(stored.bans.find(item => item.target === 'file').fileHash.length, 64);
  assert.equal(stored.appeals[0].status, 'accepted');
  assert.doesNotMatch(JSON.stringify(stored), /127\.0\.0\.1/);
});

test('report lifecycle preserves resolutions, audit history, and reporter privacy', async t => {
  const server = await testServer(t, {
    adminPassword: 'admin-test-password',
    adminSessionSecret: 'admin-test-session-secret'
  });
  const thread = await createThread(server.url);

  const threadPage = await fetch(`${server.url}/chiko/thread/${thread.id}`).then(response => response.text());
  assert.match(threadPage, /<select name="category">/);
  assert.match(threadPage, /Spam or flooding/);

  const unsafeReason = 'Spam <img src=x onerror=alert(1)>';
  const firstSubmission = await fetch(`${server.url}/report?json=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ postId: String(thread.id), category: 'spam', reason: unsafeReason })
  });
  const firstSubmissionBody = await firstSubmission.json();
  assert.equal(firstSubmission.status, 201, JSON.stringify(firstSubmissionBody));
  const firstReportId = firstSubmissionBody.reportId;

  const sameReporter = await fetch(`${server.url}/report?json=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ postId: String(thread.id), category: 'other', reason: 'A different reason' })
  });
  assert.equal(sameReporter.status, 409);

  const invalidCategory = await fetch(`${server.url}/report?json=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ postId: String(thread.id), category: 'not-configured', reason: 'Invalid category' })
  });
  assert.equal(invalidCategory.status, 400);

  const secondReport = await server.app.locals.chikochan.service.reportPost(
    thread.id,
    'Independent reporter reason',
    { category: 'harassment', clientKey: '198.51.100.9' }
  );

  const login = await fetch(`${server.url}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'admin-test-password' })
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const reportQueue = await fetch(`${server.url}/admin/reports`, { headers: { cookie } });
  const reportQueueHtml = await reportQueue.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(reportQueueHtml)?.[1];
  assert.equal(reportQueue.status, 200);
  assert.ok(csrf);
  assert.match(reportQueueHtml, /Spam or flooding/);
  assert.match(reportQueueHtml, /Harassment or personal information/);
  assert.match(reportQueueHtml, /Spam &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(reportQueueHtml, /<img src=x/);

  const missingCsrf = await fetch(`${server.url}/admin/reports/resolve`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ reportId: firstReportId, resolution: 'dismissed' })
  });
  assert.equal(missingCsrf.status, 403);

  const moderatorNote = '<script>moderator()</script>';
  const resolve = await fetch(`${server.url}/admin/reports/resolve`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({
      csrf,
      reportId: firstReportId,
      resolution: 'action-taken',
      note: moderatorNote
    })
  });
  assert.equal(resolve.status, 303, await resolve.text());

  let stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  const resolved = stored.reports.find(report => report.id === firstReportId);
  assert.equal(stored.reports.length, 2);
  assert.equal(resolved.status, 'closed');
  assert.equal(resolved.resolution, 'action-taken');
  assert.equal(resolved.moderatorNote, moderatorNote);
  assert.deepEqual(resolved.history.map(entry => entry.action), ['resolved']);
  assert.match(resolved.reporterKey, /^[A-Za-z0-9_-]{43}$/);
  assert.match(stored.reports.find(report => report.id === secondReport.id).reporterKey, /^[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(JSON.stringify(stored), /127\.0\.0\.1|198\.51\.100\.9/);

  const closedQueue = await fetch(`${server.url}/admin/reports?status=closed`, { headers: { cookie } });
  const closedQueueHtml = await closedQueue.text();
  assert.match(closedQueueHtml, /&lt;script&gt;moderator\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(closedQueueHtml, /<script>moderator/);

  const reopen = await fetch(`${server.url}/admin/reports/reopen`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf, reportId: firstReportId })
  });
  assert.equal(reopen.status, 303, await reopen.text());

  const legacyDismiss = await fetch(`${server.url}/admin/dismiss-report`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf, reportId: firstReportId })
  });
  assert.equal(legacyDismiss.status, 303, await legacyDismiss.text());

  const deleteTarget = await fetch(`${server.url}/admin/delete`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf, postId: String(thread.id) })
  });
  assert.equal(deleteTarget.status, 303, await deleteTarget.text());

  stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  assert.equal(stored.reports.length, 2);
  assert.equal(stored.reports.find(report => report.id === firstReportId).status, 'closed');
  const autoClosed = stored.reports.find(report => report.id === secondReport.id);
  assert.equal(autoClosed.status, 'closed');
  assert.equal(autoClosed.resolution, 'post-deleted');
  assert.ok(autoClosed.history.some(entry => entry.action === 'target-deleted'));
});
