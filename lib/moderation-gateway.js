'use strict';

const fs = require('node:fs');
const { BoundedJobQueue } = require('./jobs');

// The gateway contract is intentionally separate from any vendor's credentials or
// perceptual hashing algorithm. Never substitute SHA-256 for a perceptual hash.
class ModerationGateway {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.queue = new BoundedJobQueue({ concurrency: 2, maxQueue: 20, timeoutMs: config.timeoutMs + 1000, retryLimit: 0 });
  }

  get available() { return Boolean(this.config.gatewayUrl && this.config.gatewayToken); }
  status() { return { name: 'gateway', available: this.available, reason: this.available ? '' : 'not-configured' }; }

  request(operation, payload) {
    return this.queue.submit('media-screening', {}, ({ signal }) => this.send(operation, payload, signal));
  }

  async send(operation, payload, signal) {
    if (!this.available) throw new Error('Moderation gateway is not configured.');
    const form = new FormData();
    form.set('operation', operation);
    form.set('metadata', JSON.stringify({ sha256: payload.sha256, contentSha256: payload.contentSha256, mime: payload.mime, bytes: payload.bytes }));
    if (payload.filePath) form.set('file', new Blob([await fs.promises.readFile(payload.filePath)], { type: payload.mime }), 'media');
    const response = await this.fetch(this.config.gatewayUrl, {
      method: 'POST', body: form, redirect: 'error',
      headers: { Authorization: `Bearer ${this.config.gatewayToken}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)])
    });
    if (!response.ok) throw new Error('Moderation gateway failed.');
    const reader = response.body.getReader();
    let bytes = 0;
    const chunks = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 16384) throw new Error('Moderation gateway response too large.');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  close() { return this.queue.close(); }

  check(payload) { return this.request('known-illegal', payload); }
  screen(payload) { return this.request('adult', payload); }
}

module.exports = { ModerationGateway };
