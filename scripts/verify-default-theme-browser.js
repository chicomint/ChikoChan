'use strict';

// Uses disposable storage and externally supplied Playwright/Chromium, matching
// the other browser checks without adding production dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const { createApp } = require('../app');
const { closeApplication } = require('../lib/bootstrap');
const { encryptionKey } = require('../lib/settings');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chiko-default-theme-browser-'));
  const keyFile = path.join(directory, 'key');
  encryptionKey(keyFile, true);
  const app = createApp({ storage: 'json', dataDir: directory, keyFile,
    adminPassword: 'default-theme-browser-password', adminSessionSecret: 'default-theme-browser-session-secret',
    features: { requireImageForThread: false }, limits: { postRateLimit: 100 } });
  const { service, store } = app.locals.chikochan;
  await store.ready;
  const board = service.getDefaultBoard();
  const thread = await service.createThread({ comment: 'Default theme browser fixture' }, null,
    { boardId: board.id, clientKey: 'default-theme-browser' });
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  let browser;

  function preferencesResponse(response) {
    return new URL(response.url()).pathname === '/preferences' && response.request().method() === 'POST';
  }

  async function newContext(options = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...options });
    context.on('page', page => {
      page.setDefaultTimeout(12000);
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    });
    await context.addInitScript(() => {
      window.chikoReady = false;
      document.addEventListener('chikochan:ready', () => { window.chikoReady = true; }, { once: true });
      window.themeFrames = [];
      function sample() {
        if (document.body) window.themeFrames.push(document.documentElement.getAttribute('data-theme') || 'light');
        requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    });
    return context;
  }

  async function visit(page, route = '/') {
    await page.goto(base + route);
    await page.waitForFunction(() => window.chikoReady);
  }

  async function assertTheme(page, theme, choice, label) {
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme === 'light' ? null : theme, label);
    assert.equal(await page.locator('.theme-selector').inputValue(), choice, label);
  }

  async function chooseTheme(page, choice, theme) {
    const saved = page.waitForResponse(preferencesResponse);
    await page.locator('.theme-selector').selectOption(choice);
    assert.equal((await saved).status(), 204);
    await assertTheme(page, theme, choice, 'Personal theme applies immediately');
  }

  async function canvasTheme(page, theme) {
    await page.waitForFunction(theme => {
      const root = document.getElementById('editor-canvas').contentDocument?.documentElement;
      return root?.getAttribute('data-default-theme') === theme && (root.getAttribute('data-theme') || 'light') === theme;
    }, theme);
  }

  async function editorAction(page, action) {
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/admin/customization/layout' && response.request().method() === 'POST');
    await page.locator(`[data-editor-action="${action}"]`).click();
    assert.equal((await response).status(), 200);
    await page.waitForFunction(text => document.getElementById('editor-status').textContent.includes(text), action === 'publish' ? 'Published.' : 'Draft saved.');
  }

  try {
    browser = await chromium.launch({ headless: true, executablePath: process.argv[3] || undefined });
    const adminContext = await newContext();
    const adminPage = await adminContext.newPage();
    await visit(adminPage, '/admin/login');
    await adminPage.locator('#admin-password').fill('default-theme-browser-password');
    await Promise.all([adminPage.waitForURL('**/admin'), adminPage.getByRole('button', { name: 'Log in', exact: true }).click()]);
    await adminPage.waitForFunction(() => window.chikoReady);
    await chooseTheme(adminPage, 'dark', 'dark');
    await visit(adminPage, '/admin/customization');
    await adminPage.frameLocator('#editor-canvas').locator('.section-edit-controls').first().waitFor();
    assert.equal(await adminPage.locator('#editor-default-theme').inputValue(), 'light');
    await adminPage.locator('#editor-default-theme').selectOption('miku');
    await canvasTheme(adminPage, 'miku');
    await assertTheme(adminPage, 'dark', 'dark', 'Draft preview does not change the administrator personal theme');
    await editorAction(adminPage, 'save');
    assert.equal(store.read().customization.homepage.draft.defaultTheme, 'miku');
    assert.equal(store.read().customization.homepage.published.defaultTheme, 'light', 'Saving a draft does not publish its theme');
    assert.match(await (await adminContext.request.get(base)).text(), /data-default-theme="light"/);
    await adminPage.reload();
    await adminPage.frameLocator('#editor-canvas').locator('.section-edit-controls').first().waitFor();
    assert.equal(await adminPage.locator('#editor-default-theme').inputValue(), 'miku', 'Draft theme survives refresh');
    await canvasTheme(adminPage, 'miku');
    await assertTheme(adminPage, 'dark', 'dark', 'Admin keeps Dark after refresh');
    await adminPage.screenshot({ path: '/tmp/chikochan-default-theme-tested.png' });
    await editorAction(adminPage, 'publish');
    assert.equal(store.read().customization.homepage.published.defaultTheme, 'miku');

    const inheritedContext = await newContext();
    const inherited = await inheritedContext.newPage();
    const routes = ['/', '/about', '/news', '/rules', `/${board.uri}/`, `/${board.uri}/thread/${thread.id}`];
    for (const route of routes) {
      await visit(inherited, route);
      await assertTheme(inherited, 'miku', 'site', `Published Miku applies at ${route}`);
      await inherited.waitForFunction(() => window.themeFrames.length > 1);
      assert.deepEqual([...new Set(await inherited.evaluate(() => window.themeFrames))], ['miku'], `Every visible frame uses Miku at ${route}`);
    }
    assert.equal(await inherited.evaluate(() => localStorage.getItem('chikochan-theme')), null, 'A first visit does not freeze the inherited theme in localStorage');
    assert.equal((await (await inheritedContext.request.get(base + '/preferences')).json()).values['chikochan-theme'], 'site');

    const lightContext = await newContext(), darkContext = await newContext();
    const lightPage = await lightContext.newPage(), darkPage = await darkContext.newPage();
    await visit(lightPage); await chooseTheme(lightPage, 'light', 'light');
    await visit(darkPage); await chooseTheme(darkPage, 'dark', 'dark');
    await adminPage.locator('#editor-default-theme').selectOption('yotsuba-b');
    await canvasTheme(adminPage, 'yotsuba-b');
    await editorAction(adminPage, 'publish');
    assert.equal(store.read().customization.homepage.published.defaultTheme, 'yotsuba-b');
    for (const [page, theme, choice] of [[inherited, 'yotsuba-b', 'site'], [lightPage, 'light', 'light'], [darkPage, 'dark', 'dark']]) {
      await visit(page);
      await assertTheme(page, theme, choice, 'Publication updates inherited themes and preserves explicit choices');
    }
    await chooseTheme(darkPage, 'site', 'yotsuba-b');
    await visit(darkPage, '/about');
    await assertTheme(darkPage, 'yotsuba-b', 'site', 'Navbar Site default selection persists');

    const legacyContext = await newContext();
    await legacyContext.addInitScript(() => {
      if (!/^https?:$/.test(location.protocol)) return;
      if (!sessionStorage.getItem('legacy-theme-seeded')) {
        localStorage.setItem('chikochan-theme', 'light');
        sessionStorage.setItem('legacy-theme-seeded', 'yes');
      }
    });
    const legacyPage = await legacyContext.newPage();
    await visit(legacyPage);
    await assertTheme(legacyPage, 'light', 'light', 'Legacy explicit pink preference survives the new site default');
    assert.equal((await (await legacyContext.request.get(base + '/preferences')).json()).values['chikochan-theme'], 'light');
    await visit(legacyPage, '/news');
    await assertTheme(legacyPage, 'light', 'light', 'Legacy explicit preference survives navigation');

    const cookieContext = await newContext();
    await cookieContext.addCookies([{ name: 'chiko_theme', value: 'dark', url: base }]);
    const cookiePage = await cookieContext.newPage();
    await visit(cookiePage);
    await assertTheme(cookiePage, 'dark', 'dark', 'Cookie-only explicit choice survives first-visit migration');
    assert.equal((await (await cookieContext.request.get(base + '/preferences')).json()).values['chikochan-theme'], 'dark');

    const noScriptContext = await newContext({ javaScriptEnabled: false });
    const noScriptPage = await noScriptContext.newPage();
    await noScriptPage.goto(base + '/news');
    assert.equal(await noScriptPage.locator('html').getAttribute('data-default-theme'), 'yotsuba-b');
    assert.equal(await noScriptPage.locator('html').getAttribute('data-theme'), 'yotsuba-b', 'Server-rendered default works without JavaScript');

    const raceContext = await newContext();
    await raceContext.request.get(base + '/preferences');
    const preserved = { 'chikochan-theme': 'site', 'chikochan-hidden-posts': JSON.stringify([String(thread.id)]), 'chikochan-post-password': 'saved-deletion-password' };
    assert.equal((await raceContext.request.post(base + '/preferences', { data: preserved })).status(), 204);
    let release, started;
    const held = new Promise(resolve => { release = resolve; });
    const requested = new Promise(resolve => { started = resolve; });
    const writes = [];
    await raceContext.route('**/preferences', async route => {
      if (route.request().method() === 'GET') { started(); await held; }
      else writes.push(route.request().postDataJSON());
      await route.continue();
    });
    const racePage = await raceContext.newPage();
    await racePage.goto(base + '/about');
    await requested;
    await racePage.locator('.theme-selector').selectOption('miku');
    await assertTheme(racePage, 'miku', 'miku', 'Theme changes immediately while preferences load');
    assert.deepEqual(writes, [], 'No partial preference snapshot is posted before the saved values load');
    const flushed = racePage.waitForResponse(preferencesResponse);
    release();
    assert.equal((await flushed).status(), 204);
    await racePage.waitForFunction(() => window.chikoReady);
    await assertTheme(racePage, 'miku', 'miku', 'Pending theme choice survives preference loading');
    assert.equal(writes.length, 1, 'Pending edits are merged and flushed once');
    assert.deepEqual(writes[0], { ...preserved, 'chikochan-theme': 'miku' });
    assert.deepEqual((await (await raceContext.request.get(base + '/preferences')).json()).values, { ...preserved, 'chikochan-theme': 'miku' }, 'Theme change preserves the saved hidden posts and deletion password');

    assert.deepEqual(errors, [], 'No browser or console errors');
    console.log('PASS: default-theme draft/save/refresh/publish, administrator Dark with Miku canvas, inherited Miku/Yotsuba B across pages, explicit light/dark and Site default persistence, legacy localStorage/cookie migration, JavaScript-off fallback, delayed preference-load preservation, and console checks.');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    await closeApplication(app);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
