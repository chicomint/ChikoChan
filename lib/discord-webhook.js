'use strict';

const crypto = require('node:crypto');
const { encryptionKey } = require('./settings');
const { httpError } = require('./utils');

const WEBHOOK_URL = /^https:\/\/discord\.com\/api\/(?:v10\/)?webhooks\/[0-9]{17,20}\/[A-Za-z0-9_-]{1,200}$/;
const ENCRYPTION_CONTEXT = Buffer.from('chikochan:discord-webhook:1');
const SUPPRESS_EMBEDS = 1 << 2;
const MAX_PREVIEW_LENGTH = 240;
const MAX_PENDING = 50;
const MAX_RETRY_DELAY_MS = 10_000;

function siteOrigin(value) {
  try {
    if (typeof value !== 'string' || value.length > 256 || !/^https?:\/\//i.test(value)) return '';
    const url = new URL(value);
    if (!/^(?:[a-z0-9.-]+|\[[a-f0-9:.]+\])$/i.test(url.hostname)) return '';
    if (!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash) return url.origin;
  } catch {}
  return '';
}

function normalizeDiscordWebhook(value) {
  const origin = siteOrigin(value?.siteOrigin);
  const encryptedUrl = value?.encryptedUrl;
  if (origin && typeof encryptedUrl === 'string' && /^[A-Za-z0-9_-]{39,512}$/.test(encryptedUrl)) {
    return { siteOrigin: origin, encryptedUrl };
  }
}

function updateDiscordWebhook(fields, previous, keyFile) {
  if (fields.action === 'remove') return undefined;
  const origin = siteOrigin(typeof fields.siteOrigin === 'string' ? fields.siteOrigin.trim() : '');
  if (!origin) throw httpError(400, 'Enter the public ChikoChan site URL without a path.');
  const url = fields.webhookUrl === undefined ? '' : fields.webhookUrl;
  if (typeof url !== 'string') throw httpError(400, 'Enter a Discord channel webhook URL copied from Discord.');
  const cleanUrl = url.trim();
  if (!cleanUrl && previous) return { ...previous, siteOrigin: origin };
  if (!WEBHOOK_URL.test(cleanUrl)) throw httpError(400, 'Enter a Discord channel webhook URL copied from Discord.');

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(keyFile), iv);
  cipher.setAAD(ENCRYPTION_CONTEXT);
  const ciphertext = Buffer.concat([cipher.update(cleanUrl, 'utf8'), cipher.final()]);
  const encryptedUrl = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
  return { siteOrigin: origin, encryptedUrl };
}

function decryptWebhookUrl(value, keyFile) {
  const encoded = Buffer.from(value, 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(keyFile), encoded.subarray(0, 12));
  decipher.setAAD(ENCRYPTION_CONTEXT);
  decipher.setAuthTag(encoded.subarray(12, 28));
  const url = Buffer.concat([decipher.update(encoded.subarray(28)), decipher.final()]).toString('utf8');
  if (!WEBHOOK_URL.test(url)) throw new Error('Invalid Discord webhook URL.');
  return url;
}

function discordMessage(origin, { boardUri, postId, location, name, comment }) {
  const url = new URL(location, origin).href;
  const link = `[>>/${boardUri}/${postId}](${url})`;
  let line = `${name} ${comment}`.replace(/[\s\p{Cc}]+/gu, ' ').replaceAll('`', 'ˋ').trim();
  if (line.length > MAX_PREVIEW_LENGTH) line = line.slice(0, MAX_PREVIEW_LENGTH - 1).toWellFormed() + '…';
  return {
    content: `${link} \`${line}\``,
    allowed_mentions: { parse: [] },
    flags: SUPPRESS_EMBEDS
  };
}

class DiscordWebhook {
  constructor({ readSettings, keyFile, fetchImpl = fetch, logger = console }) {
    this.readSettings = readSettings;
    this.keyFile = keyFile;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.pending = 0;
    this.queue = Promise.resolve();
  }

  notify(settings, post) {
    if (!settings) return;
    if (this.pending >= MAX_PENDING) {
      this.logger.warn('Discord webhook delivery queue is full.');
      return;
    }
    this.pending += 1;
    this.queue = this.queue.then(() => this.deliver(settings, post)).catch(() => {
      this.logger.warn('Discord webhook delivery failed.');
    }).finally(() => {
      this.pending -= 1;
    });
  }

  async deliver(settings, post) {
    const current = await this.readSettings();
    if (current?.encryptedUrl !== settings.encryptedUrl || current.siteOrigin !== settings.siteOrigin) return;
    const url = decryptWebhookUrl(settings.encryptedUrl, this.keyFile);
    const body = JSON.stringify(discordMessage(settings.siteOrigin, post));
    const send = () => this.fetch(`${url}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(5000)
    });
    let response = await send();
    if (response.status === 429) {
      const delay = Number(response.headers.get('Retry-After')) * 1000;
      await response.body?.cancel();
      if (!(delay > 0 && delay <= MAX_RETRY_DELAY_MS)) throw new Error('Discord webhook rate limit.');
      await new Promise(resolve => setTimeout(resolve, delay));
      const latest = await this.readSettings();
      if (latest?.encryptedUrl !== settings.encryptedUrl || latest.siteOrigin !== settings.siteOrigin) return;
      response = await send();
    }
    await response.body?.cancel();
    if (!response.ok) throw new Error('Discord webhook rejected the message.');
  }
}

module.exports = { DiscordWebhook, normalizeDiscordWebhook, updateDiscordWebhook };
