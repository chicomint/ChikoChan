'use strict';

const { httpError } = require('./utils');

const HOOK_NAMES = Object.freeze([
  'beforeUpload',
  'afterUpload',
  'beforePost',
  'afterPost',
  'reportCreated',
  'moderationAction'
]);
const BLOCKING_HOOKS = new Set(['beforeUpload', 'beforePost']);

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function immutablePayload(value) {
  return deepFreeze(structuredClone(value));
}

class HookRegistry {
  #handlers;

  constructor(config, definitions = {}, options = {}) {
    this.timeoutMs = config.extensions.hookTimeoutMs;
    this.logger = options.logger || console;
    this.#handlers = new Map(HOOK_NAMES.map(name => [name, []]));
    for (const [name, supplied] of Object.entries(definitions || {})) {
      if (!this.#handlers.has(name)) throw new Error(`Unknown extension hook: ${name}.`);
      const handlers = Array.isArray(supplied) ? supplied : [supplied];
      if (handlers.length > 10 || handlers.some(handler => typeof handler !== 'function')) {
        throw new Error(`Extension hook ${name} must contain at most 10 functions.`);
      }
      this.#handlers.set(name, [...handlers]);
    }
  }

  async invokeWithTimeout(name, handler, payload) {
    let timeout;
    try {
      return await Promise.race([
        Promise.resolve().then(() => handler(payload)),
        new Promise((resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(`Extension hook ${name} timed out.`)), this.timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  async runBlocking(name, value) {
    if (!BLOCKING_HOOKS.has(name)) throw new Error(`${name} is not a blocking extension hook.`);
    const payload = immutablePayload(value);
    for (const handler of this.#handlers.get(name)) {
      try {
        await this.invokeWithTimeout(name, handler, payload);
      } catch (error) {
        if (Number(error?.status) >= 400 && Number(error?.status) < 500) throw error;
        this.logger.error(`Blocking extension hook ${name} failed: ${error.message}`);
        throw httpError(503, 'A posting safety extension is temporarily unavailable.');
      }
    }
  }

  notify(name, value) {
    if (BLOCKING_HOOKS.has(name) || !this.#handlers.has(name)) {
      throw new Error(`${name} is not an observational extension hook.`);
    }
    const payload = immutablePayload(value);
    for (const handler of this.#handlers.get(name)) {
      queueMicrotask(async () => {
        try {
          await this.invokeWithTimeout(name, handler, payload);
        } catch (error) {
          this.logger.error(`Observational extension hook ${name} failed: ${error.message}`);
        }
      });
    }
  }
}

module.exports = { HOOK_NAMES, HookRegistry, immutablePayload };
