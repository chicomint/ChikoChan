'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function encodeComponent(value) {
  return encodeURIComponent(String(value || ''))
    .replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodePath(value) {
  return String(value || '').split('/').map(encodeComponent).join('/');
}

function safeKey(value) {
  const key = String(value || '');
  const segments = key.split('/');
  if (!key || key.length > 500 || key.startsWith('/') || key.endsWith('/')
    || segments.some(segment => !segment || segment === '.' || segment === '..')
    || key.includes('\\') || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new Error('Invalid media storage key.');
  }
  return key;
}

function storageError(status = 503) {
  const error = new Error('Object storage could not complete the requested operation.');
  error.status = 503;
  error.storageStatus = Number(status) || 503;
  return error;
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

class LocalStorage {
  constructor(config) {
    this.backend = 'local';
    this.publicDirectory = config.uploadDir;
    this.quarantineDirectory = config.quarantineDir;
  }

  async stageFile(filePath) {
    const relative = path.relative(this.quarantineDirectory, filePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('The staged file is outside private quarantine storage.');
    }
    return relative;
  }

  async promote(sourceKey, destinationKey) {
    const source = path.join(this.quarantineDirectory, safeKey(sourceKey));
    const destination = path.join(this.publicDirectory, safeKey(destinationKey));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (fs.existsSync(destination)) {
      this.remove(source);
      return destinationKey;
    }
    try {
      fs.renameSync(source, destination);
    } catch (error) {
      if (error.code !== 'EXDEV') throw error;
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      fs.unlinkSync(source);
    }
    return destinationKey;
  }

  async hold(sourceKey, destinationKey) {
    const source = path.join(this.publicDirectory, safeKey(sourceKey));
    const destination = path.join(this.quarantineDirectory, safeKey(destinationKey));
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    if (fs.existsSync(destination)) {
      this.remove(source);
      return destinationKey;
    }
    try {
      fs.renameSync(source, destination);
    } catch (error) {
      if (error.code === 'ENOENT' && fs.existsSync(destination)) return destinationKey;
      if (error.code !== 'EXDEV') throw error;
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      fs.unlinkSync(source);
    }
    return destinationKey;
  }

  async deleteQuarantine(key) {
    this.remove(path.join(this.quarantineDirectory, safeKey(key)));
  }

  async deleteApproved(key) {
    this.remove(path.join(this.publicDirectory, safeKey(key)));
  }

  remove(filePath) {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  publicUrl(key) {
    return `/src/${encodeURIComponent(path.basename(safeKey(key)))}`;
  }

  async hasApproved(key) {
    return fs.existsSync(path.join(this.publicDirectory, safeKey(key)));
  }

  async hasQuarantine(key) {
    return fs.existsSync(path.join(this.quarantineDirectory, safeKey(key)));
  }

  async cleanupQuarantine(cutoff) {
    let removed = 0;
    for (const entry of fs.readdirSync(this.quarantineDirectory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const key = safeKey(entry.name);
      const filePath = path.join(this.quarantineDirectory, key);
      try {
        if (fs.statSync(filePath).mtimeMs > cutoff) continue;
        fs.unlinkSync(filePath);
        removed += 1;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return removed;
  }

  async healthCheck() {
    fs.accessSync(this.publicDirectory, fs.constants.R_OK | fs.constants.W_OK);
    fs.accessSync(this.quarantineDirectory, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  }

  async close() {}
}

class ObjectStorage {
  constructor(config, options = {}) {
    this.backend = 'object';
    this.config = config.mediaStorage.object;
    this.fetch = options.fetchImpl || globalThis.fetch;
    if (typeof this.fetch !== 'function') throw new Error('Object storage requires a Fetch-compatible implementation.');
    this.endpoint = new URL(this.config.endpoint);
  }

  objectUrl(bucket, key = '', query = {}) {
    const url = new URL(this.endpoint.toString());
    const encodedKey = key ? `/${encodePath(safeKey(key))}` : '';
    if (this.config.pathStyle) {
      const base = url.pathname.replace(/\/$/, '');
      url.pathname = `${base}/${encodeURIComponent(bucket)}${encodedKey}`;
    } else {
      url.hostname = `${bucket}.${url.hostname}`;
      url.pathname = `${url.pathname.replace(/\/$/, '')}${encodedKey || '/'}`;
    }
    url.search = '';
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));
    return url;
  }

  signingKey(dateStamp) {
    const date = hmac(`AWS4${this.config.secretAccessKey}`, dateStamp);
    const region = hmac(date, this.config.region);
    const service = hmac(region, 's3');
    return hmac(service, 'aws4_request');
  }

  signedHeaders(method, url, headers, payloadHash, now = new Date()) {
    const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = timestamp.slice(0, 8);
    const values = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': timestamp,
      ...Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value).trim()]))
    };
    if (this.config.sessionToken) values['x-amz-security-token'] = this.config.sessionToken;
    const names = Object.keys(values).sort();
    const canonicalHeaders = names.map(name => `${name}:${values[name].replace(/\s+/g, ' ')}`).join('\n');
    const canonicalQuery = [...url.searchParams.entries()]
      .sort(([leftName, leftValue], [rightName, rightValue]) =>
        leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue))
      .map(([name, value]) => `${encodeComponent(name)}=${encodeComponent(value)}`)
      .join('&');
    const canonicalRequest = [
      method.toUpperCase(),
      url.pathname.split('/').map(segment => encodeComponent(decodeURIComponent(segment))).join('/'),
      canonicalQuery,
      `${canonicalHeaders}\n`,
      names.join(';'),
      payloadHash
    ].join('\n');
    const scope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      timestamp,
      scope,
      sha256(canonicalRequest)
    ].join('\n');
    values.authorization = `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${hmac(this.signingKey(dateStamp), stringToSign, 'hex')}`;
    delete values.host;
    return values;
  }

  async request(method, bucket, key = '', options = {}) {
    const body = options.body === undefined ? Buffer.alloc(0) : options.body;
    const payloadHash = sha256(body);
    const url = this.objectUrl(bucket, key, options.query);
    const headers = this.signedHeaders(method, url, options.headers || {}, payloadHash, options.now);
    let response;
    try {
      response = await this.fetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        ...(method === 'GET' || method === 'HEAD' ? {} : { body })
      });
    } catch (error) {
      throw storageError(error?.name === 'TimeoutError' ? 504 : 503);
    }
    if (!response.ok && !(options.allowNotFound && response.status === 404)) {
      throw storageError(response.status);
    }
    return response;
  }

  async stageFile(filePath, key, contentType) {
    const objectKey = safeKey(key);
    await this.request('PUT', this.config.quarantineBucket, objectKey, {
      body: fs.readFileSync(filePath),
      headers: { 'content-type': contentType }
    });
    return objectKey;
  }

  async promote(sourceKey, destinationKey, contentType) {
    const source = safeKey(sourceKey);
    const destination = safeKey(destinationKey);
    const existing = await this.request('HEAD', this.config.publicBucket, destination, { allowNotFound: true });
    if (existing.ok) {
      await this.deleteQuarantine(source);
      return destination;
    }
    await this.request('PUT', this.config.publicBucket, destination, {
      headers: {
        'cache-control': 'public, max-age=31536000, immutable',
        'content-type': contentType,
        'x-amz-copy-source': `/${encodeURIComponent(this.config.quarantineBucket)}/${encodePath(source)}`,
        'x-amz-metadata-directive': 'REPLACE'
      }
    });
    await this.deleteQuarantine(source);
    return destination;
  }

  async hold(sourceKey, destinationKey, contentType) {
    const source = safeKey(sourceKey);
    const destination = safeKey(destinationKey);
    const existing = await this.request('HEAD', this.config.quarantineBucket, destination, { allowNotFound: true });
    if (!existing.ok) {
      await this.request('PUT', this.config.quarantineBucket, destination, {
        headers: {
          'cache-control': 'private, no-store',
          'content-type': contentType,
          'x-amz-copy-source': `/${encodeURIComponent(this.config.publicBucket)}/${encodePath(source)}`,
          'x-amz-metadata-directive': 'REPLACE'
        }
      });
    }
    await this.deleteApproved(source);
    return destination;
  }

  deleteQuarantine(key) {
    return this.request('DELETE', this.config.quarantineBucket, safeKey(key), { allowNotFound: true });
  }

  deleteApproved(key) {
    return this.request('DELETE', this.config.publicBucket, safeKey(key), { allowNotFound: true });
  }

  publicUrl(key) {
    return `${this.config.publicBaseUrl.replace(/\/$/, '')}/${encodePath(safeKey(key))}`;
  }

  async hasApproved(key) {
    const response = await this.request('HEAD', this.config.publicBucket, safeKey(key), { allowNotFound: true });
    return response.ok;
  }

  async hasQuarantine(key) {
    const response = await this.request('HEAD', this.config.quarantineBucket, safeKey(key), { allowNotFound: true });
    return response.ok;
  }

  async cleanupQuarantine(cutoff, maximum = 10000) {
    let continuationToken = '';
    let inspected = 0;
    let removed = 0;
    do {
      const query = {
        'list-type': '2',
        prefix: 'pending/',
        'max-keys': Math.min(1000, maximum - inspected),
        ...(continuationToken ? { 'continuation-token': continuationToken } : {})
      };
      const response = await this.request('GET', this.config.quarantineBucket, '', { query });
      const xml = await response.text();
      if (xml.length > 2 * 1024 * 1024) throw storageError(502);
      const contents = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)];
      for (const match of contents) {
        const keyMatch = match[1].match(/<Key>([\s\S]*?)<\/Key>/);
        const modifiedMatch = match[1].match(/<LastModified>([\s\S]*?)<\/LastModified>/);
        if (!keyMatch || !modifiedMatch) continue;
        const key = decodeXml(keyMatch[1]);
        const modifiedAt = Date.parse(decodeXml(modifiedMatch[1]));
        inspected += 1;
        if (!Number.isFinite(modifiedAt) || modifiedAt > cutoff) continue;
        await this.deleteQuarantine(key);
        removed += 1;
      }
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      const token = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/);
      continuationToken = truncated && token ? decodeXml(token[1]) : '';
    } while (continuationToken && inspected < maximum);
    return removed;
  }

  async healthCheck() {
    const [quarantine, approved] = await Promise.all([
      this.request('HEAD', this.config.quarantineBucket),
      this.request('HEAD', this.config.publicBucket)
    ]);
    return quarantine.ok && approved.ok;
  }

  async close() {}
}

function createMediaStorage(config, options = {}) {
  const storage = options.storageAdapter || (config.mediaStorage.backend === 'object'
    ? new ObjectStorage(config, options)
    : new LocalStorage(config));
  if (!['local', 'object'].includes(storage.backend)) {
    throw new Error('A media storage adapter must declare a local or object backend.');
  }
  for (const method of [
    'stageFile', 'promote', 'hold', 'deleteQuarantine', 'deleteApproved', 'publicUrl',
    'hasApproved', 'hasQuarantine', 'cleanupQuarantine', 'healthCheck', 'close'
  ]) {
    if (typeof storage[method] !== 'function') {
      throw new Error(`The media storage adapter must implement ${method}().`);
    }
  }
  return storage;
}

module.exports = {
  LocalStorage,
  ObjectStorage,
  createMediaStorage,
  decodeXml,
  encodeComponent,
  encodePath,
  safeKey
};
