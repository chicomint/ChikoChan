'use strict';

// Optional browser regression check, using the same external Playwright setup as
// verify-browser.js. All posts and uploads are created in disposable JSON storage.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createApp } = require('../app');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chikochan-post-layout-'));
  const app = createApp({
    storage: 'json', dataDir: directory,
    limits: { postRateLimit: 1000 },
    rateLimit: { operations: {
      threadCreate: { windowMs: 60000, limit: 1000 },
      replyCreate: { windowMs: 60000, limit: 1000 },
      mediaPost: { windowMs: 60000, limit: 1000 }
    } },
    antiAbuse: { turnstile: { enabled: false } },
    postingAuthorization: { enabled: false }
  });
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.on('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const { config, store } = app.locals.chikochan;
  const picture = size => execFileSync(config.media.ffmpegPath, [
    '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${size}`, '-frames:v', '1',
    '-threads', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'
  ]);
  const landscape = picture('2400x900');
  const portrait = picture('500x1800');
  async function post(threadId, comment, files = [], extra = {}) {
    const form = new FormData();
    form.set('board', 'chiko');
    form.set('name', extra.name || 'Anonymous');
    form.set('resto', String(threadId));
    form.set('com', comment);
    form.set('pwd', 'layout-password');
    if (!threadId) form.set('sub', extra.subject || 'Classic layout regression');
    if (extra.spoiler) form.set('spoiler', '1');
    for (const file of files) form.append('upfile', new Blob([file.data], { type: file.mime }), file.name);
    const response = await fetch(`${base}/post?json=1`, { method: 'POST', body: form });
    const body = await response.text();
    assert.equal(response.status, 201, body);
    return JSON.parse(body);
  }
  let browser;
  try {
    const op = await post(0, '>Classic greentext\n#fortune\n<em class="fortune">fake fortune</em>\n' +
      'A long paragraph should wrap beside the thumbnail and continue below it. '.repeat(45),
    [{ name: 'landscape.png', mime: 'image/png', data: landscape }], { name: '#fortune' });
    const short = await post(op.id, `>>${op.id}\nA compact text-only reply.`);
    const tall = await post(op.id, `>>${op.id}\nPortrait image with a long paragraph. ` + 'Text beside and below. '.repeat(70),
      [{ name: 'very-long-file-name-'.repeat(22) + '.png', mime: 'image/png', data: portrait }]);
    await post(op.id, 'unbroken'.repeat(400));
    await post(op.id, '', [{ name: 'image-only.png', mime: 'image/png', data: landscape }]);
    await store.update(data => { data.boards.find(board => board.uri === 'chiko').settings.maxFilesPerPost = 4; });
    const mixed = await post(op.id, 'Multiple images and video stay in their post.', [
      { name: 'landscape.png', mime: 'image/png', data: landscape },
      { name: 'portrait.png', mime: 'image/png', data: portrait }
    ]);
    const videos = [];
    for (const [extension, codec] of [['webm', 'libvpx-vp9'], ['mp4', 'libx264']]) {
      const filename = path.join(directory, `fixture.${extension}`);
      execFileSync(config.media.ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=12',
        '-t', '2', '-c:v', codec, '-threads', '1', '-pix_fmt', 'yuv420p', '-y', filename]);
      const file = { name: `clip.${extension}`, mime: `video/${extension}`, data: fs.readFileSync(filename) };
      const videoOp = await post(0, `A ${extension.toUpperCase()} video OP.`, [file]);
      const reply = await post(op.id, `>>${op.id}\nVideo reply with controls after clicking.`, [file], { spoiler: extension === 'webm' });
      videos.push({ op: videoOp.id, reply: reply.id, extension });
    }
    // Legacy videos may have no generated poster; never use their video URL as an image.
    await store.update(data => {
      const reply = data.threads.find(thread => thread.id === op.id).replies.find(item => item.id === videos[1].reply);
      reply.thumbnail = '';
      reply.attachments[0].thumbnail = '';
      data.media.find(asset => asset.id === reply.attachments[0].assetId).thumbnail = '';
      // The OP and reply share a deduplicated asset, so update both references.
      const videoOp = data.threads.find(thread => thread.id === videos[1].op);
      videoOp.thumbnail = '';
      videoOp.attachments[0].thumbnail = '';
      const target = data.threads.find(thread => thread.id === op.id).replies.find(item => item.id === mixed.id);
      const video = data.threads.find(thread => thread.id === videos[0].op).attachments[0];
      target.attachments.push(structuredClone(video));
    });
    for (let index = 0; index < 12; index += 1) await post(op.id, `>>${op.id}\nReply ${index + 1}.`);
    const launchOptions = { headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined };
    browser = await chromium.launch(launchOptions);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    const failedResponses = [];
    const videoRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('response', response => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });
    page.on('request', request => { if (/\/src\/.*\.(mp4|webm)(?:\?|$)/i.test(request.url())) videoRequests.push(request.url()); });
    async function fits() {
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No overflow at ${page.url()}`);
    }
    const threadUrl = `${base}/chiko/thread/${op.id}`;
    for (const width of [1280, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of ['/', '/chiko/', '/chiko/catalog', '/overboard', `/chiko/thread/${op.id}`]) {
        await page.goto(base + route);
        await fits();
        assert.equal(await page.locator('video, source').count(), 0, 'No player exists before interaction');
      }
      await page.goto(threadUrl);
      assert.equal(await page.locator('body').evaluate(node => getComputedStyle(node).getPropertyValue('--bg-color').trim()), '#fff6f9', 'Original pink palette is the default');
      await page.locator('.reply-form-table').scrollIntoViewIfNeeded();
      await fits();
      const form = await page.locator('.reply-form-table').boundingBox();
      assert.ok(form.width <= 421 && form.x + form.width <= width, 'Reply form stays compact');
      const reply = await page.locator(`#p${short.id}`).boundingBox();
      if (width === 1280) assert.ok(reply.width < width / 2, 'Short replies shrink to their content');
      for (const img of await page.locator('.post-img').all()) {
        await img.scrollIntoViewIfNeeded();
        await img.evaluate(node => node.decode());
        const info = await img.evaluate(node => ({ w: node.clientWidth, h: node.clientHeight, ratio: node.naturalWidth / node.naturalHeight }));
        assert.ok(Math.abs(info.w / info.h - info.ratio) < 0.05, 'Thumbnail preserves aspect ratio');
        assert.ok(info.w <= 250 && info.h <= 250, 'Thumbnail dimensions are bounded');
      }
      const flow = await page.locator(`#m${op.id}`).evaluate(node => {
        const image = node.closest('.post').querySelector('.post-img').getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(node);
        const lines = Array.from(range.getClientRects()).filter(rect => rect.width > 2);
        return { beside: lines.some(rect => rect.top < image.bottom && rect.left >= image.right),
          below: lines.some(rect => rect.top > image.bottom && rect.left < image.left + image.width / 2) };
      });
      if (width >= 768) assert.equal(flow.beside, true, 'OP text flows beside its image');
      assert.equal(flow.below, true, 'OP text continues below its image');
      assert.equal(await page.locator(`#m${op.id} .fortune`).count(), 1);
      assert.equal(await page.locator(`#m${op.id} em.fortune`).count(), 0);
      assert.equal(await page.locator(`#m${op.id} .greentext`).count(), 1);
      await page.locator(`#p${tall.id} .fileThumb`).click();
      await fits();
      await page.locator(`#p${tall.id} .fileThumb`).click();
      await page.locator(`#p${op.id} .quote-reply-link`).click();
      assert.match(await page.locator('.reply-form textarea').inputValue(), new RegExp(`>>${op.id}`));
      if (width === 1280) {
        await page.locator(`#p${short.id} .quotelink`).hover();
        assert.equal(await page.locator('.quote-preview').count(), 1);
        await page.mouse.move(0, 0);
      }
      await page.locator(`#p${op.id}`).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(directory, `thread-${width}.png`), fullPage: true });
    }
    assert.deepEqual(videoRequests, [], 'No video files requested while browsing previews');
    for (const entry of videos) {
      await page.setViewportSize({ width: entry.extension === 'webm' ? 1280 : 390, height: 900 });
      for (const [url, id] of [[`${base}/chiko/thread/${entry.op}`, entry.op], [threadUrl, entry.reply]]) {
        await page.goto(url);
        const postNode = page.locator(`#p${id}`);
        const preview = postNode.locator('.video-preview');
        if (entry.extension === 'mp4' && id === entry.reply) assert.equal(await postNode.locator('.video-placeholder').count(), 1);
        if (await postNode.locator('[data-reveal-spoiler]').count()) {
          await postNode.locator('[data-reveal-spoiler]').click();
          assert.equal(await postNode.locator('video').count(), 0, 'Revealing a spoiler still leaves a thumbnail');
        }
        await preview.click();
        const video = postNode.locator('video');
        assert.equal(await video.count(), 1);
        const closeLink = postNode.locator('.file-info a[data-collapse-video]');
        assert.equal(await closeLink.textContent(), '[Close]');
        assert.equal(await postNode.locator('button[data-collapse-video], .video-box [data-collapse-video]').count(), 0);
        assert.equal(await video.getAttribute('preload'), 'none');
        assert.equal(await video.evaluate(node => node.paused && !node.autoplay && node.controls && node.currentTime === 0), true);
        await fits();
        if (id === entry.op) await postNode.screenshot({ path: path.join(directory, `pink-video-${entry.extension}.png`) });
        // Exercise real decoding, seeking and volume rather than only inspecting attributes.
        await video.evaluate(async node => { await node.play(); node.pause(); node.currentTime = 0.5; node.volume = 0.5; });
        assert.equal(await video.evaluate(node => node.error), null);
        assert.equal(await video.evaluate(node => node.volume), 0.5);
        await postNode.locator('[data-collapse-video]').click();
        assert.equal(await video.count(), 0);
        assert.equal(await closeLink.count(), 0, 'Close link disappears when the thumbnail returns');
        assert.equal(await preview.isVisible(), true);
        assert.equal(await postNode.getAttribute('class').then(value => value.includes('post-media-expanded')), false);
        await preview.focus();
        await page.keyboard.press('Enter');
        assert.equal(await video.count(), 1, 'Keyboard can reveal videos');
        await postNode.locator('[data-collapse-video]').click();
      }
    }
    await page.goto(threadUrl);
    const mixedPost = page.locator(`#p${mixed.id}`);
    await mixedPost.locator('.fileThumb').first().click();
    await mixedPost.locator('.video-preview').click();
    await fits();
    await mixedPost.locator('[data-collapse-video]').click();
    assert.match(await mixedPost.getAttribute('class'), /post-media-expanded/, 'Collapsing video preserves expanded images');
    await mixedPost.locator('.fileThumb').first().click();
    assert.doesNotMatch(await mixedPost.getAttribute('class'), /post-media-expanded/);
    assert.deepEqual(failedResponses, [], 'No failed page or media responses');
    assert.deepEqual(errors, [], 'No browser console or page errors');
    await browser.close();
    browser = null;
    const native = await chromium.launch(launchOptions);
    try {
      const noJs = await native.newPage({ javaScriptEnabled: false, viewport: { width: 390, height: 900 } });
      await noJs.goto(threadUrl);
      assert.equal(await noJs.locator('video').count(), 0);
      assert.match(await noJs.locator('.video-preview').first().getAttribute('href'), /\.webm$/);
      assert.ok(await noJs.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    } finally { await native.close(); }
    console.log('PASS classic posts, wrapping, compact replies/forms, safe formatting, quotes, image expansion, mixed media, MP4/WebM reveal/play/collapse, keyboard, no-JS and 320–1280px layouts');
    console.log(`Screenshots: ${directory}`);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    // Keep generated screenshots for visual review, as in verify-browser.js.
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
