'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp } = require('../app');
const { totpAt } = require('../lib/mfa');
const { canAssignRole, canManageAccount, staffCan } = require('../lib/staff');

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

async function testServer(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chikochan-staff-'));
  const app = createApp({
    storage: 'json',
    dataDir: directory,
    limits: { postRateLimit: 100, reportRateLimit: 100 },
    adminPassword: 'root-environment-password',
    adminSessionSecret: 'staff-test-session-secret',
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
  return { app, directory, url: `http://127.0.0.1:${address.port}` };
}

async function login(url, password, username = '', mfaCode = '') {
  const response = await fetch(`${url}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password, mfaCode })
  });
  return {
    response,
    cookie: response.headers.get('set-cookie')?.split(';')[0] || ''
  };
}

async function csrfAt(url, cookie, route = '/admin') {
  const response = await fetch(`${url}${route}`, { headers: { cookie } });
  const html = await response.text();
  return {
    response,
    html,
    csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1]
  };
}

async function postForm(url, route, cookie, values) {
  return fetch(`${url}${route}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams(values)
  });
}

async function createThread(url, boardUri, subject) {
  const form = new FormData();
  form.set('sub', subject);
  form.set('com', `${subject} body`);
  form.set('pwd', 'thread-password');
  form.set('upfile', new Blob([ONE_PIXEL_PNG], { type: 'image/png' }), `${boardUri}.png`);
  const response = await fetch(`${url}/${boardUri}/post?json=1`, { method: 'POST', body: form });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body;
}

test('role policy applies hierarchy and board-scoped moderation restrictions', () => {
  const root = { id: 'root', role: 'root', scope: 'global', boardIds: [], enabled: true };
  const admin = { id: 'admin', role: 'admin', scope: 'global', boardIds: [], enabled: true };
  const moderator = { id: 'mod', role: 'moderator', scope: 'boards', boardIds: ['chiko'], enabled: true };
  const janitor = { id: 'janitor', role: 'janitor', scope: 'boards', boardIds: ['chiko'], enabled: true };

  assert.equal(staffCan(root, 'staff.manage'), true);
  assert.equal(staffCan(admin, 'boards.manage'), true);
  assert.equal(staffCan(moderator, 'threads.manage', 'chiko'), true);
  assert.equal(staffCan(moderator, 'threads.manage', 'g'), false);
  assert.equal(staffCan(moderator, 'bans.manage', 'chiko'), true);
  assert.equal(staffCan(moderator, 'bans.manage', 'g'), false);
  assert.equal(staffCan(janitor, 'posts.delete', 'chiko'), true);
  assert.equal(staffCan(janitor, 'threads.manage', 'chiko'), false);
  assert.equal(canAssignRole(admin, 'moderator'), true);
  assert.equal(canAssignRole(admin, 'admin'), false);
  assert.equal(canManageAccount(admin, moderator), true);
  assert.equal(canManageAccount(admin, admin), false);
});

test('named board-scoped staff cannot cross board or escalate and sessions are revocable', async t => {
  const server = await testServer(t);
  const rootLogin = await login(server.url, 'root-environment-password');
  assert.equal(rootLogin.response.status, 303);
  const rootCookie = rootLogin.cookie;
  const rootDashboard = await csrfAt(server.url, rootCookie);
  assert.equal(rootDashboard.response.status, 200);
  assert.ok(rootDashboard.csrf);
  assert.match(rootDashboard.html, /href="\/admin\/staff"/);

  const addBoard = await postForm(server.url, '/admin/boards/add', rootCookie, {
    csrf: rootDashboard.csrf,
    uri: 'g',
    name: 'Technology',
    category: 'Interests',
    enabled: '1'
  });
  assert.equal(addBoard.status, 303, await addBoard.text());

  const createJanitor = await postForm(server.url, '/admin/staff/add', rootCookie, {
    csrf: rootDashboard.csrf,
    username: 'board.janitor',
    displayName: 'Board Janitor',
    password: 'janitor-password-123',
    role: 'janitor',
    scope: 'boards',
    boardIds: 'chiko'
  });
  assert.equal(createJanitor.status, 303, await createJanitor.text());

  let stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  assert.equal(stored.staff.length, 1);
  assert.match(stored.staff[0].passwordHash, /^scrypt\$/);
  assert.doesNotMatch(JSON.stringify(stored), /janitor-password-123/);
  assert.deepEqual(stored.staff[0].boardIds, ['chiko']);

  const chikoThread = await createThread(server.url, 'chiko', 'Scoped Chiko thread');
  const gThread = await createThread(server.url, 'g', 'Hidden technology thread');

  const janitorLogin = await login(server.url, 'janitor-password-123', 'board.janitor');
  assert.equal(janitorLogin.response.status, 303, await janitorLogin.response.text());
  const janitorCookie = janitorLogin.cookie;
  const janitorDashboard = await csrfAt(server.url, janitorCookie);
  assert.equal(janitorDashboard.response.status, 200);
  assert.ok(janitorDashboard.csrf);
  assert.match(janitorDashboard.html, /Board Janitor · Janitor · \/chiko\//);
  assert.match(janitorDashboard.html, /Scoped Chiko thread/);
  assert.doesNotMatch(janitorDashboard.html, /Hidden technology thread/);
  assert.doesNotMatch(janitorDashboard.html, /href="\/admin\/boards"/);
  assert.doesNotMatch(janitorDashboard.html, /Ban poster|Set sticky/);

  assert.equal((await fetch(`${server.url}/admin/boards`, { headers: { cookie: janitorCookie }, redirect: 'manual' })).status, 403);
  assert.equal((await fetch(`${server.url}/admin/staff`, { headers: { cookie: janitorCookie }, redirect: 'manual' })).status, 403);

  const crossBoardDelete = await postForm(server.url, '/admin/delete', janitorCookie, {
    csrf: janitorDashboard.csrf,
    postId: String(gThread.id)
  });
  assert.equal(crossBoardDelete.status, 403);

  const forbiddenThreadControl = await postForm(server.url, '/admin/thread-setting', janitorCookie, {
    csrf: janitorDashboard.csrf,
    threadId: String(chikoThread.id),
    flag: 'locked',
    value: '1'
  });
  assert.equal(forbiddenThreadControl.status, 403);

  const forbiddenBan = await postForm(server.url, '/admin/ban', janitorCookie, {
    csrf: janitorDashboard.csrf,
    postId: String(chikoThread.id),
    duration: '3600000',
    reason: 'Not allowed'
  });
  assert.equal(forbiddenBan.status, 403);

  const chikoReportResponse = await postForm(server.url, '/report?json=1', '', {
    postId: String(chikoThread.id),
    reason: 'Visible Chiko report'
  });
  assert.equal(chikoReportResponse.status, 201);
  const gReportResponse = await postForm(server.url, '/report?json=1', '', {
    postId: String(gThread.id),
    reason: 'Hidden technology report'
  });
  assert.equal(gReportResponse.status, 201);
  const reportData = server.app.locals.chikochan.service.getData().reports;
  const chikoReport = reportData.find(report => report.postId === chikoThread.id);
  const gReport = reportData.find(report => report.postId === gThread.id);
  const scopedReports = await csrfAt(server.url, janitorCookie, '/admin/reports');
  assert.equal(scopedReports.response.status, 200);
  assert.match(scopedReports.html, /Visible Chiko report/);
  assert.doesNotMatch(scopedReports.html, /Hidden technology report/);

  const crossBoardReport = await postForm(server.url, '/admin/reports/resolve', janitorCookie, {
    csrf: scopedReports.csrf,
    reportId: gReport.id,
    resolution: 'dismissed'
  });
  assert.equal(crossBoardReport.status, 403);
  const scopedResolution = await postForm(server.url, '/admin/reports/resolve', janitorCookie, {
    csrf: scopedReports.csrf,
    reportId: chikoReport.id,
    resolution: 'action-taken',
    note: 'Handled locally'
  });
  assert.equal(scopedResolution.status, 303, await scopedResolution.text());

  const allowedDelete = await postForm(server.url, '/admin/delete', janitorCookie, {
    csrf: janitorDashboard.csrf,
    postId: String(chikoThread.id)
  });
  assert.equal(allowedDelete.status, 303, await allowedDelete.text());
  assert.equal(server.app.locals.chikochan.service.getThread(gThread.id)?.boardId, 'g');
  assert.equal(server.app.locals.chikochan.service.getThread(chikoThread.id), null);

  const accountPage = await csrfAt(server.url, janitorCookie, '/admin/account');
  assert.equal(accountPage.response.status, 200);
  const rotatePassword = await postForm(server.url, '/admin/account', janitorCookie, {
    csrf: accountPage.csrf,
    displayName: 'Board Janitor',
    password: 'rotated-password-456'
  });
  assert.equal(rotatePassword.status, 303);
  assert.equal(rotatePassword.headers.get('location'), '/admin/login');
  assert.match(rotatePassword.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await fetch(`${server.url}/admin`, { headers: { cookie: janitorCookie }, redirect: 'manual' })).status, 303);
  assert.equal((await login(server.url, 'janitor-password-123', 'board.janitor')).response.status, 401);

  const rotatedLogin = await login(server.url, 'rotated-password-456', 'board.janitor');
  assert.equal(rotatedLogin.response.status, 303);
  const rotatedCookie = rotatedLogin.cookie;

  stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  const janitorAccount = stored.staff[0];
  const disable = await postForm(server.url, '/admin/staff/toggle', rootCookie, {
    csrf: rootDashboard.csrf,
    accountId: janitorAccount.id
  });
  assert.equal(disable.status, 303, await disable.text());
  const revoked = await fetch(`${server.url}/admin`, { headers: { cookie: rotatedCookie }, redirect: 'manual' });
  assert.equal(revoked.status, 303);
  assert.equal(revoked.headers.get('location'), '/admin/login');
  assert.match(revoked.headers.get('set-cookie'), /Max-Age=0/);

  stored = JSON.parse(fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8'));
  assert.equal(stored.staff[0].enabled, false);
  assert.ok(stored.moderationLog.some(entry => entry.actorName === 'board.janitor' && entry.action === 'delete'));
  assert.ok(stored.reports.find(report => report.id === chikoReport.id).history
    .some(entry => entry.actorName === 'board.janitor'));
  assert.doesNotMatch(JSON.stringify(stored), /127\.0\.0\.1/);
});

test('named administrators can manage lower roles but cannot create peer or root accounts', async t => {
  const server = await testServer(t);
  const rootLogin = await login(server.url, 'root-environment-password');
  const rootPage = await csrfAt(server.url, rootLogin.cookie);

  const createAdmin = await postForm(server.url, '/admin/staff/add', rootLogin.cookie, {
    csrf: rootPage.csrf,
    username: 'named.admin',
    displayName: 'Named Admin',
    password: 'named-admin-password',
    role: 'admin',
    scope: 'global'
  });
  assert.equal(createAdmin.status, 303, await createAdmin.text());

  const adminLogin = await login(server.url, 'named-admin-password', 'named.admin');
  assert.equal(adminLogin.response.status, 303);
  const staffPage = await csrfAt(server.url, adminLogin.cookie, '/admin/staff');
  assert.equal(staffPage.response.status, 200);
  assert.ok(staffPage.csrf);

  const createPeer = await postForm(server.url, '/admin/staff/add', adminLogin.cookie, {
    csrf: staffPage.csrf,
    username: 'peer.admin',
    password: 'peer-admin-password',
    role: 'admin',
    scope: 'global'
  });
  assert.equal(createPeer.status, 403);

  const createModerator = await postForm(server.url, '/admin/staff/add', adminLogin.cookie, {
    csrf: staffPage.csrf,
    username: 'board.mod',
    displayName: 'Board Moderator',
    password: 'moderator-password',
    role: 'moderator',
    scope: 'boards',
    boardIds: 'chiko'
  });
  assert.equal(createModerator.status, 303, await createModerator.text());

  const accounts = server.app.locals.chikochan.service.getStaffAccounts();
  const namedAdmin = accounts.find(account => account.username === 'named.admin');
  const selfDisable = await postForm(server.url, '/admin/staff/toggle', adminLogin.cookie, {
    csrf: staffPage.csrf,
    accountId: namedAdmin.id
  });
  assert.equal(selfDisable.status, 403);
  assert.deepEqual(accounts.map(account => account.username), ['board.mod', 'named.admin']);
});

test('named staff can enroll encrypted TOTP MFA and consume one-time recovery codes', async t => {
  const server = await testServer(t, {
    staffMfa: {
      enabled: true,
      issuer: 'ChikoChan Test',
      encryptionKey: '11'.repeat(32)
    }
  });
  const rootLogin = await login(server.url, 'root-environment-password');
  const rootPage = await csrfAt(server.url, rootLogin.cookie);
  const createModerator = await postForm(server.url, '/admin/staff/add', rootLogin.cookie, {
    csrf: rootPage.csrf,
    username: 'mfa.mod',
    displayName: 'MFA Moderator',
    password: 'mfa-moderator-password',
    role: 'moderator',
    scope: 'boards',
    boardIds: 'chiko'
  });
  assert.equal(createModerator.status, 303, await createModerator.text());

  const firstLogin = await login(server.url, 'mfa-moderator-password', 'mfa.mod');
  assert.equal(firstLogin.response.status, 303);
  const accountPage = await csrfAt(server.url, firstLogin.cookie, '/admin/account');
  assert.match(accountPage.html, /Start MFA setup/);
  const setup = await postForm(server.url, '/admin/account/mfa/setup', firstLogin.cookie, {
    csrf: accountPage.csrf,
    currentPassword: 'mfa-moderator-password'
  });
  const setupHtml = await setup.text();
  assert.equal(setup.status, 200, setupHtml);
  const secret = /<code>([A-Z2-7]{32})<\/code>/.exec(setupHtml)?.[1];
  const recoveryCode = /<code>([A-Z2-7]{4}(?:-[A-Z2-7]{4}){2})<\/code>/.exec(setupHtml)?.[1];
  assert.ok(secret);
  assert.ok(recoveryCode);
  let storedText = fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8');
  assert.equal(storedText.includes(secret), false);
  assert.equal(storedText.includes(recoveryCode), false);
  assert.match(storedText, /"mfaPendingSecret": "v1\./);

  const confirm = await postForm(server.url, '/admin/account/mfa/confirm', firstLogin.cookie, {
    csrf: accountPage.csrf,
    mfaCode: totpAt(secret)
  });
  assert.equal(confirm.status, 303, await confirm.text());
  assert.equal(confirm.headers.get('location'), '/admin/login');
  assert.match(confirm.headers.get('set-cookie'), /Max-Age=0/);

  const missingCode = await login(server.url, 'mfa-moderator-password', 'mfa.mod');
  assert.equal(missingCode.response.status, 401);
  const recoveryLogin = await login(server.url, 'mfa-moderator-password', 'mfa.mod', recoveryCode);
  assert.equal(recoveryLogin.response.status, 303, await recoveryLogin.response.text());
  const replay = await login(server.url, 'mfa-moderator-password', 'mfa.mod', recoveryCode);
  assert.equal(replay.response.status, 401);

  const enabledPage = await csrfAt(server.url, recoveryLogin.cookie, '/admin/account');
  assert.match(enabledPage.html, /TOTP MFA is enabled/);
  assert.equal(enabledPage.html.includes(secret), false);
  const disable = await postForm(server.url, '/admin/account/mfa/disable', recoveryLogin.cookie, {
    csrf: enabledPage.csrf,
    currentPassword: 'mfa-moderator-password',
    mfaCode: totpAt(secret)
  });
  assert.equal(disable.status, 303, await disable.text());
  assert.match(disable.headers.get('set-cookie'), /Max-Age=0/);

  storedText = fs.readFileSync(path.join(server.directory, 'posts.json'), 'utf8');
  const stored = JSON.parse(storedText).staff.find(account => account.username === 'mfa.mod');
  assert.equal(stored.mfaEnabled, false);
  assert.equal(Object.hasOwn(stored, 'mfaSecret'), false);
  assert.equal(Object.hasOwn(stored, 'mfaRecoveryHashes'), false);
  assert.equal((await login(server.url, 'mfa-moderator-password', 'mfa.mod')).response.status, 303);
});
