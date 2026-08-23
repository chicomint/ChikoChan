'use strict';

const crypto = require('node:crypto');
const { httpError } = require('./utils');

const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
const TURNSTILE_VERIFY_URL = `${TURNSTILE_ORIGIN}/turnstile/v0/siteverify`;

function rejection(message = 'Human verification failed. Refresh the challenge and try again.') {
  const error = httpError(400, message);
  error.captchaRejected = true;
  return error;
}

class TurnstileAdapter {
  constructor(config, options = {}) {
    this.config = config.antiAbuse.turnstile;
    this.fetch = options.fetchImpl || globalThis.fetch;
    this.logger = options.logger || console;
  }

  get enabled() {
    return Boolean(this.config.enabled);
  }

  async verify(rawToken) {
    if (!this.enabled) return { success: true, disabled: true };
    const token = String(rawToken || '').trim();
    if (!token || token.length > 2048 || /[\u0000-\u001f\u007f]/.test(token)) {
      throw rejection();
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    timeout.unref?.();
    try {
      const body = new URLSearchParams({
        secret: this.config.secretKey,
        response: token,
        idempotency_key: crypto.randomUUID()
      });
      const response = await this.fetch(TURNSTILE_VERIFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        redirect: 'error',
        signal: controller.signal
      });
      if (!response?.ok) throw new Error('Turnstile returned a non-success HTTP status.');
      const text = await response.text();
      if (text.length > 32 * 1024) throw new Error('Turnstile returned an oversized response.');
      let result;
      try {
        result = JSON.parse(text);
      } catch {
        throw new Error('Turnstile returned malformed JSON.');
      }
      if (result?.success !== true) throw rejection();
      if (result.action !== 'post') throw rejection();
      const hostname = String(result.hostname || '').toLowerCase();
      if (this.config.allowedHostnames.length && !this.config.allowedHostnames.includes(hostname)) {
        throw rejection();
      }
      return { success: true, action: 'post', hostname };
    } catch (error) {
      if (error.captchaRejected) throw error;
      if (this.config.failureMode === 'open') {
        this.logger.warn('Turnstile verification was unavailable; allowing the post because failureMode is open.');
        return { success: true, bypassed: 'provider-unavailable' };
      }
      throw httpError(503, 'Human verification is temporarily unavailable. Try again shortly.');
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = { TURNSTILE_ORIGIN, TURNSTILE_VERIFY_URL, TurnstileAdapter };
