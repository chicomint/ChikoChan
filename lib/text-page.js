'use strict';

const { escapeHTML } = require('./utils');

function httpUrl(value) {
  const text = String(value || '').trim();
  if (text.length > 2048 || !/^https?:\/\//i.test(text) || /[\s<>"'\\]/.test(text)) return '';
  try {
    const url = new URL(text);
    return url.hostname && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

// A deliberately small Markdown subset. Raw HTML is always text, never markup.
function inline(text, depth = 0) {
  if (depth > 8) return escapeHTML(text);
  const tokens = /`([^`]+)`|\[([^\]\n]+)\]\(([^\s)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*|https?:\/\/[^\s<>*`]+/g;
  let html = '';
  let offset = 0;
  for (const match of text.matchAll(tokens)) {
    html += escapeHTML(text.slice(offset, match.index));
    if (match[1]) html += `<code>${escapeHTML(match[1])}</code>`;
    else if (match[4]) html += `<strong>${inline(match[4], depth + 1)}</strong>`;
    else if (match[5]) html += `<em>${inline(match[5], depth + 1)}</em>`;
    else {
      const destination = match[3] || match[0];
      const href = httpUrl(destination) || (/^\/(?!\/)[^\s<>"'\\]*$/.test(destination) ? destination : '');
      html += href ? `<a href="${escapeHTML(href)}" rel="noopener noreferrer">${escapeHTML(match[2] || match[0])}</a>` : escapeHTML(match[0]);
    }
    offset = match.index + match[0].length;
  }
  return html + escapeHTML(text.slice(offset));
}

function renderTextPage(content) {
  const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  let list = [];
  let listType = '';
  let code = null;
  const flushParagraph = () => {
    if (paragraph.length) blocks.push(`<p>${inline(paragraph.join('\n'))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length) blocks.push(`<${listType}>${list.map(item => `<li>${inline(item)}</li>`).join('')}</${listType}>`);
    list = [];
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flushParagraph();
      flushList();
      if (code === null) code = [];
      else { blocks.push(`<pre><code>${escapeHTML(code.join('\n'))}</code></pre>`); code = null; }
      continue;
    }
    if (code !== null) { code.push(line); continue; }
    const heading = /^(#{1,6})\s*(\S.*)$/.exec(line);
    const item = /^\s*(?:(-)\s*|[+*]\s+|(\d+)\.\s+)(\S.*)$/.exec(line);
    if (heading) {
      flushParagraph(); flushList();
      const level = Math.min(6, heading[1].length + 1);
      blocks.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (item) {
      flushParagraph();
      const type = item[2] ? 'ol' : 'ul';
      if (type !== listType) flushList();
      listType = type;
      list.push(item[3]);
    } else if (!line.trim()) { flushParagraph(); flushList(); }
    else { flushList(); paragraph.push(line); }
  }
  flushParagraph(); flushList();
  if (code !== null) blocks.push(`<pre><code>${escapeHTML(code.join('\n'))}</code></pre>`);
  return blocks.join('\n');
}

module.exports = { httpUrl, renderTextPage };
