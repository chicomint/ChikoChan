'use strict';

const { escapeHTML } = require('./utils');

function buildPostIndex(data) {
  const index = new Map();
  const boardUris = new Map((data.boards || []).map(board => [board.id, board.uri]));
  for (const thread of data.threads || []) {
    const boardUri = boardUris.get(thread.boardId);
    index.set(Number(thread.id), {
      post: thread,
      threadId: Number(thread.id),
      boardUri,
      isOp: true
    });
    for (const reply of thread.replies || []) {
      index.set(Number(reply.id), {
        post: reply,
        threadId: Number(thread.id),
        boardUri,
        isOp: false
      });
    }
  }
  return index;
}

function quoteHref(boardUri, currentThreadId, target) {
  if (!target) return '';
  if (Number(currentThreadId) === Number(target.threadId)) return `#p${target.post.id}`;
  return `/${target.boardUri || boardUri}/thread/${target.threadId}#p${target.post.id}`;
}

function formatFortune(fortune) {
  if (!fortune) return '';
  return `<span class="fortune" title="Server-generated fortune">Your fortune: ${escapeHTML(fortune)}</span>`;
}

function formatInline(line, options) {
  const urls = [];
  let html = escapeHTML(line);

  html = html.replace(/https?:\/\/[^\s<>]+/gi, match => {
    const token = `\u0001URL${urls.length}\u0002`;
    urls.push(match);
    return token;
  });

  html = html
    .replace(/\*\*([^*]+?)\*\*/g, '<span class="spoiler">$1</span>')
    .replace(/&#39;&#39;&#39;(.+?)&#39;&#39;&#39;/g, '<strong>$1</strong>')
    .replace(/&#39;&#39;(.+?)&#39;&#39;/g, '<em>$1</em>');

  html = html.replace(/&gt;&gt;(\d+)/g, (full, rawId) => {
    const id = Number(rawId);
    const target = options.postIndex.get(id);
    if (!target) return `<span class="deadlink" data-post-id="${id}">${full}</span>`;
    const href = quoteHref(options.boardUri, options.threadId, target);
    return `<a class="quotelink" href="${href}" data-post-id="${id}">${full}</a>`;
  });

  html = html.replace(/\u0001URL(\d+)\u0002/g, (full, rawIndex) => {
    const url = urls[Number(rawIndex)];
    return `<a class="external-link" href="${url}" rel="nofollow noreferrer noopener" target="_blank">${url}</a>`;
  });

  return html;
}

function formatComment(comment, options) {
  if (!comment) return '';
  return String(comment)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => {
      const html = formatInline(line, options);
      if (/^\s*>/.test(line)) return `<span class="greentext">${html}</span>`;
      if (/^\s*==.+==\s*$/.test(line)) return `<span class="heading">${html.replace(/^==|==$/g, '')}</span>`;
      return html;
    })
    .join('<br>');
}

module.exports = { buildPostIndex, formatComment, formatFortune, quoteHref };
