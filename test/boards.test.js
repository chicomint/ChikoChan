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
  assert.match(homeHtml, /class="board-directory"/);
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
  assert.ok(homeHtml.indexOf('/v/') < homeHtml.indexOf('/chiko/'));

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

test('board tags, sfw flag, and content filters are typed, escaped, and enforced', async t => {
  const server = await testServer(t);
  const cookie = await adminCookie(server.url);
  const dashboard = await fetch(`${server.url}/admin`, { headers: { cookie } });
  const csrf = /name="csrf" value="([^"]+)"/.exec(await dashboard.text())?.[1];
  assert.ok(csrf);

  const adminPost = (route, values) => fetch(`${server.url}${route}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ csrf, ...values })
  });

  const service = server.app.locals.chikochan.service;

  const badTags = await adminPost('/admin/boards/edit', {
    uri: 'chiko',
    settingsForm: '1',
    tags: 'valid <script>alert(1)</script>'
  });
  assert.equal(badTags.status, 400);
  assert.deepEqual(service.getData().boards[0].tags, []);

  const settings = await adminPost('/admin/boards/edit', {
    uri: 'chiko',
    settingsForm: '1',
    tags: 'Anime, GAMES anime retro',
    sfw: '1'
  });
  assert.equal(settings.status, 303, await settings.text());
  assert.deepEqual(service.getData().boards[0].tags, ['anime', 'games', 'retro']);
  assert.equal(service.getData().boards[0].sfw, true);

  const markNsfw = await adminPost('/admin/boards/edit', {
    uri: 'chiko',
    settingsForm: '1',
    tags: 'anime',
    sfw: '0'
  });
  assert.equal(markNsfw.status, 303, await markNsfw.text());
  assert.equal(service.getData().boards[0].sfw, false);

  const [boardPageHtml, boardsApi] = await Promise.all([
    fetch(`${server.url}/chiko/`).then(response => response.text()),
    fetch(`${server.url}/boards.json`).then(response => response.json())
  ]);
  assert.match(boardPageHtml, /<span class="board-tag">anime<\/span>/);
  assert.equal(boardsApi.boards[0].ws_board, 0);
  assert.equal(boardsApi.boards[0].sfw, false);
  assert.deepEqual(boardsApi.boards[0].tags, ['anime']);

  const noCsrf = await fetch(`${server.url}/admin/boards/filters/add`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ uri: 'chiko', kind: 'literal', value: 'unauthorized' })
  });
  assert.equal(noCsrf.status, 403);
  assert.equal(service.getData().boards[0].filters.length, 0);

  const badKind = await adminPost('/admin/boards/filters/add', {
    uri: 'chiko',
    kind: 'regex',
    value: '.*'
  });
  assert.equal(badKind.status, 400);

  const literal = await adminPost('/admin/boards/filters/add', {
    uri: 'chiko',
    kind: 'literal',
    value: 'Blocked Phrase',
    note: 'Not allowed here.'
  });
  assert.equal(literal.status, 303, await literal.text());
  const duplicate = await adminPost('/admin/boards/filters/add', {
    uri: 'chiko',
    kind: 'literal',
    value: 'blocked phrase'
  });
  assert.equal(duplicate.status, 409);

  const domain = await adminPost('/admin/boards/filters/add', {
    uri: 'chiko',
    kind: 'domain',
    value: 'Spam.Example'
  });
  assert.equal(domain.status, 303, await domain.text());

  const filters = service.getData().boards[0].filters;
  assert.equal(filters.length, 2);
  assert.deepEqual(filters.map(filter => [filter.kind, filter.value]), [
    ['literal', 'Blocked Phrase'],
    ['domain', 'spam.example']
  ]);

  async function postThread(comment) {
    const form = new FormData();
    form.set('sub', 'Filter probe');
    form.set('com', comment);
    form.set('upfile', new Blob([ONE_PIXEL_PNG], { type: 'image/png' }), 'probe.png');
    const response = await fetch(`${server.url}/chiko/post?json=1`, { method: 'POST', body: form });
    return { status: response.status, body: await response.text() };
  }

  const literalHit = await postThread('this contains a BLOCKED PHRASE inside');
  assert.equal(literalHit.status, 400);
  assert.match(literalHit.body, /Not allowed here\./);

  const domainHit = await postThread('visit https://spam.example/offer now');
  assert.equal(domainHit.status, 400);
  const subdomainHit = await postThread('visit https://cdn.spam.example/offer now');
  assert.equal(subdomainHit.status, 400);

  const clean = await postThread('visit https://spamexample.com/ and say blocked-phrase');
  assert.equal(clean.status, 201, clean.body);

  const settingsPage = await fetch(`${server.url}/admin/boards/chiko/settings`, { headers: { cookie } });
  const settingsHtml = await settingsPage.text();
  assert.match(settingsHtml, /<code>Blocked Phrase<\/code>/);
  assert.doesNotMatch(settingsHtml, /Blocked Phrase<script>/);

  const remove = await adminPost('/admin/boards/filters/delete', {
    uri: 'chiko',
    filterId: filters[0].id
  });
  assert.equal(remove.status, 303, await remove.text());
  assert.equal(service.getData().boards[0].filters.length, 1);
  const nowAllowed = await postThread('this contains a blocked phrase inside');
  assert.equal(nowAllowed.status, 201, nowAllowed.body);

  const actions = service.getData().moderationLog.map(entry => entry.action);
  assert.deepEqual(actions.slice(-3), ['board-filter-add', 'board-filter-add', 'board-filter-delete']);
});

test('global banner saves safely through authenticated customization and persists in JSON', async t => {
  const server = await testServer(t);
  const folder = path.join(server.app.locals.chikochan.config.rootDir, 'Banner');
  assert.ok(fs.statSync(folder).isDirectory());
  const filename = `test-banner-${process.pid}.png`;
  fs.writeFileSync(path.join(folder, filename), ONE_PIXEL_PNG);
  t.after(() => fs.rmSync(path.join(folder, filename), { force: true }));
  const cookie = await adminCookie(server.url);
  const page = await (await fetch(`${server.url}/admin/customization`, { headers: { cookie } })).text();
  assert.match(page, /<legend>Global Banner<\/legend>/);
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1];
  const save = values => fetch(`${server.url}/admin/customization`, {
    method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, bannerForm: '1', ...values })
  });
  assert.doesNotMatch(await (await fetch(`${server.url}/chiko/`)).text(), /class="global-banner"/);
  for (const values of [{ bannerImageUrl: 'javascript:alert(1)' }, { bannerLinkUrl: '//evil.example' }, { bannerEnabled: '1' }]) {
    assert.equal((await save(values)).status, 400);
  }
  const values = { bannerEnabled: '1', bannerFilename: filename, bannerLinkUrl: 'https://example.com/', bannerAlt: '"><script>bad</script>' };
  assert.equal((await save(values)).status, 303);
  const { JsonStore } = require('../lib/store');
  const reloaded = new JsonStore(server.app.locals.chikochan.config);
  assert.equal(reloaded.read().customization.globalBanner.enabled, true);
  assert.equal(reloaded.read().customization.globalBanner.filename, filename);
  assert.equal(Object.hasOwn(reloaded.read().customization.globalBanner, 'imageUrl'), false);
  assert.ok(page.includes(`<option value="${filename}"`));
  for (const bannerFilename of ['../secret.png', '../../secret.txt', '/etc/passwd', 'https://example.com/banner.png', 'missing.png', 'a\\b.png']) {
    assert.equal((await save({ bannerFilename })).status, 400);
  }
  const imageResponse = await fetch(`${server.url}/banner/${filename}`);
  assert.equal(imageResponse.status, 200);
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), ONE_PIXEL_PNG);
  for (const name of ['README.txt', '%2e%2e%2fsecret.png', '%2fetc%2fpasswd']) {
    assert.equal((await fetch(`${server.url}/banner/${name}`)).status, 404);
  }
  const thread = await createThread(server.url, 'chiko', 'Banner thread');
  for (const route of ['/', '/about', '/chiko/', '/chiko/catalog', '/chiko/archive', '/chiko/rules', `/chiko/thread/${thread.id}`]) {
    const response = await fetch(`${server.url}${route}`);
    assert.equal(response.status, 200, route);
    const html = await response.text();
    assert.match(html, /class="global-banner"><a href="https:\/\/example.com\/"/);
    assert.match(html, /alt="&quot;&gt;&lt;script&gt;bad&lt;\/script&gt;"/);
    assert.ok(html.includes(`src="/banner/${filename}"`));
    assert.doesNotMatch(response.headers.get('content-security-policy'), /img-src[^;]*https:\/\/example.com/);
  }
  assert.equal((await save({ ...values, bannerLinkUrl: '' })).status, 303);
  assert.match(await (await fetch(`${server.url}/chiko/`)).text(), /class="global-banner"><img/);
  fs.unlinkSync(path.join(folder, filename));
  const missing = await fetch(`${server.url}/chiko/`);
  assert.equal(missing.status, 200);
  assert.doesNotMatch(await missing.text(), /class="global-banner"/);
  const adminPage = await (await fetch(`${server.url}/admin/customization`, { headers: { cookie } })).text();
  assert.ok(!adminPage.includes(`<option value="${filename}"`));
  assert.equal((await fetch(`${server.url}/banner/${filename}`)).status, 404);
  fs.writeFileSync(path.join(folder, filename), ONE_PIXEL_PNG);
  assert.equal((await save({ ...values, bannerEnabled: '' })).status, 303);
  assert.doesNotMatch(await (await fetch(`${server.url}/chiko/`)).text(), /class="global-banner"/);
});

test('shared global navigation lists enabled boards and board actions stay below content', async t => {
  const server = await testServer(t);
  const cookie = await adminCookie(server.url);
  const navOf = html => /<nav class="board-list utility-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html)[1];
  const before = navOf(await (await fetch(server.url)).text());
  assert.ok(!before.includes('href="/g/"'));
  await addBoard(server.url, cookie, { uri: 'g', name: 'Technology', category: 'General' });
  const home = await (await fetch(server.url)).text();
  const globalNav = navOf(home);
  assert.match(globalNav, /href="\/g\/">\[\/g\/\]/);
  assert.doesNotMatch(globalNav, /\[Boards\]|#post-form|\/catalog|\/archive|\/rules/);
  assert.match(home, /class="board-directory"/);
  assert.match(home, /class="board-categories"/);
  assert.match(globalNav, /class="theme-selector"/);
  const directoryOf = html => /<section class="board-directory">([\s\S]*?)<\/section>/.exec(html)[1];
  assert.match(directoryOf(home), /<h3>General<\/h3>/);
  assert.match(directoryOf(home), /href="\/g\/"[^>]*>Technology<\/a>/);
  for (const page of ['about', 'contact', 'news', 'rules']) {
    assert.ok(!globalNav.includes(`href="/${page}"`));
    assert.ok(home.includes(`href="/${page}"`));
  }
  for (const route of ['/', '/overboard', '/search', '/about', '/contact', '/news', '/rules', '/admin/login', '/admin']) {
    const html = await (await fetch(server.url + route, { headers: { cookie } })).text();
    assert.equal(navOf(html), globalNav, route);
  }
  for (const board of ['chiko', 'g']) {
    const thread = await createThread(server.url, board, 'Navigation test');
    for (const route of ['', 'catalog', 'archive', 'rules', `thread/${thread.id}`]) {
      const html = await (await fetch(`${server.url}/${board}/${route}`)).text();
      assert.equal(navOf(html), globalNav, route);
      assert.doesNotMatch(html, /class="board-directory"/);
      const bottom = /<nav class="board-bottom-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html)[1];
      for (const action of ['catalog', 'archive', 'rules']) assert.ok(bottom.includes(`href="/${board}/${action}"`));
      assert.ok(bottom.includes('href="/"'));
      if (!route) {
        assert.ok(html.indexOf('class="board-bottom-nav"') > html.indexOf('id="post-form"'));
        assert.ok(html.indexOf('class="board-bottom-nav"') < html.indexOf('<main'));
      } else assert.ok(html.indexOf('class="board-bottom-nav"') > html.indexOf('</main>'));
      assert.equal((html.match(/class="board-bottom-nav"/g) || []).length, 1);
    }
  }
  const admin = await (await fetch(`${server.url}/admin/boards`, { headers: { cookie } })).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(admin)[1];
  const remove = await fetch(`${server.url}/admin/boards/delete`, {
    method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, uri: 'g' })
  });
  assert.equal(remove.status, 303, await remove.text());
  assert.equal(navOf(await (await fetch(server.url)).text()), before);
  assert.ok(!(await (await fetch(server.url)).text()).includes('href="/g/"'), 'Removed board leaves the directory');
  await addBoard(server.url, cookie, { uri: 'hidden', name: 'Disabled board', category: 'General' });
  await server.app.locals.chikochan.store.update(data => {
    data.boards.find(board => board.uri === 'hidden').enabled = false;
  });
  assert.equal(navOf(await (await fetch(server.url)).text()), before);
});

test('text routes reread editable source files and render safe HTML in the shared layout', async t => {
  const server = await testServer(t);
  const filename = path.join(server.directory, 'about.txt');
  const aboutPage = server.app.locals.chikochan.config.site.pages.about;
  const originalPath = aboutPage.sourcePath;
  t.after(() => { aboutPage.sourcePath = originalPath; });
  aboutPage.sourcePath = filename;
  fs.writeFileSync(filename, '# Fresh heading\n\n- First item\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))');
  let html = await (await fetch(`${server.url}/about`)).text();
  assert.match(html, /<h2>Fresh heading<\/h2>/);
  assert.match(html, /<li>First item<\/li>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /href="javascript:|<script>alert/);
  assert.match(html, /class="theme-selector"/);
  fs.writeFileSync(filename, 'Updated without restarting.');
  html = await (await fetch(`${server.url}/about`)).text();
  assert.match(html, /<p>Updated without restarting\.<\/p>/);
  for (const route of ['/contact', '/news', '/rules']) {
    const response = await fetch(server.url + route);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(await response.text(), /class="site-page-content"/);
  }
});

test('board index places one board menu after the posting form and before threads', async t => {
  const server = await testServer(t, { site: { announcement: 'Layout notice' } });
  const thread = await createThread(server.url, 'chiko', 'Layout test');
  const html = await (await fetch(`${server.url}/chiko/`)).text();
  const form = html.indexOf('id="post-form"');
  const notice = html.indexOf('<aside class="announcement">');
  const threads = html.indexOf('class="threads-container board-index-threads"');
  const bottom = html.indexOf('class="board-bottom-nav"');
  assert.doesNotMatch(html, /class="board-directory"/);
  assert.ok(form > 0 && form < notice && notice < bottom && bottom < threads);
  assert.ok(bottom < html.indexOf(`id="p${thread.id}"`));
  assert.equal((html.match(/class="board-bottom-nav"/g) || []).length, 1);
  assert.equal((html.match(/class="announcement"/g) || []).length, 1);
  assert.equal((html.match(/href="\/chiko\/catalog"/g) || []).length, 1);
  assert.equal((html.match(/href="\/"/g) || []).length, 2);
});

test('per-board banners persist, stay isolated, and fall back safely to the global banner', async t => {
  const server = await testServer(t);
  const cookie = await adminCookie(server.url);
  const { config, service } = server.app.locals.chikochan;
  const folder = path.join(config.rootDir, 'Banner');
  const names = ['global', 'g', 'v'].map(name => `board-test-${process.pid}-${name}.png`);
  const linkName = `board-test-${process.pid}-link.png`;
  t.after(() => {
    for (const name of [...names, linkName]) fs.rmSync(path.join(folder, name), { force: true });
  });
  for (const name of names) fs.writeFileSync(path.join(folder, name), ONE_PIXEL_PNG);
  fs.symlinkSync(path.join(folder, names[0]), path.join(folder, linkName));
  await addBoard(server.url, cookie, { uri: 'g', name: 'Technology' });
  await addBoard(server.url, cookie, { uri: 'v', name: 'Games' });
  const page = await (await fetch(`${server.url}/admin/boards/g/settings`, { headers: { cookie } })).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1];
  const post = (route, fields) => fetch(`${server.url}${route}`, {
    method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, ...fields })
  });
  const save = (uri, values = {}) => post('/admin/boards/edit', {
    uri, settingsForm: '1', boardBannerForm: '1', ...values
  });
  const global = enabled => post('/admin/customization', {
    bannerForm: '1', bannerEnabled: enabled ? '1' : '', bannerFilename: names[0]
  });
  const bannerAt = async route => {
    const response = await fetch(`${server.url}${route}`);
    assert.equal(response.status, 200, route);
    const html = await response.text();
    return html.match(/<div class="global-banner">[\s\S]*?<\/div>/)?.[0] || '';
  };
  for (const uri of ['g', 'v', 'chiko']) {
    const html = await (await fetch(`${server.url}/admin/boards/${uri}/settings`, { headers: { cookie } })).text();
    assert.match(html, /<legend>Board Banner<\/legend>/);
    assert.match(html, /name="boardBannerFilename"/);
    for (const name of names) assert.ok(html.includes(`<option value="${name}"`));
    assert.ok(!html.includes(`<option value="${linkName}"`));
    assert.equal(await bannerAt(`/${uri}/`), '');
  }
  assert.equal((await global(true)).status, 303);
  assert.ok((await bannerAt('/g/')).includes(names[0]));
  for (const [uri, filename] of [['g', names[1]], ['v', names[2]]]) {
    assert.equal((await save(uri, {
      boardBannerEnabled: '1', boardBannerFilename: filename,
      boardBannerLinkUrl: 'https://example.com/', boardBannerAlt: '"><script>bad</script>',
      bannerText: 'Preserved board text', boardTheme_replyBackground: '#abcdef'
    })).status, 303);
    const thread = await createThread(server.url, uri, `${uri} thread`);
    for (const route of [`/${uri}/`, `/${uri}/thread/${thread.id}`, `/${uri}/catalog`, `/${uri}/archive`, `/${uri}/rules`]) {
      const banner = await bannerAt(route);
      assert.ok(banner.includes(`/banner/${filename}`), route);
      assert.ok(!banner.includes(names[0]), route);
      assert.match(banner, /href="https:\/\/example.com\/"/);
      assert.match(banner, /alt="&quot;&gt;&lt;script&gt;bad&lt;\/script&gt;"/);
    }
  }
  for (const route of ['/', '/about', '/chiko/']) assert.ok((await bannerAt(route)).includes(names[0]));
  const { JsonStore } = require('../lib/store');
  const data = new JsonStore(config).read();
  const { documentsFromData, dataFromDocuments } = require('../lib/mongo-store');
  const restored = dataFromDocuments(documentsFromData(data));
  for (const [uri, filename] of [['g', names[1]], ['v', names[2]]]) {
    const board = data.boards.find(item => item.uri === uri);
    assert.equal(board.appearance.banner.filename, filename);
    assert.equal(board.appearance.banner.enabled, true);
    assert.equal(board.appearance.bannerText, 'Preserved board text');
    assert.equal(board.appearance.theme.replyBackground, '#abcdef');
    assert.deepEqual(restored.boards.find(item => item.uri === uri).appearance, board.appearance);
  }
  for (const filename of ['../outside.png', '/etc/passwd', 'https://example.com/a.png', 'missing.png', linkName]) {
    assert.equal((await save('g', { boardBannerFilename: filename })).status, 400, filename);
  }
  assert.equal((await save('g', { boardBannerEnabled: '1' })).status, 400);
  assert.equal((await save('g', { boardBannerFilename: names[1], boardBannerLinkUrl: 'javascript:alert(1)' })).status, 400);
  assert.equal(service.getData().boards.find(board => board.uri === 'g').appearance.banner.filename, names[1]);
  fs.unlinkSync(path.join(folder, names[1]));
  assert.ok((await bannerAt('/g/')).includes(names[0]));
  assert.ok((await bannerAt('/v/')).includes(names[2]));
  const missingPage = await (await fetch(`${server.url}/admin/boards/g/settings`, { headers: { cookie } })).text();
  assert.ok(!missingPage.includes(`<option value="${names[1]}"`));
  assert.equal((await global(false)).status, 303);
  assert.equal(await bannerAt('/g/'), '');
  assert.ok((await bannerAt('/v/')).includes(names[2]));
  assert.equal((await save('v', { boardBannerFilename: names[2] })).status, 303);
  assert.equal(await bannerAt('/v/'), '');
  assert.equal((await global(true)).status, 303);
  assert.ok((await bannerAt('/v/')).includes(names[0]));
});
