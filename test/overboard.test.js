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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chikochan-overboard-'));
  const app = createApp({
    storage: 'json',
    dataDir: directory,
    limits: { postRateLimit: 100, reportRateLimit: 100 },
    features: { requireImageForThread: false },
    adminPassword: 'admin-test-password',
    adminSessionSecret: 'admin-test-session-secret',
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

async function adminCookie(url) {
  const login = await fetch(`${url}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'admin-test-password' })
  });
  assert.equal(login.status, 303);
  return login.headers.get('set-cookie').split(';')[0];
}

async function adminTools(server, cookie) {
  const dashboard = await fetch(`${server.url}/admin`, { headers: { cookie } });
  const csrf = /name="csrf" value="([^"]+)"/.exec(await dashboard.text())?.[1];
  assert.ok(csrf);
  return (route, values) => fetch(`${server.url}${route}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf, ...values })
  });
}

async function addBoard(url, cookie, values) {
  const dashboard = await fetch(`${url}/admin`, { headers: { cookie } });
  const csrf = /name="csrf" value="([^"]+)"/.exec(await dashboard.text())?.[1];
  assert.ok(csrf);
  const response = await fetch(`${url}/admin/boards/add`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({
      csrf,
      uri: values.uri,
      name: values.name,
      description: values.description || '',
      category: values.category || 'General',
      enabled: values.enabled !== false ? '1' : '0'
    })
  });
  assert.equal(response.status, 303, await response.text());
}

async function createThread(url, boardUri, subject, withImage = true) {
  const form = new FormData();
  form.set('sub', subject);
  form.set('com', `${subject} body`);
  form.set('pwd', 'thread-password');
  if (withImage) {
    form.set('upfile', new Blob([ONE_PIXEL_PNG], { type: 'image/png' }), 'pixel.png');
  }
  const response = await fetch(`${url}/${boardUri}/post?json=1`, { method: 'POST', body: form });
  const body = await response.text();
  assert.equal(response.status, 201, body);
  return JSON.parse(body);
}

test('overboard lists recent threads from all enabled boards', async t => {
  const server = await testServer(t);
  const cookie = await adminCookie(server.url);
  await addBoard(server.url, cookie, { uri: 'g', name: 'Technology' });
  await addBoard(server.url, cookie, { uri: 'a', name: 'Anime' });
  await createThread(server.url, 'g', 'Tech overboard thread');
  await createThread(server.url, 'a', 'Anime overboard thread');

  const response = await fetch(`${server.url}/overboard`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Tech overboard thread/);
  assert.match(html, /Anime overboard thread/);
  assert.match(html, /href="\/g\/"/);
  assert.match(html, /href="\/a\/"/);
  assert.match(html, /0 replies/);
  assert.match(html, /class="overboard-thumb"/);
  assert.match(html, /<time class="overboard-date" datetime="[^"]+" title="[^"]+" aria-label="[^"]+Exact time: [^"]+">\d+ sec ago<\/time>/);

  const home = await fetch(server.url).then(result => result.text());
  assert.match(home, /href="\/overboard"/);
});

test('overboard excludes archived threads and threads from disabled boards', async t => {
  const server = await testServer(t);
  const cookie = await adminCookie(server.url);
  const adminPost = await adminTools(server, cookie);
  await addBoard(server.url, cookie, { uri: 'd', name: 'Doomed' });
  await createThread(server.url, 'd', 'Doomed board thread');

  const toggle = await adminPost('/admin/boards/toggle', { uri: 'd' });
  assert.equal(toggle.status, 303, await toggle.text());

  const limit = await adminPost('/admin/boards/edit', {
    uri: 'chiko',
    settingsForm: '1',
    maxThreads: '1'
  });
  assert.equal(limit.status, 303, await limit.text());
  await createThread(server.url, 'chiko', 'Soon archived thread', false);
  await createThread(server.url, 'chiko', 'Surviving thread', false);

  const response = await fetch(`${server.url}/overboard`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Surviving thread/);
  assert.doesNotMatch(html, /Soon archived thread/);
  assert.doesNotMatch(html, /Doomed board thread/);
});

test('sfw overboard excludes nsfw boards and navigation prefers the sfw variant', async t => {
  const server = await testServer(t);
  const cookie = await adminCookie(server.url);
  const adminPost = await adminTools(server, cookie);
  await addBoard(server.url, cookie, { uri: 'x', name: 'Explicit' });
  await createThread(server.url, 'x', 'Nsfw board thread', false);
  await createThread(server.url, 'chiko', 'Safe board thread', false);

  const markNsfw = await adminPost('/admin/boards/edit', {
    uri: 'x',
    settingsForm: '1',
    sfw: '0'
  });
  assert.equal(markNsfw.status, 303, await markNsfw.text());

  const plain = await fetch(`${server.url}/overboard`);
  const plainHtml = await plain.text();
  assert.equal(plain.status, 200);
  assert.match(plainHtml, /Nsfw board thread/);
  assert.match(plainHtml, /Safe board thread/);

  const sfw = await fetch(`${server.url}/overboard/sfw`);
  const sfwHtml = await sfw.text();
  assert.equal(sfw.status, 200);
  assert.doesNotMatch(sfwHtml, /Nsfw board thread/);
  assert.match(sfwHtml, /Safe board thread/);

  const home = await fetch(server.url).then(result => result.text());
  assert.match(home, /href="\/overboard\/sfw"/);
});

test('overboard paginates with a bounded page size and rejects invalid pages', async t => {
  const server = await testServer(t);
  const subjects = [];
  for (let index = 1; index <= 21; index += 1) {
    const subject = `Paged thread ${index}`;
    subjects.push(subject);
    await createThread(server.url, 'chiko', subject, false);
  }

  const pageOne = await fetch(`${server.url}/overboard`);
  const pageOneHtml = await pageOne.text();
  assert.equal(pageOne.status, 200);
  assert.equal((pageOneHtml.match(/class="overboard-thread"/g) || []).length, 20);
  assert.match(pageOneHtml, /href="\/overboard\?page=2"/);

  const pageTwo = await fetch(`${server.url}/overboard?page=2`);
  const pageTwoHtml = await pageTwo.text();
  assert.equal(pageTwo.status, 200);
  assert.equal((pageTwoHtml.match(/class="overboard-thread"/g) || []).length, 1);

  const combined = pageOneHtml + pageTwoHtml;
  for (const subject of subjects) assert.match(combined, new RegExp(subject));

  for (const page of ['3', '0', '-1', 'abc', '1.5']) {
    const response = await fetch(`${server.url}/overboard?page=${encodeURIComponent(page)}`);
    assert.equal(response.status, 404, `page=${page}`);
  }
});

test('overboard thumbnails never reference unapproved or quarantined media', async t => {
  const server = await testServer(t);
  const created = await createThread(server.url, 'chiko', 'Image thread');
  const { service, store } = server.app.locals.chikochan;
  const data = service.getData();
  const thread = data.threads.find(candidate => candidate.id === created.id);
  const attachment = thread.attachments[0];
  const imageName = path.basename(attachment.image);
  const thumbName = attachment.thumbnail ? path.basename(attachment.thumbnail) : '';

  const before = await fetch(`${server.url}/overboard`).then(response => response.text());
  assert.match(before, new RegExp(escapeRegExp(thumbName || imageName)));

  store.update(current => {
    for (const media of current.media) {
      if (media.path === attachment.image || media.thumbnail === attachment.thumbnail) {
        media.state = 'quarantined';
      }
    }
  });

  const after = await fetch(`${server.url}/overboard`).then(response => response.text());
  assert.match(after, /Image thread/);
  assert.doesNotMatch(after, new RegExp(escapeRegExp(imageName)));
  if (thumbName) assert.doesNotMatch(after, new RegExp(escapeRegExp(thumbName)));
});

test('overboard tag filter limits threads to boards carrying the tag', async t => {
  const server = await testServer(t);
  const cookie = await adminCookie(server.url);
  const adminPost = await adminTools(server, cookie);
  await addBoard(server.url, cookie, { uri: 'g', name: 'Technology' });
  await addBoard(server.url, cookie, { uri: 'a', name: 'Anime' });
  await createThread(server.url, 'g', 'Tagged tech thread', false);
  await createThread(server.url, 'a', 'Tagged anime thread', false);

  for (const [uri, tags] of [['g', 'tech'], ['a', 'anime']]) {
    const response = await adminPost('/admin/boards/edit', { uri, settingsForm: '1', tags });
    assert.equal(response.status, 303, await response.text());
  }

  const filtered = await fetch(`${server.url}/overboard?tag=anime`);
  const filteredHtml = await filtered.text();
  assert.equal(filtered.status, 200);
  assert.match(filteredHtml, /Tagged anime thread/);
  assert.doesNotMatch(filteredHtml, /Tagged tech thread/);
  assert.match(filteredHtml, /<strong>anime<\/strong>/);

  const missing = await fetch(`${server.url}/overboard?tag=missing`);
  const missingHtml = await missing.text();
  assert.equal(missing.status, 200);
  assert.doesNotMatch(missingHtml, /Tagged anime thread/);
  assert.match(missingHtml, /No threads to show/);

  const invalid = await fetch(`${server.url}/overboard?tag=${encodeURIComponent('<script>alert(1)</script>')}`);
  const invalidHtml = await invalid.text();
  assert.equal(invalid.status, 200);
  assert.match(invalidHtml, /Tagged anime thread/);
  assert.doesNotMatch(invalidHtml, /<script>alert\(1\)<\/script>/);
});

test('overboard escapes thread subjects and comments', async t => {
  const server = await testServer(t);
  await createThread(server.url, 'chiko', '<script>alert("xss")</script>', false);

  const response = await fetch(`${server.url}/overboard`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /&lt;script&gt;alert\(&quot;xss&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\("xss"\)<\/script>/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
