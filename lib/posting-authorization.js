'use strict';

const crypto = require('node:crypto');
const { parseCookies, timingSafeEqualStrings } = require('./utils');
const { redisCommand } = require('./rate-limit');

const COOKIE_NAME = 'chikochan_post_authorization';
const BOARD_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

class MemoryAuthorizationNonceStore {
  constructor() {
    this.nonces = new Map();
  }

  async issue(nonce, expiresAt) {
    const now = Date.now();
    if (this.nonces.size > 5000) {
      for (const [key, expiry] of this.nonces) {
        if (expiry <= now) this.nonces.delete(key);
      }
    }
    if (this.nonces.has(nonce)) return false;
    this.nonces.set(nonce, expiresAt);
    return true;
  }

  async consume(nonce, now = Date.now()) {
    const expiresAt = this.nonces.get(nonce);
    this.nonces.delete(nonce);
    return Number(expiresAt) > now;
  }

  async healthCheck() {
    return true;
  }
}

class MongoAuthorizationNonceStore {
  constructor(store) {
    this.store = store;
  }

  async collection() {
    await this.store.ready;
    if (!this.store.db) throw new Error('MongoDB posting authorization requires a MongoStore.');
    return this.store.db.collection('postingAuthorizations');
  }

  async issue(nonce, expiresAt) {
    const collection = await this.collection();
    try {
      await collection.insertOne({
        _id: nonce,
        createdAt: new Date(),
        expiresAt: new Date(expiresAt)
      });
      return true;
    } catch (error) {
      if (error?.code === 11000) return false;
      throw error;
    }
  }

  async consume(nonce, now = Date.now()) {
    const collection = await this.collection();
    const result = await collection.findOneAndDelete({
      _id: nonce,
      expiresAt: { $gt: new Date(now) }
    });
    const record = result?.value || result;
    return Boolean(record?._id);
  }

  async healthCheck() {
    const collection = await this.collection();
    await collection.findOne({}, { projection: { _id: 1 } });
    return true;
  }
}

class RedisAuthorizationNonceStore {
  constructor(client, prefix = 'chikochan') {
    if (!client) throw new Error('A connected Redis-compatible client is required.');
    this.client = client;
    this.prefix = prefix;
  }

  key(nonce) {
    return `${this.prefix}:posting-authorization:${nonce}`;
  }

  async issue(nonce, expiresAt) {
    const ttl = Math.max(1, expiresAt - Date.now());
    const result = await redisCommand(this.client, 'SET', this.key(nonce), '1', 'PX', ttl, 'NX');
    return String(result || '').toUpperCase() === 'OK';
  }

  async consume(nonce) {
    return Boolean(await redisCommand(this.client, 'GETDEL', this.key(nonce)));
  }

  async healthCheck() {
    return String(await redisCommand(this.client, 'PING')).toUpperCase() === 'PONG';
  }
}

function appendCookie(response, cookie) {
  const existing = response.getHeader('Set-Cookie');
  if (!existing) response.setHeader('Set-Cookie', cookie);
  else response.setHeader('Set-Cookie', [...(Array.isArray(existing) ? existing : [existing]), cookie]);
}

class PostingAuthorization {
  constructor(config, nonceStore) {
    this.config = config.postingAuthorization;
    this.publicOrigin = config.deployment.publicOrigin;
    this.nonceStore = nonceStore;
  }

  get enabled() {
    return Boolean(this.config.enabled);
  }

  sign(payload) {
    return crypto.createHmac('sha256', this.config.secret).update(payload).digest('base64url');
  }

  async issue({ boardUri, threadId = 0, addressKey }) {
    if (!this.enabled) return { token: '', expiresAt: 0 };
    const board = String(boardUri || '').trim().toLowerCase();
    const thread = Number(threadId) || 0;
    if (!BOARD_PATTERN.test(board) || !Number.isSafeInteger(thread) || thread < 0) {
      throw new Error('Invalid posting authorization scope.');
    }

    const expiresAt = Date.now() + this.config.ttlMs;
    let nonce;
    let stored = false;
    for (let attempt = 0; attempt < 3 && !stored; attempt += 1) {
      nonce = crypto.randomBytes(24).toString('base64url');
      stored = await this.nonceStore.issue(nonce, expiresAt);
    }
    if (!stored) throw new Error('Could not allocate a posting authorization.');

    const payload = Buffer.from(JSON.stringify({
      version: 1,
      nonce,
      expiresAt,
      board,
      thread,
      addressKey: String(addressKey || '')
    })).toString('base64url');
    return { token: `${payload}.${this.sign(payload)}`, expiresAt };
  }

  readToken(request) {
    const authorization = String(request.get?.('authorization') || '');
    if (authorization.startsWith('ChikoPost ')) return authorization.slice(10).trim();
    const queryToken = String(request.query?.postAuthorization || '');
    if (queryToken) return queryToken;
    return parseCookies(request.headers.cookie)[COOKIE_NAME] || '';
  }

  parse(token) {
    if (!token || token.length > 4096) return null;
    const [payload, signature, extra] = String(token).split('.');
    if (!payload || !signature || extra || !timingSafeEqualStrings(this.sign(payload), signature)) return null;
    try {
      const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (value.version !== 1 || !/^[A-Za-z0-9_-]{32}$/.test(String(value.nonce || ''))
        || !BOARD_PATTERN.test(String(value.board || ''))
        || !Number.isSafeInteger(Number(value.thread)) || Number(value.thread) < 0
        || !Number.isFinite(Number(value.expiresAt)) || Date.now() >= Number(value.expiresAt)
        || !/^[A-Za-z0-9_-]{43}$/.test(String(value.addressKey || ''))) return null;
      return value;
    } catch {
      return null;
    }
  }

  async consume(request, { boardUri, threadId, addressKey }) {
    if (!this.enabled) return { disabled: true };
    const value = this.parse(this.readToken(request));
    const expectedThread = Number(threadId) || 0;
    if (!value || value.board !== String(boardUri || '').toLowerCase()
      || Number(value.thread) !== expectedThread
      || !timingSafeEqualStrings(value.addressKey, addressKey)) return null;
    return await this.nonceStore.consume(value.nonce) ? value : null;
  }

  secureRequest(request) {
    return Boolean(request.secure || this.publicOrigin.startsWith('https://'));
  }

  setCookie(request, response, token) {
    const parts = [
      `${COOKIE_NAME}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${Math.ceil(this.config.ttlMs / 1000)}`
    ];
    if (this.secureRequest(request)) parts.push('Secure');
    appendCookie(response, parts.join('; '));
  }

  clearCookie(request, response) {
    const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
    if (this.secureRequest(request)) parts.push('Secure');
    appendCookie(response, parts.join('; '));
  }
}

function createAuthorizationNonceStore(config, persistence, options = {}) {
  if (options.authorizationNonceStore) return options.authorizationNonceStore;
  if (config.rateLimit.backend === 'redis') {
    return new RedisAuthorizationNonceStore(options.redisClient, config.rateLimit.prefix);
  }
  if (config.storage === 'mongodb') return new MongoAuthorizationNonceStore(persistence);
  return new MemoryAuthorizationNonceStore();
}

module.exports = {
  COOKIE_NAME,
  MemoryAuthorizationNonceStore,
  MongoAuthorizationNonceStore,
  PostingAuthorization,
  RedisAuthorizationNonceStore,
  createAuthorizationNonceStore
};
