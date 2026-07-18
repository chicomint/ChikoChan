'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');

const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const SAFE_FILENAME = /^[a-z0-9][a-z0-9._-]{0,199}\.(?:jpe?g|png|gif|webp)$/i;

function pngInfo(buffer) {
  const signature = '89504e470d0a1a0a';
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== signature) return null;
  return {
    mime: 'image/png', extensions: ['.png'],
    width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20)
  };
}

function gifInfo(buffer) {
  if (buffer.length < 10 || !['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) return null;
  return {
    mime: 'image/gif', extensions: ['.gif'],
    width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8)
  };
}

function jpegInfo(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  const sizeMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;

  while (offset + 4 <= buffer.length) {
    while (offset < buffer.length && buffer[offset] !== 0xff) offset += 1;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
    if (sizeMarkers.has(marker) && segmentLength >= 7) {
      return {
        mime: 'image/jpeg', extensions: ['.jpg', '.jpeg'],
        height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5)
      };
    }
    offset += segmentLength;
  }

  return { mime: 'image/jpeg', extensions: ['.jpg', '.jpeg'], width: 0, height: 0 };
}

function webpInfo(buffer) {
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    return null;
  }

  const format = buffer.toString('ascii', 12, 16);
  let width = 0;
  let height = 0;
  if (format === 'VP8X' && buffer.length >= 30) {
    width = 1 + buffer.readUIntLE(24, 3);
    height = 1 + buffer.readUIntLE(27, 3);
  } else if (format === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    width = 1 + (bits & 0x3fff);
    height = 1 + ((bits >>> 14) & 0x3fff);
  } else if (format === 'VP8 ' && buffer.length >= 30 && buffer.subarray(23, 26).toString('hex') === '9d012a') {
    width = buffer.readUInt16LE(26) & 0x3fff;
    height = buffer.readUInt16LE(28) & 0x3fff;
  }

  return { mime: 'image/webp', extensions: ['.webp'], width, height };
}

function inspectImageBuffer(buffer) {
  return pngInfo(buffer) || gifInfo(buffer) || jpegInfo(buffer) || webpInfo(buffer);
}

function inspectImageFile(filePath) {
  let descriptor;
  try {
    const size = Math.min(fs.statSync(filePath).size, 512 * 1024);
    const buffer = Buffer.alloc(size);
    descriptor = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(descriptor, buffer, 0, size, 0);
    return inspectImageBuffer(buffer.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function safeOriginalName(value) {
  return path.basename(String(value || 'image'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 180) || 'image';
}

class UploadManager {
  constructor(config) {
    this.config = config;
    this.directory = config.uploadDir;
    fs.mkdirSync(this.directory, { recursive: true });

    const storage = multer.diskStorage({
      destination: (request, file, callback) => callback(null, this.directory),
      filename: (request, file, callback) => {
        const extension = path.extname(file.originalname).toLowerCase();
        const uniqueId = `${Date.now()}${String(crypto.randomInt(0, 1000)).padStart(3, '0')}`;
        callback(null, `${uniqueId}${ALLOWED_EXTENSIONS.has(extension) ? extension : '.img'}`);
      }
    });

    this.middleware = multer({
      storage,
      fileFilter: (request, file, callback) => {
        const extension = path.extname(file.originalname).toLowerCase();
        if (ALLOWED_EXTENSIONS.has(extension)) callback(null, true);
        else callback(new Error('Only JPG, PNG, GIF, and WEBP images are allowed.'), false);
      },
      limits: {
        fileSize: config.limits.maxFileBytes,
        files: 1,
        fields: 16,
        fieldNameSize: 60,
        fieldSize: config.limits.maxCommentLength + 2048,
        parts: 18
      }
    }).fields([{ name: 'image', maxCount: 1 }, { name: 'upfile', maxCount: 1 }]);
  }

  fileFromRequest(request) {
    return request.files?.image?.[0] || request.files?.upfile?.[0] || null;
  }

  validate(file) {
    if (!file) return null;
    const extension = path.extname(file.originalname).toLowerCase();
    const buffer = fs.readFileSync(file.path);
    const image = inspectImageBuffer(buffer);

    if (!image || !image.extensions.includes(extension)) {
      this.removePath(file.path);
      throw new Error('Uploaded file contents do not match its image extension.');
    }

    if (!image.width || !image.height) {
      this.removePath(file.path);
      throw new Error('The uploaded image has invalid or unsupported dimensions.');
    }

    return {
      image: `src/${file.filename}`,
      imageName: safeOriginalName(file.originalname),
      imageBytes: file.size,
      imageMime: image.mime,
      width: image.width,
      height: image.height,
      md5: crypto.createHash('md5').update(buffer).digest('base64'),
      sha256: crypto.createHash('sha256').update(buffer).digest('hex')
    };
  }

  removePath(filePath) {
    if (!filePath) return;
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`Could not remove upload ${filePath}: ${error.message}`);
    }
  }

  pathForPost(post) {
    const relative = String(post?.image || '');
    if (!relative.startsWith('src/')) return null;
    const filename = relative.slice(4);
    if (!SAFE_FILENAME.test(filename) || path.basename(filename) !== filename) return null;
    return path.join(this.directory, filename);
  }

  removePost(post) {
    this.removePath(this.pathForPost(post));
  }

  isSafeFilename(filename) {
    return SAFE_FILENAME.test(String(filename || '')) && path.basename(filename) === filename;
  }

  inspectServedFile(filename) {
    if (!this.isSafeFilename(filename)) return null;
    const filePath = path.join(this.directory, filename);
    const image = inspectImageFile(filePath);
    return image ? { ...image, filePath } : null;
  }
}

module.exports = { UploadManager, inspectImageBuffer, inspectImageFile };
