'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 2;

function numericId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function normalizePost(post, isThread = false) {
  const id = numericId(post?.id);
  if (!id) throw new Error('posts.json contains a post with an invalid id; it was left untouched.');
  const normalized = {
    ...post,
    id,
    name: String(post.name || ''),
    trip: String(post.trip || ''),
    comment: String(post.comment || ''),
    createdAt: Number(post.createdAt) || Date.now(),
    references: [],
    backlinks: []
  };

  if (post.imageBytes !== undefined) normalized.imageBytes = Number(post.imageBytes) || 0;
  if (post.width !== undefined) normalized.width = Number(post.width) || 0;
  if (post.height !== undefined) normalized.height = Number(post.height) || 0;
  normalized.spoiler = Boolean(post.spoiler);

  if (isThread) {
    normalized.title = String(post.title || '');
    normalized.bumpedAt = Number(post.bumpedAt) || normalized.createdAt;
    normalized.sticky = Boolean(post.sticky);
    normalized.locked = Boolean(post.locked);
    normalized.cyclic = Boolean(post.cyclic);
    normalized.replies = Array.isArray(post.replies)
      ? post.replies.map(reply => normalizePost(reply, false)).filter(reply => reply.id)
      : [];
  } else {
    delete normalized.replies;
  }

  return normalized;
}

function extractReferences(comment, maximum) {
  const references = [];
  const seen = new Set();
  const pattern = /(?:^|[^>])>>(\d+)/g;
  let match;

  while ((match = pattern.exec(String(comment || ''))) && references.length < maximum) {
    const id = numericId(match[1]);
    if (id && !seen.has(id)) {
      seen.add(id);
      references.push(id);
    }
  }

  return references;
}

function allPosts(data) {
  const posts = [];
  for (const thread of data.threads) {
    posts.push({ post: thread, threadId: thread.id });
    for (const reply of thread.replies) posts.push({ post: reply, threadId: thread.id });
  }
  return posts;
}

function rebuildBacklinks(data, maximumCites) {
  const entries = allPosts(data);
  const index = new Map(entries.map(entry => [entry.post.id, entry]));

  for (const entry of entries) {
    entry.post.references = extractReferences(entry.post.comment, maximumCites);
    entry.post.backlinks = [];
  }

  for (const source of entries) {
    for (const referencedId of source.post.references) {
      const target = index.get(referencedId);
      if (!target) continue;
      target.post.backlinks.push({ id: source.post.id, threadId: source.threadId });
    }
  }

  for (const entry of entries) {
    entry.post.backlinks.sort((left, right) => left.id - right.id);
  }
}

function normalizeData(input, maximumCites = 45) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('posts.json must contain a JSON object; it was left untouched.');
  }
  const source = input;
  if (source.threads !== undefined && !Array.isArray(source.threads)) {
    throw new Error('posts.json "threads" must be an array; it was left untouched.');
  }
  for (const field of ['reports', 'bans', 'moderationLog']) {
    if (source[field] !== undefined && !Array.isArray(source[field])) {
      throw new Error(`posts.json "${field}" must be an array; it was left untouched.`);
    }
  }
  const threads = (source.threads || []).map(thread => normalizePost(thread, true));

  let highestId = numericId(source.lastId);
  for (const thread of threads) {
    highestId = Math.max(highestId, thread.id);
    for (const reply of thread.replies) highestId = Math.max(highestId, reply.id);
  }

  const ids = new Set();
  for (const entry of threads.flatMap(thread => [thread, ...thread.replies])) {
    if (ids.has(entry.id)) throw new Error(`posts.json contains duplicate post id ${entry.id}; it was left untouched.`);
    ids.add(entry.id);
  }

  const data = {
    version: SCHEMA_VERSION,
    lastId: highestId,
    meta: {
      ...(source.meta && typeof source.meta === 'object' ? source.meta : {}),
      siteSecret: String(source.meta?.siteSecret || crypto.randomBytes(32).toString('base64url'))
    },
    threads,
    reports: Array.isArray(source.reports) ? source.reports : [],
    bans: Array.isArray(source.bans) ? source.bans : [],
    moderationLog: Array.isArray(source.moderationLog) ? source.moderationLog.slice(-200) : []
  };

  rebuildBacklinks(data, maximumCites);
  return data;
}

class JsonStore {
  constructor(config) {
    this.filePath = config.dataFile;
    this.maximumCites = config.limits.maxCites;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.initialize();
  }

  initialize() {
    if (!fs.existsSync(this.filePath)) {
      this.write(normalizeData({}, this.maximumCites));
      return;
    }

    const raw = fs.readFileSync(this.filePath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`posts.json is not valid JSON. It was left untouched: ${error.message}`);
    }

    const normalized = normalizeData(parsed, this.maximumCites);
    if (JSON.stringify(parsed) !== JSON.stringify(normalized)) this.write(normalized);
  }

  read() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      throw new Error(`Could not read posts.json: ${error.message}`);
    }
    return normalizeData(parsed, this.maximumCites);
  }

  write(data) {
    const normalized = normalizeData(data, this.maximumCites);
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
    return normalized;
  }

  update(mutator) {
    const data = this.read();
    const result = mutator(data);
    const saved = this.write(data);
    return { data: saved, result };
  }
}

module.exports = {
  JsonStore,
  SCHEMA_VERSION,
  allPosts,
  extractReferences,
  normalizeData,
  rebuildBacklinks
};
