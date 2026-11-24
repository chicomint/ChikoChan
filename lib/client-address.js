'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const { httpError } = require('./utils');

function normalizeAddress(value) {
  let address = String(value || '').trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(address);
  if (bracketed) address = bracketed[1];
  const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(address);
  if (ipv4WithPort) address = ipv4WithPort[1];
  const zoneIndex = address.indexOf('%');
  if (zoneIndex >= 0) address = address.slice(0, zoneIndex);
  if (address.startsWith('::ffff:') && net.isIP(address.slice(7)) === 4) address = address.slice(7);
  return net.isIP(address) ? address : '';
}

class ClientAddressPolicy {
  constructor(config) {
    this.railwayHttpIngress = config.railwayHttpIngress === true;
    this.secret = config.privacy.abuseFingerprintSecret
      || crypto.randomBytes(32).toString('base64url');
  }

  address(request) {
    if (this.railwayHttpIngress) {
      // Railway's public HTTP edge overwrites this header with one IP literal.
      const ip = request.headers['x-real-ip'];
      if (typeof ip !== 'string' || !net.isIP(ip) || ip.includes('%')) {
        throw httpError(503, 'Client address unavailable. Please try again later.');
      }
      return normalizeAddress(ip);
    }
    return normalizeAddress(request.ip)
      || normalizeAddress(request.socket?.remoteAddress)
      || 'unknown';
  }

  fingerprint(request, purpose) {
    const normalizedPurpose = String(purpose || 'abuse').replace(/[^a-z0-9:_-]/gi, '').slice(0, 80) || 'abuse';
    return crypto.createHmac('sha256', this.secret)
      .update(`${normalizedPurpose}:${this.address(request)}`)
      .digest('base64url');
  }
}

module.exports = { ClientAddressPolicy, normalizeAddress };
