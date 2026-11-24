'use strict';

// Optional browser regression check, using the same external Playwright setup as
// verify-browser.js. All posts and uploads are created in disposable JSON storage.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.argv[2] || 'playwright');
const { encryptionKey } = require('../lib/settings');
const { createApp } = require('../app');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chikochan-post-layout-'));
  encryptionKey(path.join(directory, 'test-key'), true);
  const app = createApp({
    storage: 'json', dataDir: directory, keyFile: path.join(directory, 'test-key'),
    limits: { postRateLimit: 1000 },
    rateLimit: { operations: {
      threadCreate: { windowMs: 60000, limit: 1000 },
      replyCreate: { windowMs: 60000, limit: 1000 },
      mediaPost: { windowMs: 60000, limit: 1000 }
    } },
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
    const wrappingThreads = [];
    for (const [label, data, comment] of [
      ['portrait', portrait, 'A short OP.'],
      ['landscape', landscape, 'A short OP.'],
      ['image-only', portrait, ''],
      ['long-filename-'.repeat(20), portrait, 'A short OP.']
    ]) {
      const opening = await post(0, comment, [{ name: `${label}.png`, mime: 'image/png', data }]);
      await post(opening.id, `>>${opening.id}\nA compact reply beside the OP.`);
      await post(opening.id, 'An image reply remains in its own box.',
        [{ name: 'reply.png', mime: 'image/png', data: landscape }]);
      for (let index = 0; index < 12; index += 1) await post(opening.id, `Reply ${index + 1}.`);
      wrappingThreads.push({ id: opening.id });
    }
    const launchOptions = { headless: true, executablePath: process.argv[3] || undefined };
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
    for (const width of [1280, 1024, 769, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const entry of wrappingThreads) {
        await page.goto(`${base}/chiko/thread/${entry.id}`);
        await page.locator('.op .post-img').evaluate(node => node.decode());
        await fits();
        const layout = await page.locator(`#t${entry.id}`).evaluate(thread => {
          const media = thread.querySelector('.op .post-attachments').getBoundingClientRect();
          const image = thread.querySelector('.op .post-img').getBoundingClientRect();
          const metadata = thread.querySelector('.op .file-info').getBoundingClientRect();
          const header = thread.querySelector('.op .delete').getBoundingClientRect();
          const text = document.createRange();
          text.selectNodeContents(thread.querySelector('.op .comment'));
          const op = thread.querySelector('.op').getBoundingClientRect();
          const replies = Array.from(thread.querySelectorAll('.reply-container'), node => node.getBoundingClientRect());
          return {
            mediaWidth: media.width, imageWidth: image.width, metadataWidth: metadata.width,
            replyGap: replies[0].left - image.right, headerGap: header.left - image.right,
            textGap: Array.from(text.getClientRects()).find(rect => rect.width > 0)?.left - image.right,
            firstBeside: replies[0].top < media.bottom && replies[0].left >= media.right,
            below: replies.some(rect => rect.top >= media.bottom && rect.left < media.left + 20),
            stacked: replies[0].top >= Math.max(media.bottom, op.bottom),
            ordered: replies.every((rect, index) => !index || rect.top >= replies[index - 1].bottom),
            contained: thread.getBoundingClientRect().bottom >= Math.max(media.bottom, replies.at(-1).bottom)
          };
        });
        assert.equal(layout.ordered, true, 'Reply boxes never overlap');
        assert.equal(layout.contained, true, 'A thread contains its OP media and every reply');
        assert.ok(Math.abs(layout.mediaWidth - layout.imageWidth) < 1,
          `OP float follows the displayed thumbnail width at ${width}px: ${JSON.stringify(layout)}`);
        assert.ok(layout.metadataWidth <= layout.imageWidth + 1, 'Filenames and metadata stay within the thumbnail width');
        if (width > 768) {
          assert.equal(layout.firstBeside, true, 'Replies start beside short OPs');
          assert.equal(layout.below, true, 'Later replies return to the left below the OP image');
          assert.ok(Math.abs(layout.replyGap - 15) < 1, 'Replies use a consistent 15px gap');
          assert.ok(Math.abs(layout.headerGap - 15) < 1, 'The OP header uses the same 15px gap');
          if (!Number.isNaN(layout.textGap)) assert.ok(Math.abs(layout.textGap - 15) < 1, 'OP text uses the same 15px gap');
        } else {
          assert.equal(layout.stacked, true, 'Mobile replies stack below the complete OP');
        }
        if (entry === wrappingThreads[0]) {
          await page.locator(`#t${entry.id}`).screenshot({ path: path.join(directory, `wrapped-thread-${width}.png`) });
        }
      }
      await page.goto(`${base}/chiko/`);
      await fits();
      const summary = await page.locator(`#t${wrappingThreads[0].id} .omitted-replies`).boundingBox();
      const media = await page.locator(`#p${wrappingThreads[0].id} .post-attachments`).boundingBox();
      if (width > 768) {
        assert.ok(summary.y < media.y + media.height && summary.x >= media.x + media.width,
          'Omitted-reply notices use the space beside the OP');
      } else {
        assert.ok(summary.y >= media.y + media.height, 'Mobile omitted-reply notices stack below the OP');
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${base}/chiko/thread/${wrappingThreads[0].id}`);
    await page.locator('.op .post-attachment').evaluate(attachment => { attachment.style.maxWidth = 'none'; });
    for (const width of [100, 150, 200, 260, 375, 520]) {
      await page.locator('.op .post-img').evaluate((image, width) => {
        Object.assign(image.style, { width: `${width}px`, maxWidth: '100%', maxHeight: 'none' });
      }, width);
      const layout = await page.locator('.op').evaluate(op => {
        const image = op.querySelector('.post-img').getBoundingClientRect();
        const media = op.querySelector('.post-attachments').getBoundingClientRect();
        const reply = op.closest('.thread').querySelector('.reply-container').getBoundingClientRect();
        return { imageWidth: image.width, mediaWidth: media.width, gap: reply.left - image.right };
      });
      assert.ok(Math.abs(layout.imageWidth - width) < 1, `Render a ${width}px thumbnail`);
      assert.ok(Math.abs(layout.mediaWidth - width) < 1, `Fit the float to a ${width}px thumbnail`);
      assert.ok(Math.abs(layout.gap - 15) < 1, `Keep a 15px gap beside a ${width}px thumbnail`);
      await fits();
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
