'use strict';

// Uses disposable storage. Playwright and Chromium are supplied separately so
// browser tooling does not become a production dependency.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const sharp = require('sharp');
const { createApp } = require('../app');
const { closeApplication } = require('../lib/bootstrap');
const { encryptionKey } = require('../lib/settings');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chiko-redesign-browser-'));
  const keyFile = path.join(directory, 'key'); encryptionKey(keyFile, true);
  const app = createApp({ storage: 'json', dataDir: directory, keyFile,
    adminPassword: 'browser-admin-password', adminSessionSecret: 'browser-admin-session-secret',
    features: { requireImageForThread: false }, limits: { postRateLimit: 100 },
    postingAuthorization: { enabled: true, secret: 'redesign-browser-posting-authorization-test-secret' },
    antiAbuse: { turnstile: { enabled: true, siteKey: 'test-key', secretKey: 'test-secret' } },
    turnstileFetch: async (_url, options) => ({ ok: true, text: async () => JSON.stringify({ success: options.body.get('response') === 'browser-test-token', action: 'post', hostname: 'localhost' }) }) });
  const { service, store } = app.locals.chikochan;
  await store.ready;
  const board = service.getDefaultBoard();
  store.update(data => {
    data.boards.push(...[['g', 'Technology', 'Interests'], ['v', 'Video Games', 'Interests'], ['adv', 'Advice', 'Other']].map(([uri, name, category], index) => ({ ...structuredClone(board), id: uri, uri, name, category, order: index === 2 ? 3 : index })));
    Object.assign(data.boards[0], { category: 'Other', order: 2 });
    for (const version of ['draft', 'published']) data.customization.homepage[version].sections.find(section => section.type === 'activeThreads').style.height = 500;
  });
  const thread = await service.createThread({ title: 'A little place to talk', comment: 'Browser fixture: violet across boards.', name: 'Anonymous' }, null, { boardId: board.id, clientKey: 'fixture' });
  await service.createThread({ title: 'Technology', comment: 'Another violet test on /g/.' }, null, { boardId: 'g', clientKey: 'fixture-g' });
  const image = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#39c5bb' } }).png().toBuffer();
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.argv[3] || undefined });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route('https://challenges.cloudflare.com/**', route => route.fulfill({ contentType: 'application/javascript', body: `window.turnstile={render:function(el){var input=document.createElement('input');input.type='hidden';input.name='cf-turnstile-response';input.value='browser-test-token';el.appendChild(input);return 'test';},reset:function(){}};` }));
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('.nav-search-dialog'));
    const active = await page.locator('.home-activeThreads').boundingBox(), boards = await page.locator('.home-boards').boundingBox();
    assert.ok(Math.abs(active.y - boards.y) < 2 && boards.x > active.x, 'Boards sits beside Active Threads');
    const latestImages = await page.locator('.home-latestImages').boundingBox(), latestPosts = await page.locator('.home-latestPosts').boundingBox();
    assert.ok(Math.abs(latestImages.y - latestPosts.y) < 2 && latestImages.width < latestPosts.width, 'Latest images is left of wider latest posts');
    assert.equal(await page.locator('.site-banner-img').evaluate(node => getComputedStyle(node).borderRadius), '0px');
    assert.equal(await page.locator('.home-boards').evaluate(node => getComputedStyle(node).borderTopLeftRadius), '4px');
    assert.equal(await page.locator('.home-boards').evaluate(node => getComputedStyle(node).borderBottomLeftRadius), '0px');
    await page.evaluate(() => scrollTo(0, 800));
    assert.ok((await page.locator('.utility-nav').boundingBox()).y >= 0);
    await page.locator('.utility-nav input[type=search]').fill('violet'); await page.locator('.utility-nav input[type=search]').press('Enter');
    await page.waitForSelector('.nav-search-results .search-result');
    assert.equal(await page.locator('.nav-search-results .search-result').count(), 2);
    assert.equal(new URL(page.url()).pathname, '/');
    await page.getByRole('button', { name: 'Close search' }).click();
    await page.locator('.theme-selector').selectOption('miku'); await page.reload();
    assert.equal(await page.locator('.theme-selector').inputValue(), 'miku');
    await page.screenshot({ path: '/tmp/chikochan-miku-preview.png', fullPage: true });
    await page.locator('.theme-selector').selectOption('light');

    await page.goto(base + '/admin/login'); await page.locator('#admin-password').fill('browser-admin-password');
    await page.getByRole('button', { name: 'Log in', exact: true }).click(); await page.waitForURL('**/admin');
    await page.goto(base + '/admin/customization');
    const canvas = page.frameLocator('#editor-canvas');
    await canvas.locator('.section-edit-controls').first().waitFor();
    await page.locator('#editor-outline button').filter({ hasText: 'Boards' }).click();
    await page.locator('[data-setting="title"]').fill('Our Boards'); await page.locator('[data-setting="title"]').dispatchEvent('change');
    await canvas.locator('.home-boards .section-heading').filter({ hasText: 'Our Boards' }).waitFor();
    await page.locator('[data-editor-action="undo"]').click();
    await canvas.locator('.home-boards .section-heading').filter({ hasText: /^Boards$/ }).waitFor();
    await page.locator('[data-editor-action="redo"]').click();
    await canvas.locator('.home-boards .section-heading').filter({ hasText: 'Our Boards' }).waitFor();
    await page.locator('#editor-inspector details').filter({ hasText: 'Section header / image' }).locator('summary').click();
    await page.locator('[data-setting="header.image"]').fill('/banner.png'); await page.locator('[data-setting="header.image"]').dispatchEvent('change');
    await page.waitForFunction(() => document.getElementById('editor-canvas').contentDocument.querySelector('.home-boards .section-heading') && getComputedStyle(document.getElementById('editor-canvas').contentDocument.querySelector('.home-boards .section-heading')).backgroundImage.includes('/banner.png'));
    const boardsBefore = await canvas.locator('.home-boards').evaluate(node => parseFloat(node.style.top));
    await canvas.locator('.home-boards .section-move').focus(); await page.keyboard.press('ArrowDown');
    await page.waitForFunction(y => parseFloat(document.getElementById('editor-canvas').contentDocument.querySelector('.home-boards').style.top) > y, boardsBefore);
    await page.locator('[data-editor-action="undo"]').click();
    await canvas.locator('.home-boards .section-resize').waitFor();
    const resize = await canvas.locator('.home-boards .section-resize').boundingBox();
    await page.mouse.move(resize.x + resize.width / 2, resize.y + resize.height / 2); await page.mouse.down();
    await page.mouse.move(resize.x + resize.width / 2 - 70, resize.y + resize.height / 2 + 25, { steps: 5 }); await page.mouse.up();
    await page.waitForFunction(() => Number(document.querySelector('[data-setting="desktop"]').value) < 5);
    await page.locator('[data-editor-action="undo"]').click();
    await page.locator('[data-editor-action="up"]').click();
    await canvas.locator('.home-boards').waitFor();
    await page.locator('[data-editor-action="down"]').click();
    await page.locator('#editor-outline .editor-section-select').filter({ hasText: 'Latest Posts' }).click();
    const postsY = await canvas.locator('.home-latestPosts').evaluate(node => node.offsetTop);
    const scale = await page.locator('#editor-canvas').evaluate(node => node.getBoundingClientRect().width / node.offsetWidth);
    async function dragPosts(dx, dy) {
      await canvas.locator('.home-latestPosts .section-move').scrollIntoViewIfNeeded();
      const box = await canvas.locator('.home-latestPosts .section-move').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + dx * scale, box.y + box.height / 2 + dy * scale, { steps: 8 }); await page.mouse.up();
    }
    await dragPosts(0, 100);
    await page.waitForFunction(y => document.getElementById('editor-canvas').contentDocument.querySelector('.home-latestPosts').offsetTop > y + 90, postsY);
    await dragPosts(-2, -100);
    await page.waitForFunction(y => Math.abs(document.getElementById('editor-canvas').contentDocument.querySelector('.home-latestPosts').offsetTop - y) < 4, postsY);
    await page.locator('[data-editor-action="arrange"]').click();
    await page.waitForFunction(() => { var doc = document.getElementById('editor-canvas').contentDocument; return Math.abs(doc.querySelector('.home-latestPosts').offsetTop - doc.querySelector('.home-latestImages').offsetTop) < 2; });
    assert.equal(await page.locator('#editor-snap').isChecked(), true);
    await page.locator('#editor-outline .editor-section-select').filter({ hasText: 'Our Boards' }).click();
    assert.equal(await page.locator('[data-add-section]').count(), 1);
    assert.equal(await page.locator('[data-add-section]').getAttribute('data-add-section'), 'image');
    assert.equal(await page.locator('#editor-outline .editor-section-remove').count(), 9);
    await page.locator('[data-upload-target="image"]').setInputFiles({ name: 'section.png', mimeType: 'image/png', buffer: image });
    await canvas.locator('.home-boards .section-picture img').waitFor();
    await page.locator('[data-setting="image"]').fill(''); await page.locator('[data-setting="image"]').dispatchEvent('change');
    await canvas.locator('.home-boards .section-picture').waitFor({ state: 'detached' });
    await page.locator('[data-add-section="image"]').click();
    const picture = await sharp({ create: { width: 320, height: 120, channels: 3, background: '#ec759f' } }).png().toBuffer();
    await page.locator('[data-upload-target="image"]').setInputFiles({ name: 'picture.png', mimeType: 'image/png', buffer: picture });
    await canvas.locator('.home-image img').waitFor();
    await page.waitForFunction(() => document.getElementById('editor-canvas').contentDocument.querySelector('.home-image img').naturalWidth === 320);
    const pictureId = await canvas.locator('.home-image').getAttribute('data-section');
    const beforePicture = await canvas.locator('.home-image').evaluate(node => {
      var style = getComputedStyle(node), boards = node.parentElement.querySelector('.home-boards'), active = node.parentElement.querySelector('.home-activeThreads');
      return { x: node.offsetLeft, y: node.offsetTop, bottom: node.offsetTop + node.offsetHeight, boardsX: boards.offsetLeft, boardsBottom: boards.offsetTop + boards.offsetHeight, activeBottom: active.offsetTop + active.offsetHeight, border: style.borderTopWidth, background: style.backgroundColor };
    });
    assert.ok(Math.abs(beforePicture.x - beforePicture.boardsX) < 2 && beforePicture.y >= beforePicture.boardsBottom);
    assert.ok(beforePicture.bottom < beforePicture.activeBottom, 'Picture fills the space under Boards beside Active Threads');
    assert.equal(beforePicture.border, '0px'); assert.equal(beforePicture.background, 'rgba(0, 0, 0, 0)');
    assert.equal(await canvas.locator('.home-image .section-heading, .home-image figcaption').count(), 0);
    await page.locator('[data-setting="desktop"]').fill('3'); await page.locator('[data-setting="desktop"]').dispatchEvent('change');
    await page.waitForFunction(() => document.getElementById('editor-canvas').contentDocument.querySelector('.home-image').offsetWidth < 300);
    await canvas.locator('.home-image .section-move').scrollIntoViewIfNeeded();
    const pictureHandle = await canvas.locator('.home-image .section-move').boundingBox();
    await page.mouse.move(pictureHandle.x + pictureHandle.width / 2, pictureHandle.y + pictureHandle.height / 2); await page.mouse.down();
    await page.mouse.move(pictureHandle.x + pictureHandle.width / 2 + 25, pictureHandle.y + pictureHandle.height / 2 + 18, { steps: 5 }); await page.mouse.up();
    await page.waitForFunction(({ x, y }) => { var node = document.getElementById('editor-canvas').contentDocument.querySelector('.home-image'); return node.offsetLeft > x + 10 && node.offsetTop > y + 10; }, beforePicture);
    await page.getByRole('button', { name: 'Remove Welcome', exact: true }).click();
    assert.equal(await page.locator('#editor-outline .editor-section-remove').count(), 9);
    await page.locator('[data-editor-action="undo"]').click();
    assert.equal(await page.locator('#editor-outline .editor-section-remove').count(), 10);
    await page.getByRole('button', { name: 'Remove Picture', exact: true }).click();
    await canvas.locator('.home-image').waitFor({ state: 'detached' });
    await page.locator('[data-editor-action="undo"]').click(); await canvas.locator('.home-image img').waitFor();
    await page.getByRole('button', { name: 'Page background', exact: true }).click();
    assert.equal(await page.locator('[data-upload-target="style.image"]').isVisible(), true);
    assert.equal(await page.locator('[data-setting="style.height"]').isVisible(), false);
    await page.locator('[data-upload-target="style.image"]').setInputFiles({ name: 'background.png', mimeType: 'image/png', buffer: image });
    await page.waitForFunction(() => document.querySelector('[data-setting="style.image"]').value.startsWith('/src/'));
    const backgroundPath = await page.locator('[data-setting="style.image"]').inputValue();
    await page.waitForFunction(path => getComputedStyle(document.getElementById('editor-canvas').contentDocument.body).backgroundImage.includes(path), backgroundPath);
    await page.locator('[data-setting="style.size"]').selectOption('auto');
    await page.locator('[data-setting="style.repeat"]').selectOption('repeat');
    await page.locator('[data-editor-action="save"]').click();
    await page.waitForFunction(() => document.getElementById('editor-status').textContent.includes('Draft saved'));
    assert.doesNotMatch(await (await context.request.get(base)).text(), /Our Boards/);
    await page.reload(); await canvas.locator('.home-boards .section-heading').filter({ hasText: 'Our Boards' }).waitFor();
    await page.getByRole('button', { name: 'Page background', exact: true }).click();
    assert.equal(await page.locator('[data-setting="style.image"]').inputValue(), backgroundPath);
    assert.equal(store.read().customization.homepage.published.pageBackground.image, undefined);
    await page.locator('button[data-viewport="mobile"]').click();
    await page.waitForTimeout(100);
    assert.equal(await canvas.locator('html').evaluate(node => node.clientWidth), 390);
    await page.locator('button[data-viewport="desktop"]').click();
    await page.locator('[data-editor-action="publish"]').click();
    await page.waitForFunction(() => document.getElementById('editor-status').textContent.includes('Published'));
    assert.match(await (await context.request.get(base)).text(), /Our Boards/);
    const published = store.read().customization.homepage.published.sections.find(section => section.id === pictureId);
    assert.ok(published.image.startsWith('/src/') && published.positions.desktop.x > 7 && published.positions.desktop.y > 0);
    const publicPage = await context.newPage(); await publicPage.goto(base);
    await publicPage.locator('.home-image img').waitFor();
    await publicPage.waitForFunction(() => document.querySelector('.home-layout-free'));
    const publicPicture = await publicPage.locator('.home-image').evaluate(node => { var anchor = node.parentElement.querySelector('.home-boards'); return { x: node.offsetLeft, y: node.offsetTop, anchorBottom: anchor.offsetTop + anchor.offsetHeight }; });
    assert.ok(publicPicture.x > beforePicture.boardsX && Math.abs(publicPicture.y - publicPicture.anchorBottom - published.positions.desktop.offset) <= 2);
    for (const theme of ['light', 'dark', 'miku', 'yotsuba-b']) {
      await publicPage.locator('.theme-selector').selectOption(theme);
      assert.ok((await publicPage.locator('body').evaluate(node => getComputedStyle(node).backgroundImage)).includes(backgroundPath), 'Page wallpaper applies in ' + theme);
    }
    await publicPage.goto(base + '/about');
    assert.equal(await publicPage.locator('body').evaluate((node, path) => getComputedStyle(node).backgroundImage.includes(path), backgroundPath), false);
    await publicPage.close();
    await page.getByRole('button', { name: 'Page background', exact: true }).click();
    await page.getByRole('button', { name: 'Reset page background', exact: true }).click();
    await page.waitForFunction(path => !getComputedStyle(document.getElementById('editor-canvas').contentDocument.body).backgroundImage.includes(path), backgroundPath);
    assert.equal(store.read().customization.homepage.published.pageBackground.image, backgroundPath);
    await page.locator('[data-editor-action="undo"]').click();
    await page.waitForFunction(path => getComputedStyle(document.getElementById('editor-canvas').contentDocument.body).backgroundImage.includes(path), backgroundPath);
    await page.screenshot({ path: '/tmp/chikochan-editor-tested.png' });

    await page.goto(base + '/admin/news');
    await page.locator('#news-form [name=title]').fill('Hello from ChikoChan');
    await page.locator('#news-form [name=content]').fill('A classic news article with **bold text**.');
    await page.locator('#news-upload').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: image });
    await page.waitForFunction(() => document.getElementById('news-status').textContent.includes('Image uploaded'));
    await page.locator('#news-images input').nth(1).fill('A turquoise test image'); await page.locator('#news-images input').nth(1).dispatchEvent('change');
    await page.locator('#news-form button[type=submit]').click(); await page.waitForFunction(() => document.getElementById('news-status').textContent === 'Draft saved.');
    assert.doesNotMatch(await (await context.request.get(base + '/news')).text(), /Hello from ChikoChan/);
    await page.locator('#news-preview-button').click(); await page.locator('#news-preview .news-article').waitFor();
    await page.locator('#news-form [name=status]').selectOption('published');
    await page.locator('#news-form button[type=submit]').click(); await page.waitForFunction(() => document.getElementById('news-status').textContent === 'Article published.');
    await page.goto(base + '/news'); assert.equal(await page.locator('.news-article figure').count(), 1);
    await page.screenshot({ path: '/tmp/chikochan-news-tested.png', fullPage: true });

    await page.goto(base + '/chiko/thread/' + thread.id);
    assert.equal(await page.locator('[data-open-quick-reply], #quick-reply, [name=storySpoiler]').count(), 0);
    await page.locator('[data-quote-id="' + thread.id + '"]').last().click();
    assert.match(await page.locator('.reply-form textarea').inputValue(), new RegExp('>>' + thread.id));
    await page.locator('.reply-form textarea').fill('A normal browser reply.');
    await page.locator('.reply-form .posting-options summary').click(); await page.locator('.reply-form [name=email]').check();
    await page.locator('.reply-form [name=upfile]').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: image });
    const action = await page.locator('.reply-form').getAttribute('action');
    const token = new URL(action, base).searchParams.get('nativeChallenge');
    await page.locator('.reply-form [name=nativeAnswer]').fill(app.locals.chikochan.nativeCaptcha.parse(token).answer);
    await Promise.all([page.waitForNavigation(), page.locator('.reply-form [type=submit]').click()]);
    assert.equal(service.getThread(thread.id).replies.length, 1);
    assert.equal(await page.locator('.replyContainer').count(), 1);
    const threadForm = await page.locator('.reply-form').evaluate(node => ({ names: Array.from(node.elements, input => input.name).filter(Boolean), upload: node.querySelector('input[type=file]').parentElement.innerHTML }));
    await page.goto(base + '/chiko/');
    const boardForm = await page.locator('.reply-form').evaluate(node => ({ names: Array.from(node.elements, input => input.name).filter(Boolean), upload: node.querySelector('input[type=file]').parentElement.innerHTML }));
    assert.deepEqual(boardForm, threadForm, 'Board and thread reply forms match');
    for (const width of [768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of ['/', '/news', '/g/', '/chiko/thread/' + thread.id]) {
        await page.goto(base + route);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
        assert.equal(overflow, false, `${route} has no overflow at ${width}px`);
      }

    }
    await page.goto(base); await page.screenshot({ path: '/tmp/chikochan-mobile-tested.png', fullPage: true });
    assert.deepEqual(errors, [], 'No browser or CSP console errors');
    console.log('PASS: classic layout, original navbar, all-board search, Miku persistence, real editor preview/header images/save/publish/undo/redo/device sizes, news drafts/images/publication, normal reply forms, picture uploads/free placement/removal, page-background upload/persistence/themes/reset, tablet/mobile overflow and console checks.');
  } finally {
    await browser?.close(); await new Promise(resolve => server.close(resolve)); await closeApplication(app); fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
