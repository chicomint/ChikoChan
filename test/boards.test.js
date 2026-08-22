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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chikochan-boards-'));
  const app = createApp({
    storage: 'json',
    dataDir: directory,
    limits: { postRateLimit: 100, reportRateLimit: 100 },
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

async function addBoard(url, cookie, values) {
  const dashboard = await fetch(`${url}/admin`, { headers: { cookie } });
  const html = await dashboard.text();
  assert.equal(dashboard.status, 200);
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
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
      category: values.category,
      enabled: values.enabled !== false ? '1' : '0'
    })
  });
  assert.equal(response.status, 303, await response.text());
}

async function createThread(url, boardUri, subject) {
  const form = new FormData();
  form.set('sub', subject);
  form.set('com', `${subject} body`);
  form.set('pwd', 'thread-password');
  form.set('upfile', new Blob([ONE_PIXEL_PNG], { type: 'image/png' }), 'pixel.png');
  const response = await fetch(`${url}/${boardUri}/post?json=1`, { method: 'POST', body: form });
  const body = await response.text();
  assert.equal(response.status, 201, body);
  return JSON.parse(body);
}

test('boards are isolated and appear on the homepage', async t => {
  const server = await testServer(t);
  const cookie = await adminCookie(server.url);
  await addBoard(server.url, cookie, { uri: 'g', name: 'Technology', category: 'Interests' });
  await addBoard(server.url, cookie, { uri: 'a', name: 'Anime', category: 'Interests' });

  const gThread = await createThread(server.url, 'g', 'Tech thread');
  const aThread = await createThread(server.url, 'a', 'Anime thread');
  const crossBoardForm = new FormData();
  crossBoardForm.set('resto', String(gThread.id));
  crossBoardForm.set('com', `Cross-board quote: >>${aThread.id}`);
  crossBoardForm.set('pwd', 'reply-password');
  const crossBoardResponse = await fetch(`${server.url}/g/post?json=1`, { method: 'POST', body: crossBoardForm });
  assert.equal(crossBoardResponse.status, 201, await crossBoardResponse.text());

  const home = await fetch(server.url);
  const homeHtml = await home.text();
  assert.equal(home.status, 200);
  assert.match(homeHtml, /Interests/);
  assert.match(homeHtml, /\/g\//);
  assert.match(homeHtml, /\/a\//);
  assert.match(homeHtml, /Total posts: 3/);

  const gPage = await fetch(`${server.url}/g/`);
  const gHtml = await gPage.text();
  assert.equal(gPage.status, 200);
  assert.match(gHtml, /Tech thread/);
  assert.doesNotMatch(gHtml, /Anime thread/);

  const aPage = await fetch(`${server.url}/a/`);
  const aHtml = await aPage.text();
  assert.equal(aPage.status, 200);
  assert.match(aHtml, /Anime thread/);
  assert.doesNotMatch(aHtml, /Tech thread/);

  const gThreadPage = await fetch(`${server.url}/g/thread/${gThread.threadId}`);
  const gThreadHtml = await gThreadPage.text();
  assert.equal(gThreadPage.status, 200);
  assert.match(gThreadHtml, /Tech thread body/);
  assert.match(gThreadHtml, new RegExp(`href="/a/thread/${aThread.id}#p${aThread.id}"`));

  const aThreadPage = await fetch(`${server.url}/a/thread/${aThread.threadId}`);
  const aThreadHtml = await aThreadPage.text();
  assert.equal(aThreadPage.status, 200);
  assert.match(aThreadHtml, /Anime thread body/);
  assert.match(aThreadHtml, new RegExp(`href="/g/thread/${gThread.id}#p${gThread.id + 2}"`));

  const boards = await fetch(`${server.url}/boards.json`).then(r => r.json());
  const uris = boards.boards.map(board => board.board);
  assert.ok(uris.includes('g'));
  assert.ok(uris.includes('a'));
});

test('admin can move boards up and down and the homepage keeps that order', async t => {
  const server = await testServer(t);
  const cookie = await adminCookie(server.url);
  await addBoard(server.url, cookie, { uri: 'g', name: 'Technology', category: 'Interests' });
  await addBoard(server.url, cookie, { uri: 'v', name: 'Video Games', category: 'Interests' });

  const boardsPage = await fetch(`${server.url}/admin/boards`, { headers: { cookie } });
  const boardsHtml = await boardsPage.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(boardsHtml)?.[1];
  assert.equal(boardsPage.status, 200);
  assert.ok(csrf);
  assert.match(boardsHtml, /action="\/admin\/boards\/move"/);

  async function move(uri, direction) {
    return fetch(`${server.url}/admin/boards/move`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ csrf, uri, direction })
    });
  }

  assert.deepEqual(server.app.locals.chikochan.service.getData().boards.map(board => board.uri), ['chiko', 'g', 'v']);
  assert.equal((await move('v', 'up')).status, 303);
  assert.deepEqual(server.app.locals.chikochan.service.getData().boards.map(board => board.uri), ['chiko', 'v', 'g']);

  let homeHtml = await fetch(server.url).then(response => response.text());
  assert.ok(homeHtml.indexOf('/v/') < homeHtml.indexOf('/g/'));

  assert.equal((await move('v', 'up')).status, 303);
  assert.deepEqual(server.app.locals.chikochan.service.getData().boards.map(board => board.uri), ['v', 'chiko', 'g']);
  homeHtml = await fetch(server.url).then(response => response.text());
  assert.ok(homeHtml.indexOf('Interests') < homeHtml.indexOf('General'));

  assert.equal((await move('v', 'sideways')).status, 400);
});

test('reserved and duplicate board URIs are rejected', async t => {
  const server = await testServer(t);
  const cookie = await adminCookie(server.url);

  const dashboard = await fetch(`${server.url}/admin`, { headers: { cookie } });
  const csrf = /name="csrf" value="([^"]+)"/.exec(await dashboard.text())?.[1];

  const duplicate = await fetch(`${server.url}/admin/boards/add`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf, uri: 'chiko', name: 'Duplicate', category: 'Other', enabled: '1' })
  });
  assert.equal(duplicate.status, 409);

  const reserved = await fetch(`${server.url}/admin/boards/add`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf, uri: 'admin', name: 'Reserved', category: 'Other', enabled: '1' })
  });
  assert.equal(reserved.status, 400);
});
