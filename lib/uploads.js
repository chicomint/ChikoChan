'use strict';

const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const multer = require('multer');
const { BoundedJobQueue, ExternalJobQueue } = require('./jobs');
const { createMediaStorage } = require('./media-storage');

const execFile = promisify(childProcess.execFile);
const VIDEO_EXTENSIONS = new Set(['.webm', '.mp4']);
const MIME_BY_EXTENSION = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.webm', 'video/webm'],
  ['.mp4', 'video/mp4']
]);
const SAFE_FILENAME = /^[a-z0-9][a-z0-9._-]{0,199}\.(?:jpe?g|png|gif|webp|webm|mp4)$/i;
const BINARY_AVAILABILITY = new Map();

function uploadError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

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

function inspectVideoBuffer(buffer) {
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    const boxSize = buffer.readUInt32BE(0);
    if (boxSize >= 8) return { mime: 'video/mp4', extensions: ['.mp4'], kind: 'video' };
  }
  if (buffer.length >= 16 && buffer.subarray(0, 4).toString('hex') === '1a45dfa3') {
    const header = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('latin1').toLowerCase();
    if (header.includes('webm')) return { mime: 'video/webm', extensions: ['.webm'], kind: 'video' };
  }
  return null;
}

function inspectMediaBuffer(buffer) {
  const image = inspectImageBuffer(buffer);
  return image ? { ...image, kind: 'image' } : inspectVideoBuffer(buffer);
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

function inspectMediaFile(filePath) {
  let descriptor;
  try {
    const size = Math.min(fs.statSync(filePath).size, 512 * 1024);
    const buffer = Buffer.alloc(size);
    descriptor = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(descriptor, buffer, 0, size, 0);
    return inspectMediaBuffer(buffer.subarray(0, bytesRead));
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

function parseFrameRate(value) {
  const [numerator, denominator = '1'] = String(value || '').split('/');
  const top = Number(numerator);
  const bottom = Number(denominator);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= 0) return 0;
  return top / bottom;
}

function validateVideoProbe(probe, extension, limits) {
  if (!probe || typeof probe !== 'object' || !Array.isArray(probe.streams)) {
    throw uploadError('The uploaded video has invalid metadata.');
  }
  const formatNames = String(probe.format?.format_name || '').split(',');
  const allowedFormats = extension === '.webm'
    ? new Set(['matroska', 'webm'])
    : new Set(['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2']);
  if (!formatNames.some(name => allowedFormats.has(name))) {
    throw uploadError('The uploaded video container does not match its extension.');
  }

  const videos = probe.streams.filter(stream => stream.codec_type === 'video');
  const audios = probe.streams.filter(stream => stream.codec_type === 'audio');
  const unexpected = probe.streams.filter(stream => !['video', 'audio'].includes(stream.codec_type));
  if (videos.length !== 1 || audios.length > 1 || unexpected.length) {
    throw uploadError('Videos must contain one video stream and at most one audio stream.');
  }

  const video = videos[0];
  const allowedVideoCodecs = extension === '.webm' ? new Set(['vp8', 'vp9']) : new Set(['h264']);
  const allowedAudioCodecs = extension === '.webm' ? new Set(['opus', 'vorbis']) : new Set(['aac']);
  if (!allowedVideoCodecs.has(String(video.codec_name || '').toLowerCase())) {
    throw uploadError(`The ${extension.slice(1).toUpperCase()} video codec is not browser-compatible.`);
  }
  if (audios.length && !allowedAudioCodecs.has(String(audios[0].codec_name || '').toLowerCase())) {
    throw uploadError(`The ${extension.slice(1).toUpperCase()} audio codec is not browser-compatible.`);
  }

  const width = Number(video.width) || 0;
  const height = Number(video.height) || 0;
  const duration = Number(probe.format?.duration || video.duration) || 0;
  const frameRate = parseFrameRate(video.avg_frame_rate || video.r_frame_rate);
  if (!width || !height || width > limits.maxVideoDimension || height > limits.maxVideoDimension
    || width * height > limits.maxVideoPixels) {
    throw uploadError('The uploaded video dimensions exceed the configured safety limits.');
  }
  if (!duration || duration * 1000 > limits.maxVideoDurationMs) {
    throw uploadError('The uploaded video duration exceeds the configured limit.');
  }
  if (!frameRate || frameRate > limits.maxVideoFrameRate) {
    throw uploadError('The uploaded video frame rate exceeds the configured limit.');
  }

  return {
    width,
    height,
    durationMs: Math.ceil(duration * 1000),
    frameRate: Number(frameRate.toFixed(3)),
    videoCodec: String(video.codec_name || '').toLowerCase(),
    audioCodec: audios.length ? String(audios[0].codec_name || '').toLowerCase() : ''
  };
}

function binaryAvailable(command) {
  if (BINARY_AVAILABILITY.has(command)) return BINARY_AVAILABILITY.get(command);
  try {
    const result = childProcess.spawnSync(command, ['-version'], {
      shell: false,
      stdio: 'ignore',
      timeout: 2000,
      windowsHide: true
    });
    const available = !result.error && result.status === 0;
    BINARY_AVAILABILITY.set(command, available);
    return available;
  } catch {
    BINARY_AVAILABILITY.set(command, false);
    return false;
  }
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const md5 = crypto.createHash('md5');
    const sha256 = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => {
      md5.update(chunk);
      sha256.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve({
      md5: md5.digest('base64'),
      sha256: sha256.digest('hex')
    }));
  });
}

class UploadManager {
  constructor(config, options = {}) {
    this.config = config;
    this.logger = options.logger || console;
    this.directory = config.uploadDir;
    this.quarantineDirectory = config.quarantineDir;
    fs.mkdirSync(this.directory, { recursive: true });
    fs.mkdirSync(this.quarantineDirectory, { recursive: true, mode: 0o700 });
    const relativeQuarantine = path.relative(this.directory, this.quarantineDirectory);
    if (!relativeQuarantine || (!relativeQuarantine.startsWith('..') && !path.isAbsolute(relativeQuarantine))) {
      throw new Error('The media quarantine directory must not be inside the public upload directory.');
    }
    this.ffprobeAvailable = binaryAvailable(config.media.ffprobePath);
    this.ffmpegAvailable = binaryAvailable(config.media.ffmpegPath);
    if (config.media.stripMetadataRequired && !this.ffmpegAvailable) {
      throw new Error('Metadata stripping is required, but FFmpeg is unavailable.');
    }
    this.videoAvailable = Boolean(config.features.videoUploads && this.ffprobeAvailable && this.ffmpegAvailable);
    this.jobQueue = config.mediaWorker.mode === 'external'
      ? new ExternalJobQueue(options.mediaJobQueue)
      : (options.mediaJobQueue || new BoundedJobQueue(config.mediaWorker));
    this.storage = createMediaStorage(config, {
      storageAdapter: options.storageAdapter,
      fetchImpl: options.storageFetch
    });
    config.media.videoAvailable = this.videoAvailable;
    config.media.thumbnailAvailable = this.ffmpegAvailable;
    config.media.metadataStripAvailable = this.ffmpegAvailable;

    const storage = multer.diskStorage({
      destination: (request, file, callback) => callback(null, this.quarantineDirectory),
      filename: (request, file, callback) => callback(null, `${crypto.randomUUID()}.upload`)
    });

    const parseMultipart = multer({
      storage,
      fileFilter: (request, file, callback) => {
        const extension = path.extname(file.originalname).toLowerCase();
        const expectedMime = MIME_BY_EXTENSION.get(extension);
        if (!expectedMime || (VIDEO_EXTENSIONS.has(extension) && !this.videoAvailable)) {
          callback(uploadError(this.videoAvailable
            ? 'Only JPG, PNG, GIF, WEBP, WEBM, and MP4 files are allowed.'
            : 'Only JPG, PNG, GIF, and WEBP images are allowed.'), false);
          return;
        }
        if (String(file.mimetype || '').toLowerCase() !== expectedMime) {
          callback(uploadError('The upload MIME type does not match its filename extension.'), false);
          return;
        }
        callback(null, true);
      },
      limits: {
        fileSize: Math.max(config.limits.maxFileBytes, config.limits.maxVideoBytes),
        files: 4,
        fields: 16,
        fieldNameSize: 60,
        fieldSize: config.limits.maxCommentLength + 2048,
        parts: 22
      }
    }).fields([{ name: 'image', maxCount: 1 }, { name: 'upfile', maxCount: 4 }]);
    this.middleware = (request, response, next) => {
      const contentLength = Number(request.get?.('content-length') || request.headers?.['content-length']);
      if (Number.isFinite(contentLength) && contentLength > this.config.limits.maxRequestBytes) {
        const error = uploadError(`Upload requests are limited to ${this.config.limits.maxRequestBytes} bytes.`);
        error.status = 413;
        next(error);
        return;
      }
      parseMultipart(request, response, error => {
        if (error) {
          for (const file of this.filesFromRequest(request)) this.removePath(file?.path);
        }
        next(error);
      });
    };
  }

  fileFromRequest(request) {
    return this.filesFromRequest(request)[0] || null;
  }

  filesFromRequest(request) {
    return [
      ...(request.files?.image || []),
      ...(request.files?.upfile || [])
    ].slice(0, 4);
  }

  runProcessor(operation, type = 'media-process', payload = {}) {
    return this.jobQueue.submit(type, payload, operation, {
      timeoutMs: this.config.mediaWorker.timeoutMs,
      retryLimit: this.config.mediaWorker.retryLimit
    });
  }

  async probeVideo(filePath, extension) {
    const { stdout } = await this.runProcessor(() => execFile(this.config.media.ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=format_name,duration:stream=codec_type,codec_name,width,height,duration,r_frame_rate,avg_frame_rate',
      '-of', 'json',
      filePath
    ], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024,
      shell: false,
      timeout: this.config.media.processTimeoutMs,
      windowsHide: true
    }), 'video-probe', { filePath, extension });
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw uploadError('The uploaded video metadata could not be read safely.');
    }
    return validateVideoProbe(parsed, extension, {
      maxVideoDimension: this.config.limits.maxVideoDimension,
      maxVideoPixels: this.config.limits.maxVideoPixels,
      maxVideoDurationMs: this.config.limits.maxVideoDurationSeconds * 1000,
      maxVideoFrameRate: this.config.limits.maxVideoFrameRate
    });
  }

  async generateThumbnail(filePath, filename) {
    if (!this.ffmpegAvailable) return null;
    const basename = path.basename(filename, path.extname(filename));
    const finalPath = path.join(this.quarantineDirectory, `thumb-${basename}-${crypto.randomUUID()}.jpg`);
    const temporaryPath = `${finalPath}.tmp.jpg`;
    try {
      await this.runProcessor(() => execFile(this.config.media.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-i', filePath,
        '-frames:v', '1', '-an', '-sn', '-dn', '-map_metadata', '-1',
        '-vf', `scale=${this.config.media.thumbnailMaxWidth}:${this.config.media.thumbnailMaxHeight}:force_original_aspect_ratio=decrease`,
        '-threads', '1', '-q:v', '4',
        temporaryPath
      ], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024,
        shell: false,
        timeout: this.config.media.processTimeoutMs,
        windowsHide: true
      }), 'thumbnail', { filePath, outputPath: temporaryPath });
      const info = inspectImageFile(temporaryPath);
      const bytes = fs.statSync(temporaryPath).size;
      if (!info?.width || !info.height || bytes > this.config.media.maxThumbnailBytes) {
        throw uploadError('Generated thumbnail failed validation.');
      }
      fs.renameSync(temporaryPath, finalPath);
      return {
        thumbnail: '',
        thumbnailWidth: info.width,
        thumbnailHeight: info.height,
        thumbnailPath: finalPath
      };
    } catch (error) {
      this.removePath(temporaryPath);
      this.removePath(finalPath);
      throw error;
    }
  }

  async stripImageMetadata(filePath, extension) {
    if (!this.config.media.stripMetadata) return false;
    if (!this.ffmpegAvailable) {
      if (this.config.media.stripMetadataRequired) {
        throw uploadError('Image metadata could not be stripped on this server.');
      }
      return false;
    }

    const temporaryPath = path.join(this.quarantineDirectory, `${crypto.randomUUID()}${extension}`);
    try {
      const qualityArguments = ['.jpg', '.jpeg', '.webp'].includes(extension) ? ['-q:v', '3'] : [];
      await this.runProcessor(() => execFile(this.config.media.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-i', filePath,
        '-map', '0:v:0', '-map_metadata', '-1', '-map_chapters', '-1',
        '-threads', '1',
        ...qualityArguments,
        temporaryPath
      ], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024,
        shell: false,
        timeout: this.config.media.processTimeoutMs,
        windowsHide: true
      }), 'strip-image-metadata', { filePath, outputPath: temporaryPath, extension });
      const info = inspectImageFile(temporaryPath);
      const bytes = fs.statSync(temporaryPath).size;
      if (!info?.width || !info.height || !info.extensions.includes(extension)
        || bytes < 1 || bytes > this.config.limits.maxFileBytes
        || info.width > this.config.limits.maxImageDimension
        || info.height > this.config.limits.maxImageDimension
        || info.width * info.height > this.config.limits.maxImagePixels) {
        throw uploadError('Metadata-stripped image failed safety validation.');
      }
      fs.renameSync(temporaryPath, filePath);
      return true;
    } catch (error) {
      this.removePath(temporaryPath);
      if (this.config.media.stripMetadataRequired) throw error;
      return false;
    }
  }

  async stripVideoMetadata(filePath, extension) {
    if (!this.config.media.stripMetadata) return false;
    if (!this.ffmpegAvailable) {
      if (this.config.media.stripMetadataRequired) {
        throw uploadError('Video metadata could not be stripped on this server.');
      }
      return false;
    }

    const temporaryPath = path.join(this.quarantineDirectory, `${crypto.randomUUID()}${extension}`);
    try {
      await this.runProcessor(() => execFile(this.config.media.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-i', filePath,
        '-map', '0:v:0', '-map', '0:a:0?',
        '-map_metadata', '-1', '-map_chapters', '-1',
        '-c', 'copy',
        temporaryPath
      ], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024,
        shell: false,
        timeout: this.config.media.processTimeoutMs,
        windowsHide: true
      }), 'strip-video-metadata', { filePath, outputPath: temporaryPath, extension });
      const bytes = fs.statSync(temporaryPath).size;
      if (bytes < 1 || bytes > this.config.limits.maxVideoBytes) {
        throw uploadError('Metadata-stripped video failed safety validation.');
      }
      fs.renameSync(temporaryPath, filePath);
      return true;
    } catch (error) {
      this.removePath(temporaryPath);
      if (this.config.media.stripMetadataRequired) throw error;
      return false;
    }
  }

  async validate(file) {
    if (!file) return null;
    const extension = path.extname(file.originalname).toLowerCase();
    const expectedMime = MIME_BY_EXTENSION.get(extension);
    const inspected = inspectMediaFile(file.path);
    let thumbnail = null;

    if (!inspected || !inspected.extensions.includes(extension) || inspected.mime !== expectedMime) {
      this.removePath(file.path);
      throw uploadError('Uploaded file contents do not match its extension and MIME type.');
    }
    if (String(file.mimetype || '').toLowerCase() !== expectedMime) {
      this.removePath(file.path);
      throw uploadError('The upload MIME type does not match its verified contents.');
    }

    try {
      const sourceHashes = await hashFile(file.path);
      let metadata;
      if (inspected.kind === 'image') {
        if (file.size > this.config.limits.maxFileBytes) {
          throw uploadError(`Images are limited to ${this.config.limits.maxFileBytes} bytes.`);
        }
        if (!inspected.width || !inspected.height
          || inspected.width > this.config.limits.maxImageDimension
          || inspected.height > this.config.limits.maxImageDimension
          || inspected.width * inspected.height > this.config.limits.maxImagePixels) {
          throw uploadError('The uploaded image dimensions exceed the configured safety limits.');
        }
        const metadataStripped = await this.stripImageMetadata(file.path, extension);
        const publicImage = inspectImageFile(file.path);
        if (!publicImage?.width || !publicImage.height) {
          throw uploadError('The processed image could not be validated.');
        }
        file.size = fs.statSync(file.path).size;
        metadata = {
          width: publicImage.width,
          height: publicImage.height,
          metadataStripped
        };
        const needsThumbnail = publicImage.width > this.config.media.thumbnailMaxWidth
          || publicImage.height > this.config.media.thumbnailMaxHeight
          || file.size > this.config.media.thumbnailThresholdBytes;
        if (needsThumbnail && this.ffmpegAvailable) {
          try {
            thumbnail = await this.generateThumbnail(file.path, file.filename);
          } catch {
            thumbnail = null;
          }
        }
      } else {
        if (!this.videoAvailable) throw uploadError('Video uploads are unavailable on this server.');
        if (file.size > this.config.limits.maxVideoBytes) {
          throw uploadError(`Videos are limited to ${this.config.limits.maxVideoBytes} bytes.`);
        }
        metadata = await this.probeVideo(file.path, extension);
        const metadataStripped = await this.stripVideoMetadata(file.path, extension);
        if (metadataStripped) {
          file.size = fs.statSync(file.path).size;
          metadata = await this.probeVideo(file.path, extension);
        }
        metadata.metadataStripped = metadataStripped;
        thumbnail = await this.generateThumbnail(file.path, file.filename);
        if (!thumbnail) throw uploadError('A safe video poster could not be generated.');
      }

      const hashes = await hashFile(file.path);
      const fields = {
        image: '',
        imageName: safeOriginalName(file.originalname),
        imageBytes: file.size,
        imageMime: inspected.mime,
        mediaKind: inspected.kind,
        ...metadata,
        ...(thumbnail ? {
          thumbnail: thumbnail.thumbnail,
          thumbnailWidth: thumbnail.thumbnailWidth,
          thumbnailHeight: thumbnail.thumbnailHeight
        } : {}),
        ...hashes
      };
      const candidate = {
        ...fields,
        _asset: {
          id: sourceHashes.sha256,
          kind: inspected.kind,
          path: '',
          mime: inspected.mime,
          extension,
          bytes: file.size,
          width: metadata.width,
          height: metadata.height,
          durationMs: metadata.durationMs || 0,
          frameRate: metadata.frameRate || 0,
          videoCodec: metadata.videoCodec || '',
          audioCodec: metadata.audioCodec || '',
          thumbnail: '',
          thumbnailWidth: thumbnail?.thumbnailWidth || 0,
          thumbnailHeight: thumbnail?.thumbnailHeight || 0,
          md5: hashes.md5,
          sha256: sourceHashes.sha256,
          contentSha256: hashes.sha256,
          sourceSha256: sourceHashes.sha256,
          metadataStripped: Boolean(metadata.metadataStripped),
          state: 'scanning',
          createdAt: Date.now(),
          refCount: 0
        },
        sha256: sourceHashes.sha256,
        contentSha256: hashes.sha256,
        _quarantine: {
          id: path.basename(file.filename),
          filePath: file.path,
          thumbnailPath: thumbnail?.thumbnailPath || '',
          extension
        },
        _paths: [file.path, thumbnail?.thumbnailPath].filter(Boolean)
      };
      await this.stageCandidate(candidate);
      return candidate;
    } catch (error) {
      this.removePath(file.path);
      if (thumbnail?.thumbnailPath) this.removePath(thumbnail.thumbnailPath);
      if (Number(error?.status) >= 400 && Number(error?.status) < 500) throw error;
      const safeError = uploadError('Uploaded media processing failed safely.');
      safeError.cause = error;
      throw safeError;
    }
  }

  async stageCandidate(candidate) {
    const quarantine = candidate?._quarantine;
    if (!candidate?._asset || !quarantine?.filePath) throw new Error('Invalid media candidate.');
    const prefix = `pending/${Date.now()}-${crypto.randomUUID()}`;
    let sourceKey = '';
    let thumbnailKey = '';
    try {
      sourceKey = await this.storage.stageFile(
        quarantine.filePath,
        `${prefix}${quarantine.extension}`,
        candidate._asset.mime
      );
      if (quarantine.thumbnailPath) {
        thumbnailKey = await this.storage.stageFile(
          quarantine.thumbnailPath,
          `${prefix}-thumbnail.jpg`,
          'image/jpeg'
        );
      }
      quarantine.sourceKey = sourceKey;
      quarantine.thumbnailKey = thumbnailKey;
      quarantine.stagedAt = Date.now();
      if (this.storage.backend === 'object') {
        this.removePath(quarantine.filePath);
        this.removePath(quarantine.thumbnailPath);
        candidate._paths = [];
      }
    } catch (error) {
      if (thumbnailKey) await this.storage.deleteQuarantine(thumbnailKey).catch(() => {});
      if (sourceKey) await this.storage.deleteQuarantine(sourceKey).catch(() => {});
      throw error;
    }
  }

  async approveCandidate(candidate) {
    if (!candidate?._asset || !candidate?._quarantine?.sourceKey) {
      throw new Error('Invalid quarantined media candidate.');
    }
    if (candidate._asset.state !== 'scanning' && candidate._asset.state !== 'pending') {
      throw new Error('Only pending or scanning media can be approved.');
    }
    const stem = `${candidate._asset.contentSha256.slice(0, 24)}-${crypto.randomUUID()}`;
    const filename = `${stem}${candidate._quarantine.extension}`;
    let approvedSourceKey = '';
    let approvedThumbnailKey = '';
    let thumbnail = '';
    try {
      approvedSourceKey = await this.storage.promote(
        candidate._quarantine.sourceKey,
        filename,
        candidate._asset.mime
      );
      if (candidate._quarantine.thumbnailKey) {
        approvedThumbnailKey = await this.storage.promote(
          candidate._quarantine.thumbnailKey,
          `thumb-${stem}.jpg`,
          'image/jpeg'
        );
        thumbnail = `src/${approvedThumbnailKey}`;
      }
    } catch (error) {
      if (approvedThumbnailKey) await this.storage.deleteApproved(approvedThumbnailKey).catch(() => {});
      if (approvedSourceKey) await this.storage.deleteApproved(approvedSourceKey).catch(() => {});
      throw error;
    }

    const mediaPath = `src/${approvedSourceKey}`;
    candidate.image = mediaPath;
    candidate.thumbnail = thumbnail;
    candidate._asset.path = mediaPath;
    candidate._asset.thumbnail = thumbnail;
    candidate._asset.state = 'approved';
    candidate._asset.approvedAt = Date.now();
    candidate._quarantine.approvedSourceKey = approvedSourceKey;
    candidate._quarantine.approvedThumbnailKey = approvedThumbnailKey;
    candidate._paths = this.storage.backend === 'local'
      ? [path.join(this.directory, approvedSourceKey), approvedThumbnailKey
        ? path.join(this.directory, approvedThumbnailKey)
        : ''].filter(Boolean)
      : [];
    return candidate;
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
    if (this.storage.backend !== 'local') return null;
    const relative = String(post?.image || '');
    if (!relative.startsWith('src/')) return null;
    const filename = relative.slice(4);
    if (!SAFE_FILENAME.test(filename) || path.basename(filename) !== filename) return null;
    return path.join(this.directory, filename);
  }

  pathForRelative(relativePath) {
    if (this.storage.backend !== 'local') return null;
    const relative = String(relativePath || '');
    if (!relative.startsWith('src/')) return null;
    const filename = relative.slice(4);
    if (!this.isSafeFilename(filename)) return null;
    return path.join(this.directory, filename);
  }

  async removePost(post) {
    const keys = [post?.image, post?.thumbnail]
      .map(relative => this.keyForRelative(relative))
      .filter(Boolean);
    await Promise.all(keys.map(key => this.storage.deleteApproved(key)));
  }

  planHold(asset) {
    const sourceKey = this.keyForRelative(asset?.path);
    const thumbnailKey = this.keyForRelative(asset?.thumbnail);
    if (!sourceKey && !thumbnailKey) return null;
    const identity = String(asset?.id || asset?.sha256 || sourceKey || thumbnailKey);
    const prefix = `held/${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
    return {
      sourceKey,
      thumbnailKey,
      quarantineSourceKey: sourceKey ? `${prefix}/${sourceKey}` : '',
      quarantineThumbnailKey: thumbnailKey ? `${prefix}/${thumbnailKey}` : '',
      originalPath: sourceKey ? `src/${sourceKey}` : '',
      originalThumbnail: thumbnailKey ? `src/${thumbnailKey}` : ''
    };
  }

  async holdAsset(asset) {
    const hold = asset?.hold;
    if (!hold) return false;
    if (hold.sourceKey && hold.quarantineSourceKey) {
      await this.storage.hold(hold.sourceKey, hold.quarantineSourceKey, asset.mime || 'application/octet-stream');
    }
    if (hold.thumbnailKey && hold.quarantineThumbnailKey) {
      await this.storage.hold(hold.thumbnailKey, hold.quarantineThumbnailKey, 'image/jpeg');
    }
    return true;
  }

  async restoreHeldAsset(asset) {
    const hold = asset?.hold;
    if (!hold) return false;
    if (hold.quarantineSourceKey && hold.sourceKey) {
      await this.storage.promote(hold.quarantineSourceKey, hold.sourceKey, asset.mime || 'application/octet-stream');
    }
    if (hold.quarantineThumbnailKey && hold.thumbnailKey) {
      await this.storage.promote(hold.quarantineThumbnailKey, hold.thumbnailKey, 'image/jpeg');
    }
    return true;
  }

  async removeAsset(asset) {
    const approvedKeys = [
      asset?.path,
      asset?.thumbnail,
      asset?.hold?.originalPath,
      asset?.hold?.originalThumbnail
    ]
      .map(relative => this.keyForRelative(relative))
      .filter(Boolean);
    const quarantineKeys = [
      asset?.hold?.quarantineSourceKey,
      asset?.hold?.quarantineThumbnailKey
    ].filter(Boolean);
    await Promise.all([
      ...new Set(approvedKeys).values()].map(key => this.storage.deleteApproved(key)));
    await Promise.all([...new Set(quarantineKeys).values()].map(key => this.storage.deleteQuarantine(key)));
  }

  async removeCandidate(upload) {
    const quarantine = upload?._quarantine || {};
    const quarantineKeys = [quarantine.sourceKey, quarantine.thumbnailKey].filter(Boolean);
    const approvedKeys = [quarantine.approvedSourceKey, quarantine.approvedThumbnailKey].filter(Boolean);
    const cleanup = await Promise.allSettled([
      ...quarantineKeys.map(key => this.storage.deleteQuarantine(key)),
      ...approvedKeys.map(key => this.storage.deleteApproved(key))
    ]);
    if (cleanup.some(result => result.status === 'rejected')) {
      this.logger.error('A media candidate cleanup operation failed; storage reconciliation is required.');
    }
    for (const filePath of upload?._paths || []) this.removePath(filePath);
    this.removePath(quarantine.filePath);
    this.removePath(quarantine.thumbnailPath);
  }

  async cleanupQuarantine(now = Date.now(), retentionMs = 24 * 60 * 60 * 1000) {
    const cutoff = Number(now) - Math.max(60 * 60 * 1000, Number(retentionMs) || 0);
    return this.storage.cleanupQuarantine(cutoff);
  }

  async close() {
    await this.jobQueue.close();
    await this.storage.close();
  }

  async healthCheck() {
    return Boolean(await this.jobQueue.healthCheck()) && Boolean(await this.storage.healthCheck());
  }

  workerStatus() {
    return this.jobQueue.status();
  }

  isSafeFilename(filename) {
    return SAFE_FILENAME.test(String(filename || '')) && path.basename(filename) === filename;
  }

  inspectServedFile(filename) {
    if (this.storage.backend !== 'local') return null;
    if (!this.isSafeFilename(filename)) return null;
    const filePath = path.join(this.directory, filename);
    const media = inspectMediaFile(filePath);
    const extension = path.extname(filename).toLowerCase();
    return media && media.extensions.includes(extension) ? { ...media, filePath } : null;
  }

  keyForRelative(relativePath) {
    const relative = String(relativePath || '');
    if (!relative.startsWith('src/')) return '';
    const filename = relative.slice(4);
    return this.isSafeFilename(filename) ? filename : '';
  }

  delivery(filename) {
    if (!this.isSafeFilename(filename)) return null;
    if (this.storage.backend === 'object') {
      return { kind: 'redirect', url: this.storage.publicUrl(filename) };
    }
    const media = this.inspectServedFile(filename);
    return media ? { kind: 'file', ...media } : null;
  }

  canReference(relativePath) {
    const key = this.keyForRelative(relativePath);
    if (!key) return false;
    return this.storage.backend === 'object' || Boolean(this.inspectServedFile(key));
  }

  async verifyStoredRelative(relativePath) {
    const key = this.keyForRelative(relativePath);
    if (!key || !await this.storage.hasApproved(key)) return false;
    return this.storage.backend === 'object' || Boolean(this.inspectServedFile(key));
  }

  storageStatus() {
    return { backend: this.storage.backend };
  }
}

module.exports = {
  UploadManager,
  inspectImageBuffer,
  inspectImageFile,
  inspectMediaBuffer,
  inspectMediaFile,
  inspectVideoBuffer,
  parseFrameRate,
  validateVideoProbe
};
