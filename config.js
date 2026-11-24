'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseEncryptionKey } = require('./lib/mfa');

const ROOT_DIR = __dirname;
const ENV_FILE = path.join(ROOT_DIR, '.env');

const DEFAULTS = {
  host: '0.0.0.0',
  adminPassword: '',
  adminSessionSecret: '',
  port: 3000,
  storage: 'mongodb',
  mongoUrl: '',
  mongoDbName: '',
  mongo: {
    requireTransactions: false
  },
  dataDir: '.',
  trustProxy: false,
  deployment: {
    environment: 'development',
    publicOrigin: '',
    instanceId: '',
    multiInstance: false
  },
  security: {
    hsts: {
      enabled: false,
      maxAgeSeconds: 15552000,
      includeSubDomains: true,
      preload: false
    }
  },
  staffMfa: {
    enabled: false,
    issuer: 'ChikoChan',
    encryptionKey: ''
  },
  postingAuthorization: {
    enabled: false,
    secret: '',
    ttlMs: 2 * 60 * 1000
  },
  mediaSafety: {
    knownIllegalProvider: 'none',
    gatewayUrl: '',
    gatewayToken: '',
    timeoutMs: 15000,
    failClosed: false,
    retainProviderResults: true
  },
  rateLimit: {
    backend: 'memory',
    redisUrl: '',
    prefix: 'chikochan',
    operations: {
      threadCreate: { windowMs: 10 * 60 * 1000, limit: 60 },
      replyCreate: { windowMs: 60 * 1000, limit: 120 },
      mediaPost: { windowMs: 10 * 60 * 1000, limit: 120 },
      reportCreate: { windowMs: 10 * 60 * 1000, limit: 60 },
      deletePassword: { windowMs: 15 * 60 * 1000, limit: 120 },
      adminLogin: { windowMs: 15 * 60 * 1000, limit: 8 },
      captchaAuthorization: { windowMs: 10 * 60 * 1000, limit: 120 },
      boardCreate: { windowMs: 60 * 60 * 1000, limit: 10 },
      apiMutation: { windowMs: 60 * 1000, limit: 20 },
      expensiveRead: { windowMs: 60 * 1000, limit: 180 },
      editorPreview: { windowMs: 60 * 1000, limit: 180 }
    }
  },
  anonymousName: 'Anonymous',
  site: {
    title: 'ChikoChan',
    pageDirectory: 'page',
    description:
    'Welcome to ChikoChan!\n\n' +
    'This little imageboard is a place to share whatever is on your mind — cute pictures, random thoughts, memes, art, games, hobbies, and more.\n\n' +
    'Some boards have specific categories, so please make sure your posts fit the board and follow the rules: https://boards.chiko.cc/rules\n\n' +
    'Feel free to stay and have fun! ^-^',
    announcement: ''
  },
  limits: {
    maxRequestBytes: 101 * 1024 * 1024,
    maxFileBytes: 5 * 1024 * 1024,
    maxVideoBytes: 25 * 1024 * 1024,
    maxFilesPerPost: 1,
    maxImageDimension: 16384,
    maxImagePixels: 40 * 1024 * 1024,
    maxVideoDimension: 4096,
    maxVideoPixels: 16 * 1024 * 1024,
    maxVideoDurationSeconds: 300,
    maxVideoFrameRate: 120,
    maxNameLength: 80,
    maxSubjectLength: 120,
    maxCommentLength: 4000,
    maxCommentLines: 100,
    maxLinks: 20,
    maxCites: 45,
    maxBoardRules: 20,
    maxBoardRuleLength: 512,
    maxStaffAccounts: 100,
    maxThreads: 100,
    threadsPerPage: 10,
    catalogThreadsPerPage: 100,
    adminPageSize: 50,
    previewReplies: 3,
    bumpLimit: 250,
    replyLimit: 500,
    postRateWindowMs: 60 * 1000,
    postRateLimit: 5,
    reportRateWindowMs: 10 * 60 * 1000,
    reportRateLimit: 5,
    deleteDelaySeconds: 0
  },
  features: {
    requireImageForThread: true,
    userDeletion: true,
    reports: true,
    tripcodes: true,
    spoilerImages: true,
    rejectDuplicateImages: false,
    search: true,
    rss: true,
    api: true,
    fortunes: true,
    videoUploads: true
  },
  media: {
    ffprobePath: 'ffprobe',
    ffmpegPath: 'ffmpeg',
    stripMetadata: true,
    stripMetadataRequired: false,
    processTimeoutMs: 15 * 1000,
    thumbnailMaxWidth: 320,
    thumbnailMaxHeight: 320,
    thumbnailThresholdBytes: 512 * 1024,
    maxThumbnailBytes: 2 * 1024 * 1024
  },
  mediaWorker: {
    mode: 'local',
    concurrency: 2,
    timeoutMs: 20 * 1000,
    retryLimit: 1,
    maxQueue: 100,
    expectedMemoryMb: 256
  },
  mediaStorage: {
    backend: 'local',
    object: {
      endpoint: '',
      region: 'us-east-1',
      quarantineBucket: '',
      publicBucket: '',
      publicBaseUrl: '',
      cachePurgeUrl: '',
      cachePurgeToken: '',
      pathStyle: true,
      requestTimeoutMs: 10 * 1000,
      accessKeyId: '',
      secretAccessKey: '',
      sessionToken: ''
    }
  },
  lifecycle: {
    staffTrashRetentionDays: 14,
    quarantineRetentionHours: 24,
    maxRevisionsPerPost: 20
  },
  antiAbuse: { nativeCaptcha: { enabled: false } },
  maintenance: {
    enabled: true,
    startupDelayMs: 30 * 1000,
    intervalMs: 15 * 60 * 1000,
    leaseMs: 10 * 60 * 1000
  },
  extensions: {
    hookTimeoutMs: 1000
  },
  i18n: {
    defaultLanguage: 'en'
  },
  reports: {
    defaultCategory: 'other',
    categories: [
      { id: 'spam', label: 'Spam or flooding' },
      { id: 'off-topic', label: 'Off-topic content' },
      { id: 'harassment', label: 'Harassment or personal information' },
      { id: 'illegal', label: 'Illegal content' },
      { id: 'other', label: 'Other rule violation' }
    ]
  },
  fortunes: [
    'not really.',
    'Stay home. Just... stay home.',
    'Good Way is... kill your self (^///^)',
    'Good luck.',
    'You are Fucked',
    'Excellent Luck',
    'Very Bad Luck',
    'Bad Luck',
    'Better not tell you now',
    'Chicken is watching you. Be careful.',
    'Reply hazy, try again',
    'Average Luck',
    'Outlook good',
    'Godly Luck',
    'Good news will come to you by mail',
    'pls stop. Im tried',
    'play osu.',
    'Can i not telling you??',
    '(≧∀≦)ゞ',
    'Dont play osu.',
  ],
  wordFilters: []
};

function isPlainObject(value) {
  return Boolean(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function mergeConfig(base, override) {
  const merged = Object.fromEntries(Object.entries(base).map(([key, value]) => [
    key, isPlainObject(value) ? mergeConfig(value, {}) : Array.isArray(value) ? structuredClone(value) : value
  ]));

  for (const [key, value] of Object.entries(override || {})) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid configuration key.');
    if (isPlainObject(value) && isPlainObject(base[key])) {
      merged[key] = mergeConfig(base[key], value);
    } else {
      merged[key] = value;
    }
  }

  return merged;
}

// Optional bundled media binaries (ffmpeg-static / ffprobe-static) keep video
// uploads working on hosts such as Railway where system FFmpeg is not installed.
function bundledMediaBinary(packageName, pick) {
  try {
    const exported = require(packageName);
    const resolved = pick ? exported && exported.path : exported;
    return typeof resolved === 'string' && resolved && fs.existsSync(resolved) ? resolved : '';
  } catch {
    return '';
  }
}

function loadPages(pagesDir) {
  const pages = {};
  const filenames = new Set(['about.txt', 'contact.txt', 'news.txt', 'rule.txt', ...(fs.existsSync(pagesDir) ? fs.readdirSync(pagesDir) : [])]);
  for (const filename of [...filenames].sort()) {
    if (!filename.endsWith('.txt')) continue;
    const key = filename.slice(0, -4);
    const routeKey = key === 'rule' ? 'rules' : key;
    const title = routeKey.charAt(0).toUpperCase() + routeKey.slice(1);
    const content = ''; // Read the source on each request so edits appear immediately.
    pages[routeKey] = { title, content, sourcePath: path.join(pagesDir, filename) };
  }
  return pages;
}

function validateStartupConfig(config) {
  if (!['mongodb', 'json'].includes(config.storage)) {
    throw new Error('storage must be either "mongodb" or "json".');
  }
  if (!['development', 'test', 'production'].includes(config.deployment.environment)) {
    throw new Error('deployment.environment must be development, test, or production.');
  }
  if (typeof config.deployment.publicOrigin !== 'string'
    || (config.deployment.publicOrigin && !/^https?:\/\/[^\s/]+(?::\d+)?$/i.test(config.deployment.publicOrigin))) {
    throw new Error('deployment.publicOrigin must be an http(s) origin without a path.');
  }
  if (typeof config.deployment.instanceId !== 'string' || config.deployment.instanceId.length > 100
    || /[\u0000-\u001f\u007f]/.test(config.deployment.instanceId)) {
    throw new Error('deployment.instanceId must be a string no longer than 100 characters.');
  }
  if (typeof config.deployment.multiInstance !== 'boolean') {
    throw new Error('deployment.multiInstance must be true or false.');
  }
  if (config.trustProxy === true && config.deployment.environment === 'production') {
    throw new Error('trustProxy=true trusts arbitrary forwarding paths and is forbidden in production; use a hop count or explicit CIDR list.');
  }
  if (Array.isArray(config.trustProxy)) {
    if (!config.trustProxy.length || config.trustProxy.length > 100
      || config.trustProxy.some(entry => typeof entry !== 'string' || !entry || entry.length > 100
        || /[\u0000-\u001f\u007f]/.test(entry))) {
      throw new Error('trustProxy must contain between 1 and 100 bounded proxy addresses or CIDRs.');
    }
  } else if (config.trustProxy !== false && config.trustProxy !== true
    && (!Number.isInteger(config.trustProxy) || config.trustProxy < 1 || config.trustProxy > 10)) {
    throw new Error('trustProxy must be false, a hop count from 1 to 10, or a comma-separated address/CIDR list.');
  }
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error('port must be an integer between 0 and 65535.');
  }
  if (!isPlainObject(config.security) || !isPlainObject(config.security.hsts)
    || typeof config.security.hsts.enabled !== 'boolean'
    || typeof config.security.hsts.includeSubDomains !== 'boolean'
    || typeof config.security.hsts.preload !== 'boolean'
    || !Number.isInteger(config.security.hsts.maxAgeSeconds)
    || config.security.hsts.maxAgeSeconds < 0
    || config.security.hsts.maxAgeSeconds > 63072000) {
    throw new Error('security.hsts must contain typed values and maxAgeSeconds between 0 and 63072000.');
  }
  if (config.security.hsts.preload
    && (!config.security.hsts.enabled || !config.security.hsts.includeSubDomains
      || config.security.hsts.maxAgeSeconds < 31536000)) {
    throw new Error('HSTS preload requires HSTS, includeSubDomains, and a max age of at least one year.');
  }
}

// Database I/O happens once in bootstrap; this stays synchronous for app factories.
function loadStartupConfig(overrides = {}) {
  const config = mergeConfig(DEFAULTS, overrides);
  validateStartupConfig(config);
  return config;
}

function loadConfig(overrides = {}) {
  const config = mergeConfig(DEFAULTS, overrides);
  for (const [name, packageName] of [['ffmpegPath', 'ffmpeg-static'], ['ffprobePath', 'ffprobe-static']]) {
    if (!Object.hasOwn(overrides.media || {}, name) || config.media[name] === DEFAULTS.media[name]) {
      config.media[name] = bundledMediaBinary(packageName, name === 'ffprobePath') || config.media[name];
    }
  }
  const legacyPostLimitConfigured = Object.hasOwn(overrides.limits || {}, 'postRateLimit')
    || Object.hasOwn(overrides.limits || {}, 'postRateWindowMs');
  if (legacyPostLimitConfigured) {
    for (const operation of ['threadCreate', 'replyCreate', 'mediaPost']) {
      if (Object.hasOwn(overrides.rateLimit?.operations || {}, operation)) continue;
      config.rateLimit.operations[operation] = {
        windowMs: config.limits.postRateWindowMs,
        limit: config.limits.postRateLimit
      };
    }
  }
  const legacyReportLimitConfigured = Object.hasOwn(overrides.limits || {}, 'reportRateLimit')
    || Object.hasOwn(overrides.limits || {}, 'reportRateWindowMs');
  if (legacyReportLimitConfigured && !Object.hasOwn(overrides.rateLimit?.operations || {}, 'reportCreate')) {
    config.rateLimit.operations.reportCreate = {
      windowMs: config.limits.reportRateWindowMs,
      limit: config.limits.reportRateLimit
    };
  }

  config.rootDir = ROOT_DIR;
  config.site.pages = { ...(config.site.pages || {}), ...loadPages(path.resolve(config.rootDir, config.site.pageDirectory)) };
  config.dataDir = path.resolve(ROOT_DIR, config.dataDir);
  config.dataFile = path.join(config.dataDir, 'posts.json');
  config.uploadDir = path.join(config.dataDir, 'src');
  config.deployment.isProduction = config.deployment.environment === 'production';
  config.quarantineDir = path.join(config.dataDir, 'quarantine');

  validateStartupConfig(config);
  if (!isPlainObject(config.mongo) || typeof config.mongo.requireTransactions !== 'boolean') {
    throw new Error('mongo.requireTransactions must be true or false.');
  }

  const positiveLimits = [
    'maxRequestBytes', 'maxFileBytes', 'maxVideoBytes', 'maxFilesPerPost', 'maxImageDimension', 'maxImagePixels',
    'maxVideoDimension', 'maxVideoPixels', 'maxVideoDurationSeconds', 'maxVideoFrameRate',
    'maxNameLength', 'maxSubjectLength', 'maxCommentLength',
    'maxCommentLines', 'maxLinks', 'maxCites', 'maxBoardRules', 'maxBoardRuleLength',
    'maxStaffAccounts', 'maxThreads', 'threadsPerPage', 'catalogThreadsPerPage', 'adminPageSize',
    'previewReplies', 'bumpLimit', 'replyLimit',
    'postRateWindowMs', 'postRateLimit', 'reportRateWindowMs', 'reportRateLimit'
  ];
  for (const key of positiveLimits) {
    if (!Number.isInteger(config.limits[key]) || config.limits[key] < 1) {
      throw new Error(`limits.${key} must be a positive integer.`);
    }
  }
  if (config.limits.maxFilesPerPost > 4) {
    throw new Error('limits.maxFilesPerPost cannot exceed the hard safety cap of 4.');
  }
  if (config.limits.catalogThreadsPerPage > 250 || config.limits.adminPageSize > 200) {
    throw new Error('Catalog and administrative page sizes exceed their hard safety caps.');
  }
  if (config.limits.maxRequestBytes < Math.max(config.limits.maxFileBytes, config.limits.maxVideoBytes)
    || config.limits.maxRequestBytes > 512 * 1024 * 1024) {
    throw new Error('limits.maxRequestBytes must fit one allowed file and cannot exceed 512 MiB.');
  }
  if (!Number.isInteger(config.limits.deleteDelaySeconds) || config.limits.deleteDelaySeconds < 0) {
    throw new Error('limits.deleteDelaySeconds must be a non-negative integer.');
  }
  if (!Array.isArray(config.wordFilters)) throw new Error('wordFilters must be an array.');
  if (!Array.isArray(config.fortunes)) throw new Error('fortunes must be an array.');
  for (const entry of config.fortunes) {
    if (typeof entry !== 'string') throw new Error('fortunes must contain only strings.');
  }

  for (const [name, enabled] of Object.entries(config.features)) {
    if (typeof enabled !== 'boolean') throw new Error(`features.${name} must be true or false.`);
  }

  if (!isPlainObject(config.media)) throw new Error('media must be an object.');
  if (typeof config.media.stripMetadata !== 'boolean' || typeof config.media.stripMetadataRequired !== 'boolean') {
    throw new Error('media.stripMetadata and media.stripMetadataRequired must be true or false.');
  }
  if (config.media.stripMetadataRequired && !config.media.stripMetadata) {
    throw new Error('Required metadata stripping cannot be enabled while metadata stripping is disabled.');
  }
  if (!isPlainObject(config.mediaWorker) || !['local', 'external'].includes(config.mediaWorker.mode)) {
    throw new Error('mediaWorker.mode must be local or external.');
  }
  for (const key of ['concurrency', 'timeoutMs', 'maxQueue', 'expectedMemoryMb']) {
    if (!Number.isInteger(config.mediaWorker[key]) || config.mediaWorker[key] < 1) {
      throw new Error(`mediaWorker.${key} must be a positive integer.`);
    }
  }
  if (!Number.isInteger(config.mediaWorker.retryLimit) || config.mediaWorker.retryLimit < 0
    || config.mediaWorker.retryLimit > 5 || config.mediaWorker.concurrency > 32
    || config.mediaWorker.maxQueue > 10000 || config.mediaWorker.expectedMemoryMb > 8192) {
    throw new Error('Media worker retry, concurrency, queue, or memory expectations exceed safety caps.');
  }
  if (config.mediaWorker.timeoutMs < config.media.processTimeoutMs
    || config.mediaWorker.timeoutMs > 10 * 60 * 1000) {
    throw new Error('mediaWorker.timeoutMs must cover the processor timeout and cannot exceed ten minutes.');
  }
  if (!isPlainObject(config.mediaStorage) || !['local', 'object'].includes(config.mediaStorage.backend)
    || !isPlainObject(config.mediaStorage.object)) {
    throw new Error('mediaStorage.backend must be local or object.');
  }
  const objectStorage = config.mediaStorage.object;
  if (typeof objectStorage.pathStyle !== 'boolean') throw new Error('mediaStorage.object.pathStyle must be true or false.');
  if (!Number.isInteger(objectStorage.requestTimeoutMs) || objectStorage.requestTimeoutMs < 1000
    || objectStorage.requestTimeoutMs > 60000) {
    throw new Error('mediaStorage.object.requestTimeoutMs must be an integer between 1000 and 60000.');
  }
  for (const key of ['endpoint', 'region', 'quarantineBucket', 'publicBucket', 'publicBaseUrl',
    'accessKeyId', 'secretAccessKey', 'sessionToken', 'cachePurgeUrl', 'cachePurgeToken']) {
    if (typeof objectStorage[key] !== 'string' || objectStorage[key].length > 2000
      || objectStorage[key].includes('\0')) {
      throw new Error(`mediaStorage.object.${key} must be a bounded string.`);
    }
  }
  if (objectStorage.cachePurgeUrl) {
    let purge;
    try { purge = new URL(objectStorage.cachePurgeUrl); } catch { throw new Error('Invalid cache purge gateway URL.'); }
    if (purge.protocol !== 'https:' || purge.username || purge.password || purge.hash || !objectStorage.cachePurgeToken) throw new Error('Cache purge gateway requires HTTPS and a token.');
  }
  if (/[\r\n\0]/.test(objectStorage.cachePurgeToken)) throw new Error('Invalid cache purge gateway token.');
  if (config.mediaStorage.backend === 'object') {
    let endpoint;
    let publicBaseUrl;
    try {
      endpoint = new URL(objectStorage.endpoint);
      publicBaseUrl = new URL(objectStorage.publicBaseUrl);
    } catch {
      throw new Error('Object storage requires valid mediaStorage.object.endpoint and mediaStorage.object.publicBaseUrl URLs.');
    }
    for (const [name, url] of [['mediaStorage.object.endpoint', endpoint], ['mediaStorage.object.publicBaseUrl', publicBaseUrl]]) {
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error(`${name} must be an http(s) URL without credentials, query parameters, or a fragment.`);
      }
    }
    if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(objectStorage.quarantineBucket)
      || !/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(objectStorage.publicBucket)) {
      throw new Error('Object-storage bucket names must be 3-63 lowercase safe characters.');
    }
    if (objectStorage.quarantineBucket === objectStorage.publicBucket) {
      throw new Error('Private quarantine and public approved media must use different buckets.');
    }
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(objectStorage.region)) {
      throw new Error('mediaStorage.object.region must be a safe region identifier.');
    }
    if (!objectStorage.accessKeyId || !objectStorage.secretAccessKey) {
      throw new Error('Object storage requires mediaStorage.object.accessKeyId and mediaStorage.object.secretAccessKey.');
    }
    if (config.deployment.isProduction && (endpoint.protocol !== 'https:' || publicBaseUrl.protocol !== 'https:')) {
      throw new Error('Production object storage and media delivery URLs must use HTTPS.');
    }
  }
  if (!isPlainObject(config.lifecycle)) throw new Error('lifecycle must be an object.');
  if (!isPlainObject(config.antiAbuse)) {
    throw new Error('antiAbuse must be an object.');
  }
  if (!isPlainObject(config.antiAbuse.nativeCaptcha) || typeof config.antiAbuse.nativeCaptcha.enabled !== 'boolean') {
    throw new Error('antiAbuse.nativeCaptcha.enabled must be true or false.');
  }
  if (!isPlainObject(config.maintenance) || typeof config.maintenance.enabled !== 'boolean') {
    throw new Error('maintenance.enabled must be true or false.');
  }
  if (!isPlainObject(config.extensions) || !Number.isInteger(config.extensions.hookTimeoutMs)
    || config.extensions.hookTimeoutMs < 50 || config.extensions.hookTimeoutMs > 5000) {
    throw new Error('extensions.hookTimeoutMs must be an integer between 50 and 5000.');
  }
  if (!isPlainObject(config.i18n)
    || !/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(String(config.i18n.defaultLanguage || ''))) {
    throw new Error('i18n.defaultLanguage must be a valid language tag.');
  }
  if (!isPlainObject(config.staffMfa) || typeof config.staffMfa.enabled !== 'boolean'
    || typeof config.staffMfa.issuer !== 'string' || !config.staffMfa.issuer.trim()
    || config.staffMfa.issuer.length > 80 || /[\u0000-\u001f\u007f]/.test(config.staffMfa.issuer)
    || typeof config.staffMfa.encryptionKey !== 'string' || config.staffMfa.encryptionKey.length > 200) {
    throw new Error('staffMfa must contain a boolean enabled flag, a bounded issuer, and an encrypted database key.');
  }
  if (config.staffMfa.enabled) parseEncryptionKey(config.staffMfa.encryptionKey);
  if (!isPlainObject(config.postingAuthorization)
    || typeof config.postingAuthorization.enabled !== 'boolean'
    || !Number.isInteger(config.postingAuthorization.ttlMs)
    || config.postingAuthorization.ttlMs < 30000
    || config.postingAuthorization.ttlMs > 10 * 60 * 1000
    || typeof config.postingAuthorization.secret !== 'string'
    || config.postingAuthorization.secret.length > 500
    || config.postingAuthorization.secret.includes('\0')) {
    throw new Error('postingAuthorization must contain a boolean enabled flag, a 30-second to 10-minute TTL, and a bounded secret.');
  }
  if (!isPlainObject(config.mediaSafety)
    || !/^(?:none|[a-z0-9][a-z0-9._-]{0,79})$/i.test(String(config.mediaSafety.knownIllegalProvider || ''))
    || typeof config.mediaSafety.failClosed !== 'boolean'
    || typeof config.mediaSafety.retainProviderResults !== 'boolean') {
    throw new Error('mediaSafety must contain a safe provider name and boolean policy values.');
  }
  if (config.mediaSafety.gatewayUrl) {
    let url;
    try { url = new URL(config.mediaSafety.gatewayUrl); } catch { throw new Error('Invalid moderation gateway URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Moderation gateway must use HTTPS without credentials or fragments.');
  }
  if (typeof config.mediaSafety.gatewayToken !== 'string' || config.mediaSafety.gatewayToken.length > 2000
    || /[\r\n\0]/.test(config.mediaSafety.gatewayToken)
    || !Number.isInteger(config.mediaSafety.timeoutMs) || config.mediaSafety.timeoutMs < 1000 || config.mediaSafety.timeoutMs > 60000) throw new Error('Invalid moderation gateway token or timeout.');
  if (config.postingAuthorization.enabled && config.postingAuthorization.secret.length < 32) {
    throw new Error('Enabled posting authorization requires postingAuthorization.secret with at least 32 characters.');
  }
  if (!isPlainObject(config.rateLimit) || !['memory', 'mongodb', 'redis'].includes(config.rateLimit.backend)) {
    throw new Error('rateLimit.backend must be memory, mongodb, or redis.');
  }
  if (!/^[a-z0-9:_-]{1,50}$/i.test(String(config.rateLimit.prefix || ''))) {
    throw new Error('rateLimit.prefix must contain 1-50 safe characters.');
  }
  if (typeof config.rateLimit.redisUrl !== 'string' || config.rateLimit.redisUrl.length > 2000
    || config.rateLimit.redisUrl.includes('\0')) {
    throw new Error('rateLimit.redisUrl must be a bounded string.');
  }
  if (config.rateLimit.backend === 'redis' && !/^rediss?:\/\//i.test(config.rateLimit.redisUrl)) {
    throw new Error('Redis rate limiting requires rateLimit.redisUrl using redis:// or rediss://.');
  }
  if (!isPlainObject(config.rateLimit.operations)) throw new Error('rateLimit.operations must be an object.');
  for (const [name, operation] of Object.entries(config.rateLimit.operations)) {
    if (!isPlainObject(operation) || !Number.isInteger(operation.windowMs) || operation.windowMs < 1000
      || !Number.isInteger(operation.limit) || operation.limit < 1 || operation.limit > 100000) {
      throw new Error(`rateLimit.operations.${name} must contain a window of at least 1000ms and a positive limit.`);
    }
  }
  if (!Number.isInteger(config.maintenance.startupDelayMs) || config.maintenance.startupDelayMs < 0) {
    throw new Error('maintenance.startupDelayMs must be a non-negative integer.');
  }
  for (const key of ['intervalMs', 'leaseMs']) {
    if (!Number.isInteger(config.maintenance[key]) || config.maintenance[key] < 10000) {
      throw new Error(`maintenance.${key} must be an integer of at least 10000.`);
    }
  }
  for (const key of ['staffTrashRetentionDays', 'quarantineRetentionHours', 'maxRevisionsPerPost']) {
    if (!Number.isInteger(config.lifecycle[key]) || config.lifecycle[key] < 1) {
      throw new Error(`lifecycle.${key} must be a positive integer.`);
    }
  }
  for (const key of ['ffprobePath', 'ffmpegPath']) {
    if (typeof config.media[key] !== 'string' || !config.media[key].trim() || config.media[key].includes('\0')) {
      throw new Error(`media.${key} must be a non-empty command or path.`);
    }
  }
  for (const key of [
    'processTimeoutMs', 'thumbnailMaxWidth', 'thumbnailMaxHeight',
    'thumbnailThresholdBytes', 'maxThumbnailBytes'
  ]) {
    if (!Number.isInteger(config.media[key]) || config.media[key] < 1) {
      throw new Error(`media.${key} must be a positive integer.`);
    }
  }

  if (config.antiAbuse.turnstile?.enabled || config.postingAuthorization.enabled || config.deployment.isProduction) {
    config.antiAbuse.nativeCaptcha.enabled = true;
  }
  delete config.antiAbuse.turnstile;
  delete config.privacy;

  if (config.deployment.isProduction) {
    if (config.deployment.multiInstance && config.mediaStorage.backend !== 'object') {
      throw new Error('deployment.multiInstance=true requires shared object media storage.');
    }
    if (config.storage !== 'mongodb') {
      throw new Error('Production requires shared MongoDB storage; JSON storage is development-only.');
    }
    if (config.deployment.multiInstance && !config.mongo.requireTransactions) {
      throw new Error('deployment.multiInstance=true requires mongo.requireTransactions=true and a replica set or sharded MongoDB deployment.');
    }
    if (config.rateLimit.backend === 'memory') {
      throw new Error('Production requires rateLimit.backend=mongodb or redis; memory limits are process-local.');
    }
    if (!config.postingAuthorization.enabled) {
      throw new Error('Production anonymous posting requires postingAuthorization.enabled=true.');
    }
    if (!config.media.stripMetadata || !config.media.stripMetadataRequired) {
      throw new Error('Production requires metadata stripping in required mode.');
    }
  }

  if (!isPlainObject(config.reports) || !Array.isArray(config.reports.categories)) {
    throw new Error('reports.categories must be an array.');
  }
  if (!config.reports.categories.length || config.reports.categories.length > 20) {
    throw new Error('reports.categories must contain between 1 and 20 categories.');
  }
  const reportCategoryIds = new Set();
  for (const category of config.reports.categories) {
    if (!isPlainObject(category) || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(String(category.id || ''))) {
      throw new Error('Each report category needs a lowercase id containing letters, numbers, underscores, or hyphens.');
    }
    if (reportCategoryIds.has(category.id)) throw new Error(`Duplicate report category: ${category.id}.`);
    if (typeof category.label !== 'string' || !category.label.trim() || category.label.length > 80) {
      throw new Error(`Report category ${category.id} needs a label between 1 and 80 characters.`);
    }
    reportCategoryIds.add(category.id);
  }
  if (!reportCategoryIds.has(config.reports.defaultCategory)) {
    throw new Error('reports.defaultCategory must match a configured report category.');
  }

  return config;
}

module.exports = { DEFAULTS, ENV_FILE, loadConfig, loadStartupConfig, mergeConfig };
