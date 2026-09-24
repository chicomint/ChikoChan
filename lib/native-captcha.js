'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { parseCookies, httpError, timingSafeEqualStrings } = require('./utils');

const COOKIE = 'chikochan_verification';
const TTL = 5 * 60 * 1000;
// Draw glyphs as pixels, never as selectable text or an answer in image metadata.
const DIGITS = [
  '01110100011001110101110011000101110',
  '00100011000010000100001000010001110',
  '01110100010000100010001000100011111',
  '11110000010000101110000010000111110',
  '00010001100101010010111110001000010',
  '11111100001000011110000010000111110',
  '01110100001000011110100011000101110',
  '11111000010001000100010000100001000',
  '01110100011000101110100011000101110',
  '01110100011000101111000010000101110'
];

class NativeCaptcha {
  constructor(config, nonceStore) {
    this.enabled = config.postingAuthorization.enabled || config.antiAbuse.turnstile.enabled;
    this.key = crypto.createHash('sha256').update('chikochan-native-captcha-v1\0')
      .update(config.postingAuthorization.secret || config.antiAbuse.turnstile.secretKey || crypto.randomBytes(32)).digest();
    this.nonceStore = nonceStore;
    this.secure = config.deployment.publicOrigin.startsWith('https://');
  }

  session(request, response) {
    let session = parseCookies(request.headers.cookie)[COOKIE];
    if (!/^[a-f0-9]{64}$/.test(session || '')) {
      session = crypto.randomBytes(32).toString('hex');
      response.append('Set-Cookie', `${COOKIE}=${session}; Path=/; HttpOnly; SameSite=Strict${request.secure || this.secure ? '; Secure' : ''}`);
    }
    response.setHeader('Cache-Control', 'private, no-store');
    return session;
  }

  issue({ board, thread, addressKey, session }) {
    const answer = Array.from({ length: 6 }, () => crypto.randomInt(10)).join('');
    const value = { board, thread, addressKey, session, answer,
      nonce: `captcha:${crypto.randomBytes(24).toString('hex')}`, expiresAt: Date.now() + TTL };
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    const token = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
    return { token, image: this.image(answer) };
  }

  parse(token) {
    try {
      if (typeof token !== 'string' || token.length > 2048 || !/^[\w-]+$/.test(token)) return null;
      const bytes = Buffer.from(token, 'base64url');
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const value = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]));
      return value.expiresAt > Date.now() ? value : null;
    } catch { return null; }
  }

  async consume(request, { board, thread, addressKey }) {
    const value = this.parse(request.query.nativeChallenge);
    const session = parseCookies(request.headers.cookie)[COOKIE] || '';
    if (!value || value.board !== board || value.thread !== thread
      || !timingSafeEqualStrings(value.addressKey, addressKey)
      || !timingSafeEqualStrings(value.session, session)
      // Reserve spent nonces until expiry, including incorrect attempts. Atomic across replicas.
      || !await this.nonceStore.issue(value.nonce, value.expiresAt)) {
      throw httpError(403, 'Verification expired, was already attempted, or belongs to another form. Return to the board/thread for a fresh challenge.');
    }
    return value;
  }

  verify(value, answer) {
    if (typeof answer !== 'string' || !timingSafeEqualStrings(value.answer, answer.trim())) {
      throw httpError(400, 'The image verification answer is incorrect. Return to the board/thread for a fresh challenge.');
    }
  }

  image(answer) {
    const width = 210;
    const height = 65;
    const rows = Buffer.alloc(height * (width * 3 + 1), 248);
    for (let y = 0; y < height; y += 1) rows[y * (width * 3 + 1)] = 0;
    const pixel = (x, y, shade) => {
      x = Math.round(x); y = Math.round(y);
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      rows.fill(shade, offset, offset + 3);
    };
    for (let i = 0; i < answer.length; i += 1) {
      const top = 14 + crypto.randomInt(7);
      const tilt = crypto.randomInt(-15, 16) / 100;
      const phase = crypto.randomInt(10);
      [...DIGITS[Number(answer[i])]].forEach((bit, index) => {
        if (bit !== '1') return;
        for (let dy = 0; dy < 4; dy += 1) {
          for (let dx = 0; dx < 4; dx += 1) {
            const y = Math.floor(index / 5) * 4 + dy;
            pixel(12 + i * 32 + index % 5 * 4 + dx + tilt * y + Math.sin((y + phase) / 6), top + y, 35);
          }
        }
      });
    }
    for (let i = 0; i < 300; i += 1) pixel(crypto.randomInt(width), crypto.randomInt(height), 135);
    const chunk = (type, data) => {
      const body = Buffer.concat([Buffer.from(type), data]);
      let crc = 0xffffffff;
      for (const byte of body) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
      const length = Buffer.alloc(4);
      length.writeUInt32BE(data.length);
      const checksum = Buffer.alloc(4);
      checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
      return Buffer.concat([length, body, checksum]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
    header[8] = 8; header[9] = 2;
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'),
      chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
    return `data:image/png;base64,${png.toString('base64')}`;

  }
}

module.exports = { NativeCaptcha };
