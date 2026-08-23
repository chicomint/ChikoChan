'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadConfig } = require('../config');
const { JsonStore, SCHEMA_VERSION } = require('../lib/store');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chikochan-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('migrates legacy data and stores references and backlinks', t => {
  const directory = temporaryDirectory(t);
  fs.writeFileSync(path.join(directory, 'posts.json'), JSON.stringify({
    lastId: 1,
    threads: [{
      id: 10,
      name: 'OP',
      comment: 'hello',
      createdAt: 100,
      bumpedAt: 200,
      replies: [{ id: 11, name: 'Reply', comment: '>>10\n>>10', createdAt: 200 }]
    }]
  }));

  const config = loadConfig({ dataDir: directory });
  const store = new JsonStore(config);
  const data = store.read();

  assert.equal(data.version, SCHEMA_VERSION);
  assert.equal(data.lastId, 11);
  assert.ok(data.meta.siteSecret.length >= 32);
  assert.deepEqual(data.threads[0].replies[0].references, [10]);
  assert.deepEqual(data.threads[0].backlinks, [{ id: 11, threadId: 10 }]);
});

test('migrates legacy board rules to stable structured records', t => {
  const directory = temporaryDirectory(t);
  fs.writeFileSync(path.join(directory, 'posts.json'), JSON.stringify({
    version: 4,
    boards: [{
      id: 'chiko',
      uri: 'chiko',
      name: 'ChikoChan',
      createdAt: 100,
      rules: [
        'Keep discussions civil.',
        { id: 'existing-rule', text: 'No spam.', createdAt: 200, updatedAt: 300 },
        '',
        null
      ]
    }],
    threads: []
  }));

  const config = loadConfig({ dataDir: directory });
  const store = new JsonStore(config);
  const data = store.read();

  assert.equal(data.version, SCHEMA_VERSION);
  assert.deepEqual(data.boards[0].rules.map(rule => rule.text), [
    'Keep discussions civil.',
    'No spam.'
  ]);
  assert.match(data.boards[0].rules[0].id, /^legacy-1-[a-f0-9]{12}$/);
  assert.deepEqual(data.boards[0].rules[1], {
    id: 'existing-rule',
    text: 'No spam.',
    createdAt: 200,
    updatedAt: 300
  });
  assert.equal(store.read().boards[0].rules[0].id, data.boards[0].rules[0].id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'posts.json'), 'utf8')).version, SCHEMA_VERSION);
});

test('migrates legacy reports without discarding open or closed history', t => {
  const directory = temporaryDirectory(t);
  fs.writeFileSync(path.join(directory, 'posts.json'), JSON.stringify({
    version: 5,
    boards: [{ id: 'chiko', uri: 'chiko', name: 'ChikoChan', createdAt: 50 }],
    threads: [{
      id: 10,
      boardId: 'chiko',
      comment: 'Reported post',
      createdAt: 100,
      replies: []
    }],
    reports: [
      { postId: 10, threadId: 10, reason: 'Legacy open report', createdAt: 200 },
      {
        id: 'closed-report',
        postId: 10,
        threadId: 10,
        reason: 'Legacy closed report',
        createdAt: 210,
        closedAt: 300,
        resolution: 'action-taken',
        moderatorNote: 'Handled'
      }
    ]
  }));

  const store = new JsonStore(loadConfig({ dataDir: directory }));
  const reports = store.read().reports;

  assert.equal(reports.length, 2);
  assert.match(reports[0].id, /^legacy-report-[a-f0-9]{16}$/);
  assert.equal(reports[0].boardId, 'chiko');
  assert.equal(reports[0].category, 'other');
  assert.equal(reports[0].status, 'open');
  assert.equal(reports[1].status, 'closed');
  assert.equal(reports[1].resolution, 'action-taken');
  assert.equal(reports[1].moderatorNote, 'Handled');
  assert.equal(store.read().reports[0].id, reports[0].id);
});

test('migrates legacy file fields into stable reference-counted media assets', t => {
  const directory = temporaryDirectory(t);
  fs.writeFileSync(path.join(directory, 'posts.json'), JSON.stringify({
    version: 7,
    boards: [{ id: 'chiko', uri: 'chiko', name: 'ChikoChan', createdAt: 50 }],
    threads: [{
      id: 10,
      boardId: 'chiko',
      comment: 'Legacy image',
      createdAt: 100,
      image: 'src/legacy.png',
      imageName: 'legacy.png',
      imageMime: 'image/png',
      imageBytes: 123,
      width: 20,
      height: 10,
      sha256: 'a'.repeat(64),
      replies: [{
        id: 11,
        comment: 'Same legacy path',
        createdAt: 110,
        image: 'src/legacy.png',
        imageName: 'copy.png',
        imageMime: 'image/png',
        imageBytes: 123,
        width: 20,
        height: 10,
        sha256: 'a'.repeat(64)
      }]
    }]
  }));

  const store = new JsonStore(loadConfig({ dataDir: directory }));
  const data = store.read();

  assert.equal(data.version, SCHEMA_VERSION);
  assert.equal(data.media.length, 1);
  assert.match(data.media[0].id, /^legacy-media-[a-f0-9]{24}$/);
  assert.equal(data.media[0].refCount, 2);
  assert.equal(data.media[0].path, 'src/legacy.png');
  assert.equal(data.threads[0].assetId, data.media[0].id);
  assert.equal(data.threads[0].replies[0].assetId, data.media[0].id);
  assert.equal(data.threads[0].attachments.length, 1);
  assert.equal(data.threads[0].attachments[0].image, data.threads[0].image);
  assert.equal(data.threads[0].attachments[0].assetId, data.threads[0].assetId);
  assert.equal(store.read().media[0].refCount, 2);
});

test('normalizes multiple attachments while mirroring the legacy first-file fields', t => {
  const directory = temporaryDirectory(t);
  fs.writeFileSync(path.join(directory, 'posts.json'), JSON.stringify({
    version: 11,
    boards: [{ id: 'chiko', uri: 'chiko', name: 'ChikoChan', createdAt: 50 }],
    threads: [{
      id: 10,
      boardId: 'chiko',
      comment: 'Two files',
      createdAt: 100,
      attachments: [{
        id: 'first-file',
        image: 'src/first.png',
        imageName: 'first.png',
        imageMime: 'image/png',
        sha256: 'a'.repeat(64),
        spoiler: true
      }, {
        id: 'second-file',
        image: 'src/second.gif',
        imageName: 'second.gif',
        imageMime: 'image/gif',
        sha256: 'b'.repeat(64),
        spoiler: true
      }],
      replies: []
    }]
  }));

  const data = new JsonStore(loadConfig({ dataDir: directory })).read();
  const post = data.threads[0];
  assert.equal(data.version, SCHEMA_VERSION);
  assert.equal(post.attachments.length, 2);
  assert.equal(post.image, post.attachments[0].image);
  assert.equal(post.imageName, 'first.png');
  assert.equal(post.assetId, post.attachments[0].assetId);
  assert.equal(post.spoiler, true);
  assert.equal(data.media.length, 2);
  assert.deepEqual(data.media.map(asset => asset.refCount), [1, 1]);
  assert.deepEqual(new JsonStore(loadConfig({ dataDir: directory })).read().threads[0].attachments, post.attachments);
});

test('migrates legacy bans as global sanctions and retains appeal history', t => {
  const directory = temporaryDirectory(t);
  fs.writeFileSync(path.join(directory, 'posts.json'), JSON.stringify({
    version: 8,
    boards: [{ id: 'chiko', uri: 'chiko', name: 'ChikoChan', createdAt: 50 }],
    threads: [],
    bans: [{
      id: 'legacy-ban',
      boardId: 'chiko',
      posterKey: 'P'.repeat(43),
      reason: 'Legacy reason',
      createdAt: 100,
      active: true
    }],
    appeals: [{
      id: 'existing-appeal',
      sanctionId: 'legacy-ban',
      message: 'Please reconsider this legacy restriction.',
      status: 'denied',
      createdAt: 200,
      resolvedAt: 300,
      staffNote: 'Decision retained.'
    }]
  }));

  const store = new JsonStore(loadConfig({ dataDir: directory }));
  const data = store.read();
  const sanction = data.bans[0];

  assert.equal(sanction.kind, 'ban');
  assert.equal(sanction.target, 'poster');
  assert.equal(sanction.scope, 'global');
  assert.equal(sanction.boardId, '');
  assert.equal(sanction.reasonVisible, true);
  assert.match(sanction.appealId, /^appeal-[a-f0-9]{24}$/);
  assert.equal(data.appeals[0].sanctionId, sanction.id);
  assert.equal(data.appeals[0].status, 'denied');
  assert.equal(data.appeals[0].staffNote, 'Decision retained.');
});

test('migrates lifecycle trash and revisions without losing retained media', t => {
  const directory = temporaryDirectory(t);
  fs.writeFileSync(path.join(directory, 'posts.json'), JSON.stringify({
    version: 9,
    lastId: 1,
    boards: [{ id: 'chiko', uri: 'chiko', name: 'ChikoChan', createdAt: 50 }],
    threads: [{
      id: 10,
      boardId: 'chiko',
      title: 'Archived thread',
      comment: 'Archived body',
      createdAt: 100,
      archived: true,
      archivedAt: 200,
      replies: []
    }],
    trash: [{
      id: 'trash-one',
      kind: 'reply',
      boardId: 'chiko',
      threadId: 10,
      postId: 11,
      position: 0,
      post: {
        id: 11,
        name: 'Deleted reply',
        comment: 'Retained media',
        createdAt: 150,
        image: 'src/retained.png',
        imageName: 'retained.png',
        imageMime: 'image/png',
        sha256: 'b'.repeat(64)
      },
      deletedAt: 300,
      purgeAt: 400,
      deletedByName: 'test.mod'
    }],
    revisions: [{
      id: 'revision-one',
      postId: 10,
      threadId: 10,
      boardId: 'chiko',
      before: { title: 'Old', comment: 'Before' },
      after: { title: 'Archived thread', comment: 'Archived body' },
      reason: 'Correction',
      editedAt: 250,
      editedByName: 'test.mod'
    }]
  }));

  const data = new JsonStore(loadConfig({ dataDir: directory })).read();
  assert.equal(data.version, SCHEMA_VERSION);
  assert.equal(data.lastId, 11);
  assert.equal(data.threads[0].archived, true);
  assert.equal(data.threads[0].archivedAt, 200);
  assert.equal(data.trash[0].post.id, 11);
  assert.equal(data.trash[0].purgeAt, 400);
  assert.equal(data.revisions[0].before.comment, 'Before');
  assert.equal(data.media.length, 1);
  assert.equal(data.media[0].refCount, 1);
  assert.equal(data.trash[0].post.assetId, data.media[0].id);
});

test('normalizes structured customization and typed board overrides safely', t => {
  const directory = temporaryDirectory(t);
  fs.writeFileSync(path.join(directory, 'posts.json'), JSON.stringify({
    version: 10,
    boards: [{
      id: 'chiko',
      uri: 'chiko',
      name: 'ChikoChan',
      settings: {
        requireImageForThread: false,
        showPosterIds: true,
        maxThreads: 5,
        bumpLimit: -2,
        anonymousName: 'BoardAnon'
      },
      appearance: {
        bannerText: '<script>plain text</script>',
        bannerPath: 'javascript:alert(1)',
        theme: { replyBackground: '#AABBCC', text: 'expression(alert(1))' }
      }
    }],
    threads: [],
    customization: {
      title: 'Custom site',
      logoPath: '/banner.png',
      faviconPath: 'data:text/html,unsafe',
      navigation: [
        { label: 'FAQ', href: '/pages/faq' },
        { label: 'Unsafe', href: 'javascript:alert(1)' }
      ],
      theme: { background: '#112233', link: 'url(unsafe)' },
      pages: [
        { slug: 'faq', title: 'FAQ', content: '<script>plain text</script>' },
        { slug: '../unsafe', title: 'Unsafe', content: 'discard me' }
      ]
    }
  }));

  const data = new JsonStore(loadConfig({ dataDir: directory })).read();
  assert.equal(data.version, SCHEMA_VERSION);
  assert.deepEqual(data.boards[0].settings, {
    requireImageForThread: false,
    showPosterIds: true,
    maxThreads: 5,
    anonymousName: 'BoardAnon'
  });
  assert.equal(data.boards[0].appearance.bannerPath, '');
  assert.deepEqual(data.boards[0].appearance.theme, { replyBackground: '#aabbcc' });
  assert.equal(data.customization.faviconPath, '');
  assert.deepEqual(data.customization.navigation, [{ label: 'FAQ', href: '/pages/faq' }]);
  assert.deepEqual(data.customization.theme, { background: '#112233' });
  assert.equal(data.customization.pages.length, 1);
  assert.equal(data.customization.pages[0].content, '<script>plain text</script>');
});

test('refuses to erase malformed JSON', t => {
  const directory = temporaryDirectory(t);
  fs.writeFileSync(path.join(directory, 'posts.json'), '{ definitely not JSON');
  const config = loadConfig({ dataDir: directory });

  assert.throws(() => new JsonStore(config), /left untouched/);
  assert.equal(fs.readFileSync(path.join(directory, 'posts.json'), 'utf8'), '{ definitely not JSON');
});

test('refuses plaintext or unsupported staff password hashes without rewriting data', t => {
  const directory = temporaryDirectory(t);
  const filePath = path.join(directory, 'posts.json');
  const original = JSON.stringify({
    boards: [{ id: 'chiko', uri: 'chiko', name: 'ChikoChan' }],
    threads: [],
    staff: [{
      id: 'unsafe-account',
      username: 'unsafe.user',
      displayName: 'Unsafe User',
      passwordHash: 'plaintext-password',
      role: 'janitor',
      scope: 'boards',
      boardIds: ['chiko']
    }]
  });
  fs.writeFileSync(filePath, original);

  assert.throws(() => new JsonStore(loadConfig({ dataDir: directory })), /unsupported password hash/);
  assert.equal(fs.readFileSync(filePath, 'utf8'), original);
});
