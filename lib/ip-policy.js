'use strict';

const net = require('node:net');
const { normalizeAddress } = require('./client-address');
const { httpError } = require('./utils');
const DAY = 86400000;

function retentionDays(data, config) {
  return data.meta.ipRetentionDays ?? config.privacy.ipRetentionDays ?? 30;
}

function retainedIp(post, data, config, now = Date.now()) {
  const days = retentionDays(data, config);
  return days !== 0 && Number(post.ipCapturedAt || post.createdAt) <= now - days * DAY
    ? '' : normalizeAddress(post.posterIp);
}

function ipNetwork(value) {
  const parts = String(value || '').trim().split('/');
  const address = normalizeAddress(parts[0]);
  const family = net.isIP(address);
  const bits = family === 4 ? 32 : 128;
  const prefix = parts.length === 1 ? bits : Number(parts[1]);
  if (!family || parts.length > 2 || (parts.length === 2 && !/^\d+$/.test(parts[1]))
    || !Number.isInteger(prefix) || prefix < 0 || prefix > bits) {
    throw httpError(400, 'Enter a valid IPv4 or IPv6 address or CIDR range.');
  }
  // Mask host bits so the stored range describes exactly what will be banned.
  const bytes = family === 4 ? address.split('.').map(Number) : (() => {
    const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    const halves = canonical.split('::');
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const groups = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
    return groups.flatMap(group => [parseInt(group, 16) >> 8, parseInt(group, 16) & 255]);
  })();
  const masked = bytes.map((byte, index) => byte & (255 << Math.max(0, Math.min(8, index * 8 + 8 - prefix))));
  const base = family === 4 ? masked.join('.') : masked.reduce((groups, byte, index) => {
    if (index % 2 === 0) groups.push(((byte << 8) | masked[index + 1]).toString(16));
    return groups;
  }, []).join(':');
  return `${base}/${prefix}`;
}

function matchesIp(network, value) {
  const address = normalizeAddress(value);
  if (!address || !network) return false;
  try {
    const [base, prefix] = network.split('/');
    const family = net.isIP(base) === 4 ? 'ipv4' : 'ipv6';
    const list = new net.BlockList();
    list.addSubnet(base, Number(prefix), family);
    return list.check(address, family);
  } catch { return false; }
}

function expireIps(data, config, now) {
  const posts = data.threads.flatMap(thread => [thread, ...thread.replies]);
  for (const entry of data.trash) posts.push(entry.post, ...(entry.post.replies || []));
  let removed = 0;
  for (const post of posts) {
    if (post.posterIp && !retainedIp(post, data, config, now)) {
      delete post.posterIp;
      delete post.ipCapturedAt;
      removed += 1;
    }
  }
  for (const ban of data.bans) {
    if (ban.target === 'ip' && (ban.active === false || (ban.expiresAt && ban.expiresAt <= now))) ban.ipNetwork = '';
  }
  return removed;
}

module.exports = { retentionDays, retainedIp, ipNetwork, matchesIp, expireIps };
