'use strict';

const crypto = require('node:crypto');

function jobError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

class BoundedJobQueue {
  constructor(options = {}) {
    this.concurrency = Math.max(1, Number(options.concurrency) || 1);
    this.timeoutMs = Math.max(100, Number(options.timeoutMs) || 15000);
    this.retryLimit = Math.max(0, Number(options.retryLimit) || 0);
    this.maxQueue = Math.max(this.concurrency, Number(options.maxQueue) || 100);
    this.queue = [];
    this.active = 0;
    this.accepting = true;
    this.deadLetters = [];
    this.completed = new Map();
    this.idleWaiters = [];
  }

  submit(type, payload, handler, options = {}) {
    if (!this.accepting) return Promise.reject(jobError(503, 'The media worker is shutting down.'));
    if (typeof handler !== 'function') return Promise.reject(new TypeError('A job handler is required.'));
    if (this.queue.length + this.active >= this.maxQueue) {
      return Promise.reject(jobError(503, 'The media worker queue is full. Try again later.'));
    }
    const idempotencyKey = String(options.idempotencyKey || '');
    if (idempotencyKey && this.completed.has(idempotencyKey)) {
      return Promise.resolve(structuredClone(this.completed.get(idempotencyKey)));
    }
    const job = {
      id: crypto.randomUUID(),
      type: String(type || 'media'),
      payload: structuredClone(payload || {}),
      handler,
      idempotencyKey,
      timeoutMs: Math.max(100, Number(options.timeoutMs) || this.timeoutMs),
      retryLimit: Math.max(0, Number.isInteger(options.retryLimit) ? options.retryLimit : this.retryLimit),
      attempts: 0,
      createdAt: Date.now(),
      status: 'pending'
    };
    const promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    this.queue.push(job);
    this.pump();
    return promise;
  }

  pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.active += 1;
      void this.execute(job).finally(() => {
        this.active -= 1;
        this.pump();
        this.resolveIdle();
      });
    }
    this.resolveIdle();
  }

  async execute(job) {
    job.attempts += 1;
    job.status = 'running';
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const error = jobError(504, 'Media processing exceeded its bounded timeout.');
        error.code = 'MEDIA_JOB_TIMEOUT';
        reject(error);
      }, job.timeoutMs);
    });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => job.handler({
          id: job.id,
          type: job.type,
          attempt: job.attempts,
          signal: controller.signal
        })),
        timeout
      ]);
      job.status = 'completed';
      job.completedAt = Date.now();
      if (job.idempotencyKey) {
        this.completed.set(job.idempotencyKey, structuredClone(result));
        if (this.completed.size > 1000) this.completed.delete(this.completed.keys().next().value);
      }
      job.resolve(result);
    } catch (error) {
      if (error?.retryable === true && job.attempts <= job.retryLimit && this.accepting) {
        job.status = 'retrying';
        this.queue.push(job);
        return;
      }
      job.status = 'failed';
      job.failedAt = Date.now();
      this.deadLetters.push({
        id: job.id,
        type: job.type,
        attempts: job.attempts,
        createdAt: job.createdAt,
        failedAt: job.failedAt,
        errorCode: String(error?.code || 'MEDIA_JOB_FAILED').slice(0, 80)
      });
      this.deadLetters = this.deadLetters.slice(-100);
      job.reject(error);
    } finally {
      clearTimeout(timer);
    }
  }

  resolveIdle() {
    if (this.active || this.queue.length) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  status() {
    return {
      accepting: this.accepting,
      active: this.active,
      queued: this.queue.length,
      concurrency: this.concurrency,
      maxQueue: this.maxQueue,
      failed: this.deadLetters.length
    };
  }

  async healthCheck() {
    return this.accepting && this.queue.length + this.active < this.maxQueue;
  }

  async close() {
    this.accepting = false;
    if (!this.active && !this.queue.length) return;
    await new Promise(resolve => this.idleWaiters.push(resolve));
  }
}

class ExternalJobQueue {
  constructor(adapter) {
    if (!adapter || typeof adapter.submit !== 'function') {
      throw new Error('An external media job adapter with submit() is required.');
    }
    this.adapter = adapter;
  }

  submit(type, payload, handler, options) {
    return this.adapter.submit(type, payload, options);
  }

  status() {
    return this.adapter.status?.() || { accepting: true, mode: 'external' };
  }

  healthCheck() {
    return this.adapter.healthCheck?.() ?? Promise.resolve(true);
  }

  close() {
    return this.adapter.close?.() ?? Promise.resolve();
  }
}

module.exports = { BoundedJobQueue, ExternalJobQueue };
