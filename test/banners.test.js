'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { bannerFilename, bannerDirectory, listBanners, openBanner } = require('../lib/banners');
const { loadConfig } = require('../config');
const { normalizeCustomization } = require('../lib/store');
const { Renderer } = require('../lib/render');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

test('banner scan excludes directories, symlinks, hidden, suspicious and invalid images', t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'banner-test-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const config = { ...loadConfig({ storage: 'json', dataDir: rootDir }), rootDir };
  const folder = bannerDirectory(config);
  assert.deepEqual(listBanners(config), []);
  fs.mkdirSync(folder);
  for (const name of ['Z.png', 'a.png', '.hidden.png', 'bad..png', 'evil<script>.png', 'unsupported.txt']) {
    fs.writeFileSync(path.join(folder, name), PNG);
  }
  fs.mkdirSync(path.join(folder, 'directory.png'));
  fs.writeFileSync(path.join(folder, 'fake.png'), '<html>not an image</html>');
  fs.writeFileSync(path.join(folder, 'mismatch.jpg'), PNG);
  fs.writeFileSync(path.join(rootDir, 'outside.png'), PNG);
  fs.symlinkSync(path.join(rootDir, 'outside.png'), path.join(folder, 'link.png'));
  assert.deepEqual(listBanners(config), ['a.png', 'Z.png']);
  const renderer = new Renderer(loadConfig({ storage: 'json', dataDir: rootDir }));
  renderer.config = config;
  renderer.customization = () => normalizeCustomization({ globalBanner: { enabled: true, filename: 'a.png' } });
  const html = renderer.adminCustomization(normalizeCustomization({}), 'csrf');
  assert.ok(html.includes('<option value="a.png"'));
  assert.ok(html.includes('<option value="Z.png"'));
  for (const name of ['.hidden.png', 'bad..png', 'unsupported.txt', 'directory.png', 'fake.png', 'mismatch.jpg', 'link.png']) {
    assert.ok(!html.includes(`<option value="${name}"`), name);
  }
  assert.ok(renderer.globalBannerHTML().includes('/banner/a.png'));
  for (const name of ['../outside.png', '/etc/passwd', 'https://a/b.png', 'a\\b.png', 'a%2f.png', 'fake.png', 'link.png', 'directory.png', 'mismatch.jpg']) {
    assert.equal(openBanner(config, name), null, name);
  }
  for (const extension of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'PNG']) assert.ok(bannerFilename(`banner.${extension}`));
  fs.unlinkSync(path.join(folder, 'a.png'));
  assert.equal(renderer.globalBannerHTML(), '');
});
