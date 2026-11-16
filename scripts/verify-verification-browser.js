'use strict';

// Browser tooling is supplied separately; all application data is disposable.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const { createApp } = require('../app');
const { closeApplication } = require('../lib/bootstrap');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chiko-verification-browser-'));
  const app = createApp({ storage: 'json', dataDir: directory,
    adminPassword: 'browser-verification-password', adminSessionSecret: 'browser-verification-session-secret',
    features: { requireImageForThread: false }, maintenance: { enabled: false },
    postingAuthorization: { enabled: true, secret: 'browser-verification-authorization-secret' },
    antiAbuse: { turnstile: { enabled: true, siteKey: 'test-site-key', secretKey: 'test-secret-key' } },
    turnstileFetch: async (_url, options) => ({ ok: true, text: async () => JSON.stringify({ success: options.body.get('response') === 'test-token', action: 'post', hostname: 'localhost' }) }) });
  await app.locals.chikochan.store.ready;
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.argv[3] || undefined });
    const context = await browser.newContext({ viewport: { width: 1365, height: 950 } });
    await context.route('https://challenges.cloudflare.com/**', route => route.fulfill({ contentType: 'application/javascript', body: `window.turnstile={render:function(el){var input=document.createElement('input');input.type='hidden';input.name='cf-turnstile-response';input.value='test-token';el.appendChild(input);return 'test';},reset:function(){}};` }));
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(base + '/admin/login');
    await page.locator('#admin-password').fill('browser-verification-password');
    await Promise.all([page.waitForURL('**/admin'), page.getByRole('button', { name: 'Log in', exact: true }).click()]);
    await page.getByRole('link', { name: 'Posting verification', exact: true }).click();
    for (const name of ['postingAuthorization', 'turnstile']) await page.locator(`select[name="${name}"]`).selectOption('0');
    await Promise.all([page.waitForURL('**/admin/verification?saved=1'), page.getByRole('button', { name: 'Save verification settings' }).click()]);
    assert.match(await page.locator('[role=status]').textContent(), /apply immediately/);
    assert.match(await page.locator('.admin-panel').textContent(), /Six-digit image verification: Off/);
    await page.reload();
    for (const name of ['postingAuthorization', 'turnstile']) assert.equal(await page.locator(`select[name="${name}"]`).inputValue(), '0');
    await page.locator('.theme-selector').selectOption('miku');
    await page.screenshot({ path: '/tmp/chikochan-verification-settings.png', fullPage: true });
    for (const width of [768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `No horizontal overflow at ${width}px`);
    }
    await page.goto(base + '/chiko/');
    assert.equal(await page.locator('.native-verification, [data-turnstile-widget]').count(), 0);
    await page.locator('#post-form textarea[name=com]').fill('A harmless post after verification was turned off.');
    await page.locator('#post-form button[type=submit], #post-form input[type=submit]').first().click();
    await page.waitForURL('**/chiko/thread/*');
    await page.locator('.postMessage').filter({ hasText: 'A harmless post after verification was turned off.' }).waitFor();
    await page.goto(base + '/admin/verification');
    for (const name of ['postingAuthorization', 'turnstile']) await page.locator(`select[name="${name}"]`).selectOption('inherit');
    await Promise.all([page.waitForURL('**/admin/verification?saved=1'), page.getByRole('button', { name: 'Save verification settings' }).click()]);
    await page.goto(base + '/chiko/');
    assert.equal(await page.locator('#post-form .native-verification').count(), 1);
    assert.equal(await page.locator('#post-form [data-turnstile-widget]').count(), 1);

    await page.goto(base + '/admin/verification');
    for (const name of ['postingAuthorization', 'turnstile']) await page.locator(`select[name="${name}"]`).selectOption('1');
    await page.locator('select[name=nativeCaptcha]').selectOption('0');
    await Promise.all([page.waitForURL('**/admin/verification?saved=1'), page.getByRole('button', { name: 'Save verification settings' }).click()]);
    await page.reload();
    assert.equal(await page.locator('select[name=turnstile]').inputValue(), '1');
    assert.equal(await page.locator('select[name=postingAuthorization]').inputValue(), '1');
    assert.equal(await page.locator('select[name=nativeCaptcha]').inputValue(), '0');
    assert.match(await page.locator('.admin-panel').textContent(), /Six-digit image verification: Off/);
    await page.setViewportSize({ width: 1365, height: 950 });
    await page.screenshot({ path: '/tmp/chikochan-cloudflare-without-numbers.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Three verification controls fit mobile');
    await page.goto(base + '/chiko/');
    assert.equal(await page.locator('#post-form .native-verification, #post-form input[name=nativeAnswer]').count(), 0);
    assert.equal(await page.locator('#post-form [data-turnstile-widget]').count(), 1);
    await page.locator('#post-form textarea[name=com]').fill('Cloudflare verification without entering numbers.');
    await page.locator('#post-form button[type=submit], #post-form input[type=submit]').first().click();
    await page.waitForURL('**/chiko/thread/*');
    await page.locator('.postMessage').filter({ hasText: 'Cloudflare verification without entering numbers.' }).waitFor();
    assert.equal(await page.locator('.native-verification').count(), 0, 'Reply forms also omit the number check');

    const noScript = await browser.newContext({ javaScriptEnabled: false });
    const plain = await noScript.newPage();
    await plain.goto(base + '/chiko/');
    assert.equal(await plain.locator('.native-verification').count(), 0);
    assert.match(await plain.locator('#post-form noscript').textContent(), /Enable JavaScript to complete Cloudflare verification/);
    await plain.goto(base + '/admin/login');
    await plain.locator('#admin-password').fill('browser-verification-password');
    await Promise.all([plain.waitForURL('**/admin'), plain.getByRole('button', { name: 'Log in', exact: true }).click()]);
    await plain.getByRole('link', { name: 'Posting verification', exact: true }).click();
    for (const name of ['postingAuthorization', 'turnstile']) await plain.locator(`select[name="${name}"]`).selectOption('0');
    await Promise.all([plain.waitForURL('**/admin/verification?saved=1'), plain.getByRole('button', { name: 'Save verification settings' }).click()]);
    await plain.goto(base + '/chiko/');
    assert.equal(await plain.locator('.native-verification, [data-turnstile-widget]').count(), 0, 'Switches work without JavaScript');
    assert.deepEqual(errors, [], 'No browser or console errors');
    console.log('PASS: admin navigation, save/refresh, CAPTCHA removal and restoration, Cloudflare-only verification with real authorization/posting, JavaScript-off messaging/settings, Miku styling, tablet/mobile overflow and console checks (Cloudflare provider mocked).');
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await closeApplication(app);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
