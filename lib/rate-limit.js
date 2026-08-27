'use strict';

const crypto = require('node:crypto');
const { httpError } = require('./utils');

function resultFor(count, limit, windowMs, now, resetAt) {
  return {
    allowed: count <= limit,
    count,
    limit,
    remaining: Math.max(0, limit - count),
    resetAt,
    retryAfterMs: Math.max(0, resetAt - now) || windowMs
  };
}

class MemoryRateLimitStore {
  constructor() {
    this.buckets = new Map();
  }

  async consume(key, limit, windowMs, now = Date.now()) {
    const bucketId = `${key}:${Math.floor(now / windowMs)}`;
    const resetAt = (Math.floor(now / windowMs) + 1) * windowMs;
    const current = this.buckets.get(bucketId) || { count: 0, resetAt };
    current.count += 1;
    this.buckets.set(bucketId, current);

    if (this.buckets.size > 5000) {
      for (const [id, bucket] of this.buckets) {
        if (bucket.resetAt <= now) this.buckets.delete(id);
      }
    }
    return resultFor(current.count, limit, windowMs, now, resetAt);
  }

  async healthCheck() {
    return true;
  }

  async close() {}
}

class MongoRateLimitStore {
  constructor(store, prefix = 'chikochan') {
    this.store = store;
    this.prefix = prefix;
  }

  async collection() {
    await this.store.ready;
    if (!this.store.db) throw new Error('MongoDB rate limiting requires a MongoStore.');
    return this.store.db.collection('rateLimitBuckets');
  }

  async consume(key, limit, windowMs, now = Date.now()) {
    const windowId = Math.floor(now / windowMs);
    const resetAt = (windowId + 1) * windowMs;
    const id = `${this.prefix}:${key}:${windowId}`;
    const collection = await this.collection();
    const result = await collection.findOneAndUpdate(
      { _id: id },
      {
        $inc: { count: 1 },
        $setOnInsert: {
          createdAt: new Date(now),
          expiresAt: new Date(resetAt + windowMs)
        }
      },
      { upsert: true, returnDocument: 'after' }
    );
    const bucket = result?.value || result;
    return resultFor(Number(bucket?.count) || 1, limit, windowMs, now, resetAt);
  }

  async healthCheck() {
    const collection = await this.collection();
    await collection.findOne({}, { projection: { _id: 1 } });
    return true;
  }

  async close() {}
}

async function redisCommand(client, command, ...arguments_) {
  if (typeof client.sendCommand === 'function') {
    return client.sendCommand([command, ...arguments_.map(String)]);
  }
  const method = command.toLowerCase();
  if (typeof client[method] === 'function') return client[method](...arguments_);
  throw new Error('The Redis client does not expose sendCommand or compatible command methods.');
}

class RedisRateLimitStore {
  constructor(client, prefix = 'chikochan') {
    if (!client) throw new Error('A connected Redis-compatible client is required.');
    this.client = client;
    this.prefix = prefix;
  }

  async consume(key, limit, windowMs, now = Date.now()) {
    const windowId = Math.floor(now / windowMs);
    const resetAt = (windowId + 1) * windowMs;
    const redisKey = `${this.prefix}:rate:${key}:${windowId}`;
    const script = [
      'local count = redis.call("INCR", KEYS[1])',
      'if count == 1 then redis.call("PEXPIRE", KEYS[1], ARGV[1]) end',
      'return count'
    ].join('\n');
    let count;
    if (typeof this.client.eval === 'function') {
      try {
        count = await this.client.eval(script, { keys: [redisKey], arguments: [String(windowMs * 2)] });
      } catch (error) {
        if (!/argument|number|option/i.test(String(error?.message || ''))) throw error;
        count = await this.client.eval(script, 1, redisKey, String(windowMs * 2));
      }
    } else {
      count = await redisCommand(this.client, 'EVAL', script, 1, redisKey, windowMs * 2);
    }
    return resultFor(Number(count) || 1, limit, windowMs, now, resetAt);
  }

  async healthCheck() {
    return String(await redisCommand(this.client, 'PING')).toUpperCase() === 'PONG';
  }

  async close() {
    if (typeof this.client.quit === 'function') await this.client.quit();
  }
}

class RateLimiter {
  constructor(config, store) {
    this.config = config.rateLimit;
    this.store = store;
  }

  operation(name) {
    const operation = this.config.operations[name];
    if (!operation) throw new Error(`Unknown rate-limit operation: ${name}.`);
    return operation;
  }

  async consume(name, identity, message) {
    const operation = this.operation(name);
    const key = crypto.createHash('sha256')
      .update(`${name}:${String(identity || 'unknown')}`)
      .digest('base64url');
    const result = await this.store.consume(key, operation.limit, operation.windowMs);
    if (!result.allowed) {
      const error = httpError(429, message || 'Too many requests. Wait and try again.');
      error.retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
      throw error;
    }
    return result;
  }

  middleware(name, identityFor, message) {
    return async (request, response, next) => {
      try {
        const identity = await identityFor(request);
        const result = await this.consume(name, identity, message);
        response.setHeader('RateLimit-Limit', String(result.limit));
        response.setHeader('RateLimit-Remaining', String(result.remaining));
        response.setHeader('RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
        next();
      } catch (error) {
        if (error.retryAfterSeconds) response.setHeader('Retry-After', String(error.retryAfterSeconds));
        next(error);
      }
    };
  }
}

function createRateLimitStore(config, persistence, options = {}) {
  if (options.rateLimitStore) return options.rateLimitStore;
  if (config.rateLimit.backend === 'memory') return new MemoryRateLimitStore();
  if (config.rateLimit.backend === 'mongodb') return new MongoRateLimitStore(persistence, config.rateLimit.prefix);
  return new RedisRateLimitStore(options.redisClient, config.rateLimit.prefix);
}

module.exports = {
  MemoryRateLimitStore,
  MongoRateLimitStore,
  RateLimiter,
  RedisRateLimitStore,
  createRateLimitStore,
  redisCommand
};
