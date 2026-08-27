'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

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
    this.secret = config.privacy.abuseFingerprintSecret
      || crypto.randomBytes(32).toString('base64url');
  }

  address(request) {
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
