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

  const reservedPage = await fetch(`${server.url}/admin/boards/add`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf, uri: 'rules', name: 'Conflicting rules board', category: 'Other', enabled: '1' })
  });
  assert.equal(reservedPage.status, 400);
});

test('admin manages escaped per-board rules exposed through HTML and JSON', async t => {
  const server = await testServer(t);
  const cookie = await adminCookie(server.url);
  const adminRules = await fetch(`${server.url}/admin/boards/chiko/rules`, { headers: { cookie } });
  const adminRulesHtml = await adminRules.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(adminRulesHtml)?.[1];
  assert.equal(adminRules.status, 200);
  assert.ok(csrf);

  const originalText = 'Be kind <script>alert("x")</script>\nNo spam.';
  const add = await fetch(`${server.url}/admin/boards/rules/add`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf, uri: 'chiko', text: originalText })
  });
  assert.equal(add.status, 303, await add.text());

  const storedRule = server.app.locals.chikochan.service.getData().boards[0].rules[0];
  assert.equal(storedRule.text, originalText);
  assert.match(storedRule.id, /^[a-f0-9-]{36}$/);
  assert.match(add.headers.get('location'), new RegExp(`^/admin/boards/chiko/rules#rule-${storedRule.id}$`));

  const publicRules = await fetch(`${server.url}/chiko/rules`);
  const publicRulesHtml = await publicRules.text();
  assert.equal(publicRules.status, 200);
  assert.match(publicRulesHtml, /Be kind &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;<br>No spam\./);
  assert.doesNotMatch(publicRulesHtml, /<script>alert/);
  assert.match(publicRulesHtml, /href="\/rules">global rules<\/a>/);

  const legacyHtmlPath = await fetch(`${server.url}/chiko/rules.html`);
  assert.equal(legacyHtmlPath.status, 200);
  const rulesJsonResponse = await fetch(`${server.url}/chiko/rules.json`);
  assert.equal(rulesJsonResponse.status, 200);
  assert.deepEqual(await rulesJsonResponse.json(), [originalText]);
  assert.equal((await fetch(`${server.url}/rules`)).status, 200);

  const duplicate = await fetch(`${server.url}/admin/boards/rules/add`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf, uri: 'chiko', text: originalText })
  });
  assert.equal(duplicate.status, 409);

  const tooLong = await fetch(`${server.url}/admin/boards/rules/add`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf, uri: 'chiko', text: 'x'.repeat(513) })
  });
  assert.equal(tooLong.status, 400);

  const missingCsrf = await fetch(`${server.url}/admin/boards/rules/edit`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ uri: 'chiko', ruleId: storedRule.id, text: 'Unauthorized edit' })
  });
  assert.equal(missingCsrf.status, 403);
  assert.equal(server.app.locals.chikochan.service.getData().boards[0].rules[0].text, originalText);

  const edit = await fetch(`${server.url}/admin/boards/rules/edit`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf, uri: 'chiko', ruleId: storedRule.id, text: 'Stay on topic.' })
  });
  assert.equal(edit.status, 303, await edit.text());
  assert.deepEqual(await fetch(`${server.url}/chiko/rules.json`).then(response => response.json()), ['Stay on topic.']);

  const remove = await fetch(`${server.url}/admin/boards/rules/delete`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf, uri: 'chiko', ruleId: storedRule.id })
  });
  assert.equal(remove.status, 303, await remove.text());
  assert.deepEqual(await fetch(`${server.url}/chiko/rules.json`).then(response => response.json()), []);

  const actions = server.app.locals.chikochan.service.getData().moderationLog.map(entry => entry.action);
  assert.deepEqual(actions.slice(-3), ['board-rule-add', 'board-rule-edit', 'board-rule-delete']);
});

test('structured customization and board policies stay escaped, typed, and board-scoped', async t => {
  const server = await testServer(t);
  const cookie = await adminCookie(server.url);
  const customizationPage = await fetch(`${server.url}/admin/customization`, { headers: { cookie } });
  const customizationHtml = await customizationPage.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(customizationHtml)?.[1];
  assert.equal(customizationPage.status, 200);
  assert.ok(csrf);

  const adminPost = (route, values) => fetch(`${server.url}${route}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf, ...values })
  });

  const missingCsrf = await fetch(`${server.url}/admin/customization`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ title: 'Unauthorized' })
  });
  assert.equal(missingCsrf.status, 403);

  const unsafePath = await adminPost('/admin/customization', {
    title: 'Unsafe',
    logoPath: 'javascript:alert(1)',
    navigation: '',
    theme_background: '#112233'
  });
  assert.equal(unsafePath.status, 400);

  const unsafeNavigation = await adminPost('/admin/customization', {
    title: 'Unsafe',
    logoPath: '',
    faviconPath: '',
    navigation: 'Outside | https://example.com'
  });
  assert.equal(unsafeNavigation.status, 400);

  const customize = await adminPost('/admin/customization', {
    title: 'Chiko <script>alert(1)</script>',
    description: 'A safe <b>description</b>',
    announcement: 'Announcement <img src=x onerror=alert(1)>',
    footerText: 'Footer <strong>text</strong>',
    logoPath: '/banner.png',
    faviconPath: '/chikki.ico',
    navigation: 'FAQ | /pages/faq',
    theme_background: '#112233',
    theme_replyBackground: '#ddeeff'
  });
  assert.equal(customize.status, 303, await customize.text());

  const addPageResponse = await adminPost('/admin/customization/pages/add', {
    slug: 'faq',
    title: 'Frequently <asked>',
    content: 'Plain text only\n<script>alert("page")</script>',
    showInFooter: '1'
  });
  assert.equal(addPageResponse.status, 303, await addPageResponse.text());

  const [homeHtml, customPageHtml, customCss] = await Promise.all([
    fetch(server.url).then(response => response.text()),
    fetch(`${server.url}/pages/faq`).then(response => response.text()),
    fetch(`${server.url}/custom.css`).then(response => response.text())
  ]);
  assert.match(homeHtml, /Chiko &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(homeHtml, /href="\/pages\/faq"/);
  assert.match(homeHtml, /Footer &lt;strong&gt;text&lt;\/strong&gt;/);
  assert.doesNotMatch(homeHtml, /<img src=x onerror/);
  assert.match(customPageHtml, /&lt;script&gt;alert\(&quot;page&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(customPageHtml, /<script>alert\("page"\)<\/script>/);
  assert.match(customCss, /:root\{[^}]*--bg-color:#112233/);
  assert.match(customCss, /--reply-bg:#ddeeff/);
  assert.doesNotMatch(customCss, /javascript|<script/i);

  const settingsPage = await fetch(`${server.url}/admin/boards/chiko/settings`, { headers: { cookie } });
  assert.equal(settingsPage.status, 200);
  const settings = await adminPost('/admin/boards/edit', {
    uri: 'chiko',
    settingsForm: '1',
    requireImageForThread: '0',
    allowVideoUploads: '0',
    allowSpoilers: '0',
    showPosterIds: '1',
    allowSage: '0',
    rejectDuplicateImages: '',
    anonymousName: 'BoardAnon',
    maxThreads: '1',
    bumpLimit: '2',
    replyLimit: '3',
    maxFilesPerPost: '2',
    bannerText: 'Banner <script>unsafe</script>',
    bannerPath: '',
    boardTheme_replyBackground: '#abcdef'
  });
  assert.equal(settings.status, 303, await settings.text());

  async function textThread(subject) {
    const form = new FormData();
    form.set('sub', subject);
    form.set('com', `${subject} body`);
    const response = await fetch(`${server.url}/chiko/post?json=1`, { method: 'POST', body: form });
    const body = await response.text();
    assert.equal(response.status, 201, body);
    return JSON.parse(body);
  }

  const first = await textThread('First policy thread');
  const second = await textThread('Second policy thread');
  const data = server.app.locals.chikochan.service.getData();
  assert.equal(data.boards[0].settings.requireImageForThread, false);
  assert.equal(data.boards[0].settings.allowVideoUploads, false);
  assert.equal(data.boards[0].settings.showPosterIds, true);
  assert.equal(data.boards[0].settings.maxFilesPerPost, 2);
  assert.equal(data.threads.find(thread => thread.id === first.id).archived, true);
  assert.equal(data.threads.find(thread => thread.id === second.id).name, 'BoardAnon');
  assert.ok(data.threads.find(thread => thread.id === second.id).posterId);

  const sage = new FormData();
  sage.set('resto', String(second.id));
  sage.set('com', 'Disallowed sage');
  sage.set('email', 'sage');
  const sageResponse = await fetch(`${server.url}/chiko/post?json=1`, { method: 'POST', body: sage });
  assert.equal(sageResponse.status, 403);

  const spoiler = new FormData();
  spoiler.set('com', 'Disallowed spoiler');
  spoiler.set('spoiler', '1');
  spoiler.set('upfile', new Blob([ONE_PIXEL_PNG], { type: 'image/png' }), 'spoiler.png');
  const spoilerResponse = await fetch(`${server.url}/chiko/post?json=1`, { method: 'POST', body: spoiler });
  assert.equal(spoilerResponse.status, 403);

  const [boardPageHtml, boardCss, archiveIds, boardsApi] = await Promise.all([
    fetch(`${server.url}/chiko/`).then(response => response.text()),
    fetch(`${server.url}/custom.css`).then(response => response.text()),
    fetch(`${server.url}/chiko/archive.json`).then(response => response.json()),
    fetch(`${server.url}/boards.json`).then(response => response.json())
  ]);
  assert.doesNotMatch(boardPageHtml, /sage \(do not bump\)/);
  assert.doesNotMatch(boardPageHtml, /name="spoiler"/);
  assert.match(boardPageHtml, /Banner &lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.doesNotMatch(boardPageHtml, /First policy thread/);
  assert.match(boardCss, /body\[data-board="chiko"\]\{--reply-bg:#abcdef/);
  assert.deepEqual(archiveIds, [first.id]);
  assert.equal(boardsApi.boards[0].max_webm_filesize, 0);
  assert.equal(boardsApi.boards[0].user_ids, 1);
  assert.equal(boardsApi.boards[0].max_files_per_post, 2);
});
