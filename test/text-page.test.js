'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { renderTextPage, httpUrl } = require('../lib/text-page');
const { normalizeCustomization, normalizeData, createDefaultBoard } = require('../lib/store');
const { documentsFromData, dataFromDocuments } = require('../lib/mongo-store');

test('text pages render headings, paragraphs, lists, links and literal code safely', () => {
  const html = renderTextPage('# Title\n\n## Section\nParagraph **bold** and *emphasis* with `a < b`.\n\n- one\n- two\n\n1. first\n2. second\n\n[site](https://example.com)\n\n```js\n<script>alert(1)</script>\n```\n\n<img src=x onerror=alert(1)>\n[javascript](javascript:alert(1))\n[data](data:text/html,evil)');
  for (const fragment of ['<h2>Title</h2>', '<h3>Section</h3>', '<strong>bold</strong>', '<em>emphasis</em>', '<code>a &lt; b</code>', '<ul><li>one</li><li>two</li></ul>', '<ol><li>first</li><li>second</li></ol>', 'href="https://example.com/"', '<pre><code>&lt;script&gt;']) assert.ok(html.includes(fragment), fragment);
  assert.doesNotMatch(html, /<script|<img|href="(?:javascript|data):/);
  assert.match(renderTextPage('#News\n\n-No spam\n-No harassment'), /<ul><li>No spam/);
  assert.match(renderTextPage('**https://example.com**'), /<p><strong><a/);
  assert.match(renderTextPage('```\n<unfinished>'), /&lt;unfinished&gt;<\/code><\/pre>/);
});

test('banner URL normalization rejects unsafe schemes, credentials and malformed values', () => {
  for (const value of ['javascript:alert(1)', '//example.com/x', 'data:image/png,x', 'https://', 'https://a:b@example.com/x', 'https://example.com/" onerror="x', 'https://example.com/\\evil', 'https://example.com/\nx']) assert.equal(httpUrl(value), '', value);
  assert.equal(httpUrl('http://example.com/banner.png'), 'http://example.com/banner.png');
  assert.equal(normalizeCustomization({}).globalBanner.enabled, false);
  assert.equal(normalizeCustomization({ globalBanner: { enabled: 'true', imageUrl: 'javascript:x' } }).globalBanner.imageUrl, '');
});

test('global banner survives the MongoDB document round trip', () => {
  const data = normalizeData({ customization: { globalBanner: { enabled: true, imageUrl: 'https://example.com/banner.png', linkUrl: 'https://example.com/', alt: 'Banner' } } }, 45, createDefaultBoard({ board: { uri: 'chiko', title: 'ChikoChan' } }));
  const restored = dataFromDocuments(documentsFromData(data));
  assert.deepEqual(restored.customization.globalBanner, data.customization.globalBanner);
});
