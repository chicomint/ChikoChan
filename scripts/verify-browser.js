'use strict';

// Optional integration runner: install Playwright separately, then set PLAYWRIGHT_MODULE
// to its module path. Uses disposable JSON storage and never contacts the hosted site.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createApp } = require('../app');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chikochan-browser-'));
  const app = createApp({
    storage: 'json', dataDir: directory,
    adminPassword: 'browser-admin-password', adminSessionSecret: 'browser-admin-session-secret',
    rateLimit: { policies: { captchaAuthorization: { windowMs: 600000, limit: 100 } } },
    limits: { postRateLimit: 100, reportRateLimit: 100 },
    postingAuthorization: { enabled: true, secret: 'browser-test-authorization-secret-123456789' },
    antiAbuse: { turnstile: { enabled: true, siteKey: 'test-site-key', secretKey: 'test-secret' } },
    turnstileFetch: async (_url, options) => ({ ok: true, text: async () => JSON.stringify({
      success: options.body.get('response') === 'browser-test-token', action: 'post', hostname: 'localhost'
    }) })
  });
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const javaScriptEnabled of [false, true]) {
      const context = await browser.newContext({ javaScriptEnabled, viewport: { width: 1280, height: 900 } });
      // Provider integration is mocked; the real client script, fetch authorization,
      // server validation, multipart form, redirects, and persistence all run unchanged.
      await context.route('https://challenges.cloudflare.com/**', route => route.fulfill({
        contentType: 'application/javascript', body: `window.turnstile={render:function(el){
          var input=document.createElement('input');input.type='hidden';
          input.name='cf-turnstile-response';input.value='browser-test-token';el.appendChild(input);return 'test';
        },reset:function(){}};`
      }));
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const scripts = [];
      const errors = [];
      page.on('request', request => { if (request.resourceType() === 'script') scripts.push(request.url()); });
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base);
      assert.equal(await page.locator('body').isVisible(), true);
      assert.equal(await page.locator('.utility-nav').count(), 1);
      const globalNav = await page.locator('.utility-nav').innerHTML();
      assert.equal(await page.locator('.board-directory').count(), 1);
      if (javaScriptEnabled) {
        await page.locator('.theme-selector').selectOption('dark');
        assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
        await page.reload();
        assert.equal(await page.locator('.theme-selector').inputValue(), 'dark');
        await page.locator('.theme-selector').selectOption('light');
        assert.equal(await page.locator('html').getAttribute('data-theme'), null);
      }
      await page.locator('a[href="/chiko/"]').first().click();
      await page.locator('#name').fill('#fortune');
      await page.locator('#title').fill(`JavaScript ${javaScriptEnabled ? 'ON' : 'OFF'}`);
      await page.locator('#comment').fill('Browser multipart test\n>greentext\n#fortune\n<em class="fortune">fake</em>');
      await page.locator('#password').fill('browser-password');
      await page.locator('#image').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PNG });
      async function solve(form) {
        const action = await form.getAttribute('action');
        const token = new URL(action, base).searchParams.get('nativeChallenge');
        // Test process holds the key; the browser only receives the encrypted challenge.
        const answer = app.locals.chikochan.nativeCaptcha.parse(token).answer;
        await form.locator('[name="nativeAnswer"]').fill(answer);
      }
      if (!javaScriptEnabled) await solve(page.locator('#post-form'));
      await Promise.all([
        page.waitForURL(/\/chiko\/thread\/\d+/),
        page.locator('#post-form [type="submit"]').click()
      ]);
      const threadUrl = page.url();
      const threadId = Number(/thread\/(\d+)/.exec(threadUrl)[1]);
      assert.match(await page.locator(`#m${threadId}`).innerText(), /Browser multipart test/);
      assert.equal(await page.locator(`#m${threadId} .fortune`).count(), 1);
      assert.equal(await page.locator(`#m${threadId} em.fortune`).count(), 0);
      const count = app.locals.chikochan.service.getData().threads.length;
      await page.reload();
      assert.equal(app.locals.chikochan.service.getData().threads.length, count);
      await page.locator('.reply-form textarea').fill(`>>${threadId}\nBrowser reply ` + 'long comment '.repeat(60));
      await page.locator('.reply-form [name="pwd"]').fill('browser-password');
      if (!javaScriptEnabled) await solve(page.locator('.reply-form'));
      await Promise.all([page.waitForNavigation(), page.locator('.reply-form [type="submit"]').click()]);
      const thread = app.locals.chikochan.service.getData().threads.find(item => item.id === threadId);
      assert.equal(thread.replies.length, 1);
      const replyId = thread.replies[0].id;
      assert.equal(await page.locator(`#p${threadId} .backlink`).count(), 1);
      for (const [size, color] of [['400x900', 'red'], ['1600x600', 'blue']]) {
        const picture = execFileSync(app.locals.chikochan.config.media.ffmpegPath,
          ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}`, '-frames:v', '1',
            '-threads', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1']);
        await page.locator('.reply-form textarea').fill(`>>${threadId}\n${size} attachment`);
        await page.locator('.reply-form [name="upfile"]').setInputFiles({ name: `${size}.png`, mimeType: 'image/png', buffer: picture });
        if (!javaScriptEnabled) await solve(page.locator('.reply-form'));
        await Promise.all([page.waitForNavigation(), page.locator('.reply-form [type="submit"]').click()]);
      }
      assert.equal(await page.locator(`#p${threadId} .backlink`).count(), 3);
      if (javaScriptEnabled) {
        await page.locator('.reply .post-img').last().click();
        const box = await page.locator('.reply .post-img').last().boundingBox();
        assert.ok(box.width <= 1280);
        await page.locator('.quotelink').first().hover();
        assert.equal(await page.locator('.quote-preview').count(), 1);
        await page.mouse.move(0, 0);
      } else {
        // Native links expose full attachments without an expansion handler.
        const href = await page.locator('.reply .fileThumb').last().getAttribute('href');
        assert.equal((await context.request.get(base + href)).status(), 200);
      }
      await page.screenshot({ path: path.join(directory, `thread-js-${javaScriptEnabled}.png`), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(directory, `mobile-js-${javaScriptEnabled}.png`), fullPage: true });
      const post = page.locator(`#p${replyId}`);
      await post.locator('.post-menu > summary').click();
      await post.locator('.report-control > summary').click();
      await post.locator('[name="reason"]').fill('Browser test report');
      await Promise.all([page.waitForURL(/\/report\/success/), post.locator('.report-control button').click()]);
      assert.match(await page.locator('body').innerText(), /Report submitted/);
      const reports = app.locals.chikochan.service.getData().reports.length;
      await page.reload();
      assert.equal(app.locals.chikochan.service.getData().reports.length, reports);
      await page.goto(threadUrl);
      await page.locator(`[name="postIds"][value="${replyId}"]`).check();
      await page.locator('#delete-form [name="pwd"]').fill('browser-password');
      await Promise.all([page.waitForNavigation(), page.locator('#delete-form button').click()]);
      assert.equal(app.locals.chikochan.service.getData().threads.find(item => item.id === threadId).replies.length, 2);
      await page.goto(threadUrl);
      // Empty reply reaches server validation through a native form submission.
      await solve(page.locator('.reply-form'));
      await Promise.all([page.waitForNavigation(), page.locator('.reply-form [type="submit"]').click()]);
      assert.match(await page.locator('body').innerText(), /Request failed/);
      await page.goto(base);
      await page.screenshot({ path: path.join(directory, `home-js-${javaScriptEnabled}.png`), fullPage: true });
      await page.goto(base + '/admin/login');
      await page.locator('[name="password"]').fill('browser-admin-password');
      await Promise.all([page.waitForNavigation(), page.locator('button[type="submit"]').click()]);
      assert.match(page.url(), /\/admin$/);
      await page.goto(base + '/admin/customization');
      await page.locator('[name="bannerEnabled"]').check();
      await page.locator('[name="bannerImageUrl"]').fill('https://banner.example/header.png');
      await page.locator('[name="bannerAlt"]').fill('Test banner');
      await Promise.all([page.waitForNavigation(), page.locator('form[action="/admin/customization"] button[type="submit"]').click()]);
      await context.route('https://banner.example/header.png', route => route.fulfill({ contentType: 'image/png', body: PNG }));
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        for (const route of ['/', '/about', '/contact', '/news', '/rules', '/chiko/', '/chiko/catalog', '/chiko/archive', '/chiko/rules', new URL(threadUrl).pathname]) {
          await page.goto(base + route);
          assert.equal(await page.locator('.global-banner img').isVisible(), true);
          assert.equal(await page.locator('.utility-nav').count(), 1);
          assert.equal(await page.locator('.utility-nav').innerHTML(), globalNav);
          if (route.startsWith('/chiko/')) {
            for (const action of ['catalog', 'archive', 'rules']) {
              assert.equal(await page.locator(`.utility-nav a[href="/chiko/${action}"]`).count(), 0);
              assert.equal(await page.locator(`.board-bottom-nav a[href="/chiko/${action}"]`).count(), 1);
            }
            assert.equal(await page.locator('.board-bottom-nav a[href="/"]').count(), 1);
          }
          if (route === '/') assert.equal(await page.locator('.board-directory').count(), 1);
          const linksBox = await page.locator('.utility-links').boundingBox();
          assert.ok(Math.abs(linksBox.x + linksBox.width / 2 - width / 2) < 2, 'Top links are centered');
          if (route === '/chiko/') {
            const formBox = await page.locator('#post-form').boundingBox();
            assert.ok(Math.abs(formBox.x + formBox.width / 2 - width / 2) < 2, 'Posting form is centered');
            assert.ok(formBox.x >= 0 && formBox.x + formBox.width <= width, 'Form fits viewport');
            const threadsBox = await page.locator('.threads-container').boundingBox();
            assert.equal(await page.locator('.board-directory').count(), 0);
            const menuBox = await page.locator('.board-bottom-nav').boundingBox();
            assert.ok(menuBox.y >= formBox.y + formBox.height, 'Board menu follows posting form');
            assert.ok(threadsBox.y >= menuBox.y + menuBox.height, 'Threads follow board menu');
            assert.equal(await page.locator('.utility-nav a[href="/#boards"]').count(), 0);
            assert.ok(threadsBox.x < 10 && threadsBox.width > width - 20, 'Threads remain wide and left aligned');
            assert.equal(await page.locator('.utility-nav a[href="/chiko/catalog"]').count(), 0);
            assert.equal(await page.locator('.board-bottom-nav a[href="/chiko/catalog"]').count(), 1);
            await page.screenshot({ path: path.join(directory, `board-${width}-js-${javaScriptEnabled}.png`), fullPage: true });
          }
          assert.ok(await page.locator('.utility-nav').evaluate(element => element.getBoundingClientRect().right <= window.innerWidth));
          assert.equal(await page.locator('.global-banner img').evaluate(img => img.complete && img.naturalWidth > 0), true);
        }
        await page.goto(base + '/about');
        await page.screenshot({ path: path.join(directory, `about-${width}-js-${javaScriptEnabled}.png`), fullPage: true });
      }
      if (javaScriptEnabled) {
        await context.unroute('https://banner.example/header.png');
        await context.route('https://banner.example/header.png', route => route.abort());
        await page.reload();
        await page.waitForFunction(() => document.querySelector('.global-banner').hidden);
      }
      await page.goto(base + '/admin/customization');
      await page.locator('[name="bannerEnabled"]').uncheck();
      await Promise.all([page.waitForNavigation(), page.locator('form[action="/admin/customization"] button[type="submit"]').click()]);
      await page.goto(base + '/chiko/');
      assert.equal(await page.locator('.global-banner').count(), 0);
      await page.goto(base + '/admin');
      await Promise.all([page.waitForNavigation(), page.locator('form[action="/admin/logout"] button').click()]);
      assert.match(page.url(), /\/admin\/login$/);
      if (!javaScriptEnabled) assert.deepEqual(scripts, []);
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS JavaScript ${javaScriptEnabled ? 'ON (Turnstile provider mocked)' : 'OFF'}: browse, image/thread, reply, PRG/refresh, report, delete, validation, desktop/mobile`);
    }
    console.log(`Screenshots: ${directory}`);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    // Retain disposable screenshots and data for visual inspection.
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
