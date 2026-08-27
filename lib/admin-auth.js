'use strict';

const crypto = require('node:crypto');
const { parseCookies, timingSafeEqualStrings } = require('./utils');

const COOKIE_NAME = 'chikochan_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

class AdminAuth {
  constructor(config) {
    this.password = config.adminPassword;
    this.secret = config.adminSessionSecret;
    this.forceSecureCookies = config.deployment?.isProduction === true
      || String(config.deployment?.publicOrigin || '').startsWith('https://');
  }

  get configured() {
    return Boolean(this.secret);
  }

  get legacyConfigured() {
    return Boolean(this.password && this.secret);
  }

  sign(value) {
    return crypto.createHmac('sha256', this.secret).update(value).digest('base64url');
  }

  createToken(identity = {}) {
    const payload = Buffer.from(JSON.stringify({
      exp: Date.now() + SESSION_TTL_MS,
      nonce: crypto.randomBytes(18).toString('base64url'),
      ...(identity.accountId ? {
        accountId: String(identity.accountId),
        sessionVersion: Number(identity.sessionVersion)
      } : { kind: 'legacy' })
    })).toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  readSession(request) {
    if (!this.configured) return null;
    const token = parseCookies(request.headers.cookie)[COOKIE_NAME];
    if (!token) return null;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra || !timingSafeEqualStrings(this.sign(payload), signature)) return null;
    try {
      const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!session.nonce || !session.exp || Date.now() >= Number(session.exp)) return null;
      return session;
    } catch {
      return null;
    }
  }

  csrf(session) {
    return crypto.createHmac('sha256', this.secret).update(`csrf:${session.nonce}`).digest('base64url');
  }

  verifyCsrf(request) {
    return Boolean(request.adminSession)
      && timingSafeEqualStrings(this.csrf(request.adminSession), request.body.csrf);
  }

  verifyPassword(password) {
    return this.legacyConfigured && timingSafeEqualStrings(this.password, password);
  }

  secureRequest(request) {
    return this.forceSecureCookies || request.secure;
  }

  setCookie(request, response, token) {
    const parts = [
      `${COOKIE_NAME}=${encodeURIComponent(token)}`,
      'Path=/admin',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
    ];
    if (this.secureRequest(request)) parts.push('Secure');
    response.setHeader('Set-Cookie', parts.join('; '));
  }

  clearCookie(request, response) {
    const parts = [`${COOKIE_NAME}=`, 'Path=/admin', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
    if (this.secureRequest(request)) parts.push('Secure');
    response.setHeader('Set-Cookie', parts.join('; '));
  }
}

module.exports = { AdminAuth };
