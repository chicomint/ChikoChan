'use strict';

const fs = require('node:fs');
const path = require('node:path');

function bannerFilename(value) {
  return typeof value === 'string'
    && /^[a-z0-9][a-z0-9 _.-]{0,199}\.(?:png|jpe?g|gif|webp)$/i.test(value)
    && !value.includes('..') ? value : '';
}

function bannerDirectory(config) {
  return path.join(config.rootDir, 'Banner');
}

// Open the checked file itself, never follow symlinks or accept client paths.
function openBanner(config, filename) {
  if (!bannerFilename(filename)) return null;
  let fd;
  try {
    const directory = bannerDirectory(config);
    if (!fs.lstatSync(directory).isDirectory()) return null;
    const root = fs.realpathSync(directory);
    const target = path.resolve(root, filename);
    if (path.dirname(target) !== root || !fs.lstatSync(target).isFile()) return null;
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const header = Buffer.alloc(Math.min(stat.size, 512 * 1024));
    fs.readSync(fd, header, 0, header.length, 0);
    const info = require('./uploads').inspectImageBuffer(header);
    if (!info || !info.width || !info.height || !info.extensions.includes(path.extname(filename).toLowerCase())) return null;
    const result = { fd, mime: info.mime };
    fd = undefined;
    return result;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function hasBanner(config, filename) {
  const file = openBanner(config, filename);
  if (!file) return false;
  fs.closeSync(file.fd);
  return true;
}

function listBanners(config) {
  try {
    return fs.readdirSync(bannerDirectory(config), { withFileTypes: true })
      .filter(entry => entry.isFile() && hasBanner(config, entry.name))
      .map(entry => entry.name)
      .sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : a < b ? -1 : a > b ? 1 : 0);
  } catch {
    return [];
  }
}

module.exports = { bannerFilename, bannerDirectory, openBanner, hasBanner, listBanners };
