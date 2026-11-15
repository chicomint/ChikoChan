'use strict';

// Like verify-browser.js, takes an externally installed Playwright module path.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const { encryptionKey } = require('../lib/settings');
const { createApp } = require('../app');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chiko-maintenance-browser-'));
  const keyFile = path.join(directory, 'key');
  encryptionKey(keyFile, true);
  const app = createApp({ storage: 'json', dataDir: directory, keyFile,
    adminPassword: 'browser-admin-password', adminSessionSecret: 'browser-session-secret',
    features: { requireImageForThread: false }, limits: { postRateLimit: 100 } });
  const { service, uploads, maintenance } = app.locals.chikochan;
  const board = service.getDefaultBoard();
  const seed = await service.createThread({ comment: 'Browser test' }, null,
    { boardId: board.id, clientKey: 'browser-seed', address: '2001:db8::12' });
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.addInitScript(() => {
        window.themeFrames = [];
        function sample() {
          if (document.body) window.themeFrames.push(document.documentElement.getAttribute('data-theme') || 'light');
          requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${base}/${board.uri}/`);
      for (const theme of ['dark', 'yotsuba-b']) {
        await page.locator('.theme-selector').selectOption(theme);
        for (const route of ['/about', '/contact', '/news', '/rules', `/${board.uri}/`, `/${board.uri}/thread/${seed.id}`]) {
          await page.goto(base + route);
          await page.waitForFunction(() => window.themeFrames.length > 1);
          assert.deepEqual([...new Set(await page.evaluate(() => window.themeFrames))], [theme], 'Every visible frame uses the chosen theme');
        }
        await page.reload();
        assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
        const tab = await context.newPage();
        await tab.goto(base + '/rules');
        assert.equal(await tab.locator('html').getAttribute('data-theme'), theme);
        await tab.close();
      }
      assert.equal(await page.locator('.staff-ip').count(), 0);
      await page.goto(base + '/admin/login');
      await page.locator('[name="password"]').fill('browser-admin-password');
      await Promise.all([page.waitForURL('**/admin'), page.locator('button[type="submit"]').click()]);
      await page.waitForSelector('.admin-post-summary .staff-ip');
      const ipControl = page.locator(`.staff-ip[data-post-id="${seed.id}"]`);
      assert.equal(await ipControl.textContent(), 'IP: •••');
      await ipControl.focus();
      await page.waitForFunction(id => document.querySelector(`.staff-ip[data-post-id="${id}"]`).textContent === '2001:db8::12', seed.id);
      assert.ok(!(await page.content()).includes('posterIp'));
      await page.goto(`${base}/${board.uri}/thread/${seed.id}`);
      assert.equal(await page.locator('.staff-ip').count(), 0, 'No IP controls on public thread, even for admin');
      assert.ok(!(await page.content()).includes('2001:db8::12'));
      await page.goto(`${base}/${board.uri}/`);
      assert.equal(await page.locator('.staff-ip').count(), 0, 'No IP controls on board, even for admin');
      await page.goto(`${base}/${board.uri}/`);
      async function post(name, comment) {
        const form = page.locator('#post-form');
        await form.locator('[name="name"]').fill(name);
        await form.locator('textarea').fill(comment);
        const token = new URL(await form.getAttribute('action'), base).searchParams.get('nativeChallenge');
        if (token) await form.locator('[name="nativeAnswer"]').fill(app.locals.chikochan.nativeCaptcha.parse(token).answer);
        await Promise.all([page.waitForURL(/\/thread\/\d+/), form.locator('[type="submit"]').click()]);
      }
      await post('Alice', 'Remember this name');
      await page.goto(`${base}/${board.uri}/`);
      assert.equal(await page.locator('#post-form [name="name"]').inputValue(), 'Alice');
      await post('Bob', 'Change the remembered name');
      await page.goto(`${base}/${board.uri}/`);
      assert.equal(await page.locator('#post-form [name="name"]').inputValue(), 'Bob');
      await post('', 'Remain anonymous');
      await page.goto(`${base}/${board.uri}/`);
      assert.equal(await page.locator('#post-form [name="name"]').inputValue(), '');
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: theme before visible frames, refresh/new tab, staff IP focus, remembered/edited/anonymous name`);
      await context.close();
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    await maintenance.stop();
    await uploads.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
