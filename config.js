'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseEncryptionKey } = require('./lib/mfa');

const ROOT_DIR = __dirname;
const ENV_FILE = path.join(ROOT_DIR, '.env');

if (fs.existsSync(ENV_FILE)) {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch (error) {
    throw new Error(`Could not read environment file at ${ENV_FILE}: ${error.message}`);
  }
}

const DEFAULTS = {
  host: '0.0.0.0',
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
  privacy: {
    abuseFingerprintSecret: ''
  },
  postingAuthorization: {
    enabled: false,
    secret: '',
    ttlMs: 2 * 60 * 1000
  },
  mediaSafety: {
    knownIllegalProvider: 'none',
    failClosed: false,
    retainProviderResults: true
  },
  rateLimit: {
    backend: 'memory',
    redisUrl: '',
    prefix: 'chikochan',
    operations: {
      threadCreate: { windowMs: 10 * 60 * 1000, limit: 3 },
      replyCreate: { windowMs: 60 * 1000, limit: 8 },
      mediaPost: { windowMs: 10 * 60 * 1000, limit: 8 },
      reportCreate: { windowMs: 10 * 60 * 1000, limit: 5 },
      deletePassword: { windowMs: 15 * 60 * 1000, limit: 10 },
      adminLogin: { windowMs: 15 * 60 * 1000, limit: 8 },
      captchaAuthorization: { windowMs: 10 * 60 * 1000, limit: 10 },
      boardCreate: { windowMs: 60 * 60 * 1000, limit: 10 },
      apiMutation: { windowMs: 60 * 1000, limit: 20 },
      expensiveRead: { windowMs: 60 * 1000, limit: 30 }
    }
  },
  anonymousName: 'Anonymous',
  site: {
    title: 'ChikoChan',
    description:
    'Welcome to ChikoChan!\n\n' +
    'This little imageboard is a place to share whatever is on your mind — cute pictures, random thoughts, memes, art, games, hobbies, and more.\n\n' +
    'Some boards have specific categories, so please make sure your posts fit the board and follow the rules: https://boards.chiko.cc/rules\n\n' +
    'Feel free to stay and have fun! ^-^',
    announcement: 'I just update some. Sorry if it might be bug!!!'
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
    posterIds: false,
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
  antiAbuse: {
    turnstile: {
      enabled: false,
      siteKey: '',
      secretKey: '',
      timeoutMs: 5000,
      failureMode: 'closed',
      allowedHostnames: []
    }
  },
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
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeConfig(base, override) {
  const merged = { ...base };

  for (const [key, value] of Object.entries(override || {})) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      merged[key] = mergeConfig(base[key], value);
    } else {
      merged[key] = value;
    }
  }

  return merged;
}

function envNumber(name, fallback) {
  if (process.env[name] === undefined) return fallback;
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
  return value;
}

function envTrustProxy(fallback) {
  if (process.env.TRUST_PROXY === undefined) return fallback;
  const raw = process.env.TRUST_PROXY.trim();
  const value = raw.toLowerCase();
  if (/^[1-9]\d*$/.test(value)) return Number(value);
  if (['true', 'yes'].includes(value)) return true;
  if (['0', 'false', 'no', ''].includes(value)) return false;
  return raw.split(',').map(entry => entry.trim()).filter(Boolean);
}

function envBoolean(name, fallback) {
  if (process.env[name] === undefined) return fallback;
  const value = process.env[name].trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(value)) return true;
  if (['0', 'false', 'no', ''].includes(value)) return false;
  throw new Error(`${name} must be true or false.`);
}

function envString(name, fallback) {
  return process.env[name] === undefined ? fallback : process.env[name];
}

function envRateOperation(name, value) {
  return {
    windowMs: envNumber(`${name}_RATE_WINDOW_MS`, value.windowMs),
    limit: envNumber(`${name}_RATE_LIMIT`, value.limit)
  };
}

function readConfigFile(configPath) {
  if (!fs.existsSync(configPath)) return {};

  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read configuration at ${configPath}: ${error.message}`);
  }
}

function loadPages(rootDir) {
  const pagesDir = path.join(rootDir, 'page');
  if (!fs.existsSync(pagesDir)) return {};

  const pages = {};
  for (const filename of fs.readdirSync(pagesDir).sort()) {
    if (!filename.endsWith('.txt')) continue;
    const key = filename.slice(0, -4);
    const routeKey = key === 'rule' ? 'rules' : key;
    const title = routeKey.charAt(0).toUpperCase() + routeKey.slice(1);
    const content = fs.readFileSync(path.join(pagesDir, filename), 'utf8');
    pages[routeKey] = { title, content };
  }
  return pages;
}

function loadConfig(overrides = {}) {
  const configPath = path.resolve(process.env.CHIKO_CONFIG || path.join(ROOT_DIR, 'config.json'));
  const fromFile = readConfigFile(configPath);
  if (Object.hasOwn(fromFile, 'adminPassword') || Object.hasOwn(fromFile, 'adminSessionSecret')) {
    throw new Error('Admin credentials are environment-only. Move them to .env or deployment variables.');
  }
  if (Object.hasOwn(fromFile.antiAbuse?.turnstile || {}, 'secretKey')) {
    throw new Error('Turnstile secret keys are environment-only. Move them to .env or deployment variables.');
  }
  if (Object.hasOwn(fromFile.privacy || {}, 'abuseFingerprintSecret')) {
    throw new Error('Privacy fingerprint secrets are environment-only. Move them to .env or deployment variables.');
  }
  if (Object.hasOwn(fromFile.postingAuthorization || {}, 'secret')) {
    throw new Error('Posting authorization secrets are environment-only. Move them to .env or deployment variables.');
  }
  if (Object.hasOwn(fromFile.rateLimit || {}, 'redisUrl')) {
    throw new Error('Redis URLs are environment-only. Move them to .env or deployment variables.');
  }
  if (Object.hasOwn(fromFile.staffMfa || {}, 'encryptionKey')) {
    throw new Error('Staff MFA encryption keys are environment-only. Move them to .env or deployment variables.');
  }
  const configuredObjectStorage = fromFile.mediaStorage?.object || {};
  if (['accessKeyId', 'secretAccessKey', 'sessionToken'].some(key => Object.hasOwn(configuredObjectStorage, key))) {
    throw new Error('Object-storage credentials are environment-only. Move them to .env or deployment variables.');
  }
  const hasInjectedAdminPassword = Object.hasOwn(overrides, 'adminPassword');
  const hasInjectedAdminSecret = Object.hasOwn(overrides, 'adminSessionSecret');
  const hasInjectedTurnstileSecret = Object.hasOwn(overrides.antiAbuse?.turnstile || {}, 'secretKey');
  const hasInjectedAbuseSecret = Object.hasOwn(overrides.privacy || {}, 'abuseFingerprintSecret');
  const hasInjectedPostingSecret = Object.hasOwn(overrides.postingAuthorization || {}, 'secret');
  const hasInjectedRedisUrl = Object.hasOwn(overrides.rateLimit || {}, 'redisUrl');
  const hasInjectedMfaKey = Object.hasOwn(overrides.staffMfa || {}, 'encryptionKey');
  const injectedObjectStorage = overrides.mediaStorage?.object || {};
  let config = mergeConfig(DEFAULTS, fromFile);

  config = mergeConfig(config, {
    host: process.env.HOST || config.host,
    port: envNumber('PORT', config.port),
    storage: process.env.STORAGE || config.storage,
    dataDir: process.env.DATA_DIR || config.dataDir,
    mongoUrl: process.env.MONGO_URL || process.env.MONGODB_URI || config.mongoUrl,
    mongoDbName: process.env.MONGO_DB_NAME || config.mongoDbName,
    mongo: {
      requireTransactions: envBoolean('MONGO_REQUIRE_TRANSACTIONS', config.mongo.requireTransactions)
    },
    trustProxy: envTrustProxy(config.trustProxy),
    deployment: {
      environment: envString('NODE_ENV', config.deployment.environment),
      publicOrigin: envString('PUBLIC_ORIGIN', config.deployment.publicOrigin),
      instanceId: envString('INSTANCE_ID', config.deployment.instanceId),
      multiInstance: envBoolean('MULTI_INSTANCE', config.deployment.multiInstance)
    },
    security: {
      hsts: {
        enabled: envBoolean('HSTS_ENABLED', config.security.hsts.enabled),
        maxAgeSeconds: envNumber('HSTS_MAX_AGE_SECONDS', config.security.hsts.maxAgeSeconds),
        includeSubDomains: envBoolean('HSTS_INCLUDE_SUBDOMAINS', config.security.hsts.includeSubDomains),
        preload: envBoolean('HSTS_PRELOAD', config.security.hsts.preload)
      }
    },
    staffMfa: {
      enabled: envBoolean('STAFF_MFA_ENABLED', config.staffMfa.enabled),
      issuer: envString('STAFF_MFA_ISSUER', config.staffMfa.issuer)
    },
    postingAuthorization: {
      enabled: envBoolean('POSTING_AUTH_REQUIRED', config.postingAuthorization.enabled),
      ttlMs: envNumber('POSTING_AUTH_TTL_MS', config.postingAuthorization.ttlMs)
    },
    mediaSafety: {
      knownIllegalProvider: envString('KNOWN_ILLEGAL_MEDIA_PROVIDER', config.mediaSafety.knownIllegalProvider),
      failClosed: envBoolean('KNOWN_ILLEGAL_MEDIA_FAIL_CLOSED', config.mediaSafety.failClosed),
      retainProviderResults: envBoolean(
        'RETAIN_MEDIA_PROVIDER_RESULTS',
        config.mediaSafety.retainProviderResults
      )
    },
    rateLimit: {
      backend: envString('RATE_LIMIT_STORE', envString('RATE_LIMIT_BACKEND', config.rateLimit.backend)),
      prefix: envString('RATE_LIMIT_PREFIX', config.rateLimit.prefix),
      operations: Object.fromEntries(Object.entries(config.rateLimit.operations).map(([key, value]) => [
        key,
        envRateOperation(key.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase(), value)
      ]))
    },
    media: {
      ffprobePath: process.env.FFPROBE_PATH || config.media.ffprobePath,
      ffmpegPath: process.env.FFMPEG_PATH || config.media.ffmpegPath,
      stripMetadata: envBoolean('STRIP_MEDIA_METADATA', config.media.stripMetadata),
      stripMetadataRequired: envBoolean('REQUIRE_METADATA_STRIPPING', config.media.stripMetadataRequired)
    },
    mediaWorker: {
      mode: envString('MEDIA_WORKER_MODE', config.mediaWorker.mode),
      concurrency: envNumber('MEDIA_WORKER_CONCURRENCY', config.mediaWorker.concurrency),
      timeoutMs: envNumber('MEDIA_WORKER_TIMEOUT_MS', config.mediaWorker.timeoutMs),
      retryLimit: envNumber('MEDIA_WORKER_RETRY_LIMIT', config.mediaWorker.retryLimit),
      maxQueue: envNumber('MEDIA_WORKER_MAX_QUEUE', config.mediaWorker.maxQueue),
      expectedMemoryMb: envNumber('MEDIA_WORKER_EXPECTED_MEMORY_MB', config.mediaWorker.expectedMemoryMb)
    },
    mediaStorage: {
      backend: envString('MEDIA_STORAGE_BACKEND', config.mediaStorage.backend),
      object: {
        endpoint: envString('S3_ENDPOINT', config.mediaStorage.object.endpoint),
        region: envString('S3_REGION', config.mediaStorage.object.region),
        quarantineBucket: envString('S3_QUARANTINE_BUCKET', config.mediaStorage.object.quarantineBucket),
        publicBucket: envString('S3_PUBLIC_BUCKET', config.mediaStorage.object.publicBucket),
        publicBaseUrl: envString('MEDIA_PUBLIC_BASE_URL', config.mediaStorage.object.publicBaseUrl),
        pathStyle: envBoolean('S3_PATH_STYLE', config.mediaStorage.object.pathStyle),
        requestTimeoutMs: envNumber('S3_REQUEST_TIMEOUT_MS', config.mediaStorage.object.requestTimeoutMs)
      }
    },
    lifecycle: {
      staffTrashRetentionDays: envNumber(
        'STAFF_TRASH_RETENTION_DAYS',
        config.lifecycle.staffTrashRetentionDays
      ),
      quarantineRetentionHours: envNumber(
        'QUARANTINE_RETENTION_HOURS',
        config.lifecycle.quarantineRetentionHours
      )
    },
    antiAbuse: {
      turnstile: {
        enabled: envBoolean('TURNSTILE_ENABLED', config.antiAbuse.turnstile.enabled),
        siteKey: process.env.TURNSTILE_SITE_KEY || config.antiAbuse.turnstile.siteKey,
        timeoutMs: envNumber('TURNSTILE_TIMEOUT_MS', config.antiAbuse.turnstile.timeoutMs),
        failureMode: process.env.TURNSTILE_FAILURE_MODE || config.antiAbuse.turnstile.failureMode,
        allowedHostnames: process.env.TURNSTILE_ALLOWED_HOSTNAMES === undefined
          ? config.antiAbuse.turnstile.allowedHostnames
          : process.env.TURNSTILE_ALLOWED_HOSTNAMES.split(',').map(value => value.trim()).filter(Boolean)
      }
    },
    maintenance: {
      enabled: envBoolean('MAINTENANCE_ENABLED', config.maintenance.enabled),
      startupDelayMs: envNumber('MAINTENANCE_STARTUP_DELAY_MS', config.maintenance.startupDelayMs),
      intervalMs: envNumber('MAINTENANCE_INTERVAL_MS', config.maintenance.intervalMs),
      leaseMs: envNumber('MAINTENANCE_LEASE_MS', config.maintenance.leaseMs)
    },
    i18n: {
      defaultLanguage: process.env.DEFAULT_LANGUAGE || config.i18n.defaultLanguage
    },
    limits: {
      maxRequestBytes: envNumber('MAX_REQUEST_BYTES', config.limits.maxRequestBytes),
      maxVideoBytes: envNumber('MAX_VIDEO_BYTES', config.limits.maxVideoBytes),
      maxFilesPerPost: envNumber('MAX_FILES_PER_POST', config.limits.maxFilesPerPost),
      catalogThreadsPerPage: envNumber('CATALOG_THREADS_PER_PAGE', config.limits.catalogThreadsPerPage),
      adminPageSize: envNumber('ADMIN_PAGE_SIZE', config.limits.adminPageSize),
      postRateWindowMs: envNumber('POST_RATE_WINDOW_MS', config.limits.postRateWindowMs),
      postRateLimit: envNumber('POST_RATE_LIMIT', config.limits.postRateLimit)
    }
  });
  config = mergeConfig(config, overrides);

  const legacyPostLimitConfigured = Object.hasOwn(overrides.limits || {}, 'postRateLimit')
    || Object.hasOwn(overrides.limits || {}, 'postRateWindowMs')
    || process.env.POST_RATE_LIMIT !== undefined
    || process.env.POST_RATE_WINDOW_MS !== undefined;
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
  config.configPath = configPath;
  config.site.pages = { ...loadPages(config.rootDir), ...(config.site.pages || {}) };
  config.dataDir = path.resolve(ROOT_DIR, config.dataDir);
  config.dataFile = path.join(config.dataDir, 'posts.json');
  config.uploadDir = path.join(config.dataDir, 'src');
  config.adminPassword = hasInjectedAdminPassword
    ? String(overrides.adminPassword || '')
    : String(process.env.ADMIN_PASSWORD || '');
  config.adminSessionSecret = hasInjectedAdminSecret
    ? String(overrides.adminSessionSecret || '')
    : String(process.env.ADMIN_SESSION_SECRET || '');
  config.antiAbuse.turnstile.secretKey = hasInjectedTurnstileSecret
    ? String(overrides.antiAbuse.turnstile.secretKey || '')
    : String(process.env.TURNSTILE_SECRET_KEY || '');
  config.privacy.abuseFingerprintSecret = hasInjectedAbuseSecret
    ? String(overrides.privacy.abuseFingerprintSecret || '')
    : String(process.env.ABUSE_FINGERPRINT_SECRET || '');
  config.postingAuthorization.secret = hasInjectedPostingSecret
    ? String(overrides.postingAuthorization.secret || '')
    : String(process.env.POSTING_AUTH_SECRET || '');
  config.rateLimit.redisUrl = hasInjectedRedisUrl
    ? String(overrides.rateLimit.redisUrl || '')
    : String(process.env.REDIS_URL || '');
  config.staffMfa.encryptionKey = hasInjectedMfaKey
    ? String(overrides.staffMfa.encryptionKey || '')
    : String(process.env.STAFF_MFA_ENCRYPTION_KEY || '');
  config.mediaStorage.object.accessKeyId = Object.hasOwn(injectedObjectStorage, 'accessKeyId')
    ? String(injectedObjectStorage.accessKeyId || '')
    : String(process.env.S3_ACCESS_KEY_ID || '');
  config.mediaStorage.object.secretAccessKey = Object.hasOwn(injectedObjectStorage, 'secretAccessKey')
    ? String(injectedObjectStorage.secretAccessKey || '')
    : String(process.env.S3_SECRET_ACCESS_KEY || '');
  config.mediaStorage.object.sessionToken = Object.hasOwn(injectedObjectStorage, 'sessionToken')
    ? String(injectedObjectStorage.sessionToken || '')
    : String(process.env.S3_SESSION_TOKEN || '');
  config.deployment.isProduction = config.deployment.environment === 'production';
  config.quarantineDir = path.join(config.dataDir, 'quarantine');

  if (!['mongodb', 'json'].includes(config.storage)) {
    throw new Error('storage must be either "mongodb" or "json".');
  }
  if (!isPlainObject(config.mongo) || typeof config.mongo.requireTransactions !== 'boolean') {
    throw new Error('mongo.requireTransactions must be true or false.');
  }

  if (!['development', 'test', 'production'].includes(config.deployment.environment)) {
    throw new Error('NODE_ENV must be development, test, or production.');
  }
  if (typeof config.deployment.publicOrigin !== 'string'
    || (config.deployment.publicOrigin && !/^https?:\/\/[^\s/]+(?::\d+)?$/i.test(config.deployment.publicOrigin))) {
    throw new Error('PUBLIC_ORIGIN must be an http(s) origin without a path.');
  }
  if (typeof config.deployment.instanceId !== 'string' || config.deployment.instanceId.length > 100
    || /[\u0000-\u001f\u007f]/.test(config.deployment.instanceId)) {
    throw new Error('INSTANCE_ID must be a string no longer than 100 characters.');
  }
  if (typeof config.deployment.multiInstance !== 'boolean') {
    throw new Error('MULTI_INSTANCE must be true or false.');
  }
  if (config.trustProxy === true && config.deployment.isProduction) {
    throw new Error('TRUST_PROXY=true trusts arbitrary forwarding paths and is forbidden in production; use a hop count or explicit CIDR list.');
  }
  if (Array.isArray(config.trustProxy)) {
    if (!config.trustProxy.length || config.trustProxy.length > 100
      || config.trustProxy.some(entry => typeof entry !== 'string' || !entry || entry.length > 100
        || /[\u0000-\u001f\u007f]/.test(entry))) {
      throw new Error('TRUST_PROXY must contain between 1 and 100 bounded proxy addresses or CIDRs.');
    }
  } else if (config.trustProxy !== false && config.trustProxy !== true
    && (!Number.isInteger(config.trustProxy) || config.trustProxy < 1 || config.trustProxy > 10)) {
    throw new Error('TRUST_PROXY must be false, a hop count from 1 to 10, or a comma-separated address/CIDR list.');
  }

  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error('port must be an integer between 0 and 65535.');
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
    throw new Error('MEDIA_WORKER_TIMEOUT_MS must cover the processor timeout and cannot exceed ten minutes.');
  }
  if (!isPlainObject(config.mediaStorage) || !['local', 'object'].includes(config.mediaStorage.backend)
    || !isPlainObject(config.mediaStorage.object)) {
    throw new Error('mediaStorage.backend must be local or object.');
  }
  const objectStorage = config.mediaStorage.object;
  if (typeof objectStorage.pathStyle !== 'boolean') throw new Error('S3_PATH_STYLE must be true or false.');
  if (!Number.isInteger(objectStorage.requestTimeoutMs) || objectStorage.requestTimeoutMs < 1000
    || objectStorage.requestTimeoutMs > 60000) {
    throw new Error('S3_REQUEST_TIMEOUT_MS must be an integer between 1000 and 60000.');
  }
  for (const key of ['endpoint', 'region', 'quarantineBucket', 'publicBucket', 'publicBaseUrl',
    'accessKeyId', 'secretAccessKey', 'sessionToken']) {
    if (typeof objectStorage[key] !== 'string' || objectStorage[key].length > 2000
      || objectStorage[key].includes('\0')) {
      throw new Error(`mediaStorage.object.${key} must be a bounded string.`);
    }
  }
  if (config.mediaStorage.backend === 'object') {
    let endpoint;
    let publicBaseUrl;
    try {
      endpoint = new URL(objectStorage.endpoint);
      publicBaseUrl = new URL(objectStorage.publicBaseUrl);
    } catch {
      throw new Error('Object storage requires valid S3_ENDPOINT and MEDIA_PUBLIC_BASE_URL URLs.');
    }
    for (const [name, url] of [['S3_ENDPOINT', endpoint], ['MEDIA_PUBLIC_BASE_URL', publicBaseUrl]]) {
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
      throw new Error('S3_REGION must be a safe region identifier.');
    }
    if (!objectStorage.accessKeyId || !objectStorage.secretAccessKey) {
      throw new Error('Object storage requires S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.');
    }
    if (config.deployment.isProduction && (endpoint.protocol !== 'https:' || publicBaseUrl.protocol !== 'https:')) {
      throw new Error('Production object storage and media delivery URLs must use HTTPS.');
    }
  }
  if (!isPlainObject(config.lifecycle)) throw new Error('lifecycle must be an object.');
  if (!isPlainObject(config.antiAbuse) || !isPlainObject(config.antiAbuse.turnstile)) {
    throw new Error('antiAbuse.turnstile must be an object.');
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
  if (!isPlainObject(config.security) || !isPlainObject(config.security.hsts)
    || typeof config.security.hsts.enabled !== 'boolean'
    || typeof config.security.hsts.includeSubDomains !== 'boolean'
    || typeof config.security.hsts.preload !== 'boolean'
    || !Number.isInteger(config.security.hsts.maxAgeSeconds)
    || config.security.hsts.maxAgeSeconds < 0
    || config.security.hsts.maxAgeSeconds > 63072000) {
    throw new Error('security.hsts must contain typed values and maxAgeSeconds between 0 and 63072000.');
  }
  if (!isPlainObject(config.staffMfa) || typeof config.staffMfa.enabled !== 'boolean'
    || typeof config.staffMfa.issuer !== 'string' || !config.staffMfa.issuer.trim()
    || config.staffMfa.issuer.length > 80 || /[\u0000-\u001f\u007f]/.test(config.staffMfa.issuer)
    || typeof config.staffMfa.encryptionKey !== 'string' || config.staffMfa.encryptionKey.length > 200) {
    throw new Error('staffMfa must contain a boolean enabled flag, a bounded issuer, and an environment-only key.');
  }
  if (config.staffMfa.enabled) parseEncryptionKey(config.staffMfa.encryptionKey);
  if (config.security.hsts.preload
    && (!config.security.hsts.enabled || !config.security.hsts.includeSubDomains
      || config.security.hsts.maxAgeSeconds < 31536000)) {
    throw new Error('HSTS preload requires HSTS, includeSubDomains, and a max age of at least one year.');
  }
  if (!isPlainObject(config.privacy)
    || typeof config.privacy.abuseFingerprintSecret !== 'string'
    || config.privacy.abuseFingerprintSecret.length > 500
    || config.privacy.abuseFingerprintSecret.includes('\0')) {
    throw new Error('privacy.abuseFingerprintSecret must be a bounded string.');
  }
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
  if (config.postingAuthorization.enabled && config.postingAuthorization.secret.length < 32) {
    throw new Error('Enabled posting authorization requires POSTING_AUTH_SECRET with at least 32 characters.');
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
    throw new Error('Redis rate limiting requires REDIS_URL using redis:// or rediss://.');
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

  const turnstile = config.antiAbuse.turnstile;
  if (typeof turnstile.enabled !== 'boolean') {
    throw new Error('antiAbuse.turnstile.enabled must be true or false.');
  }
  if (!['closed', 'open'].includes(turnstile.failureMode)) {
    throw new Error('antiAbuse.turnstile.failureMode must be "closed" or "open".');
  }
  if (!Number.isInteger(turnstile.timeoutMs) || turnstile.timeoutMs < 500 || turnstile.timeoutMs > 15000) {
    throw new Error('antiAbuse.turnstile.timeoutMs must be an integer between 500 and 15000.');
  }
  if (!Array.isArray(turnstile.allowedHostnames) || turnstile.allowedHostnames.length > 20
    || turnstile.allowedHostnames.some(hostname => !/^(?:localhost|(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)$/i.test(String(hostname || '')))) {
    throw new Error('antiAbuse.turnstile.allowedHostnames must contain at most 20 valid hostnames.');
  }
  turnstile.allowedHostnames = [...new Set(turnstile.allowedHostnames.map(hostname => String(hostname).toLowerCase()))];
  for (const key of ['siteKey', 'secretKey']) {
    if (typeof turnstile[key] !== 'string' || turnstile[key].length > 500 || turnstile[key].includes('\0')) {
      throw new Error(`antiAbuse.turnstile.${key} must be a string no longer than 500 characters.`);
    }
  }
  if (turnstile.enabled && (!turnstile.siteKey.trim() || !turnstile.secretKey.trim())) {
    throw new Error('Enabled Turnstile requires TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY.');
  }

  if (config.deployment.isProduction) {
    if (config.deployment.multiInstance && config.mediaStorage.backend !== 'object') {
      throw new Error('MULTI_INSTANCE=true requires shared object media storage.');
    }
    if (config.storage !== 'mongodb') {
      throw new Error('Production requires shared MongoDB storage; JSON storage is development-only.');
    }
    if (!config.mongo.requireTransactions) {
      throw new Error('Production requires MONGO_REQUIRE_TRANSACTIONS=true and a replica set or sharded MongoDB deployment.');
    }
    if (config.rateLimit.backend === 'memory') {
      throw new Error('Production requires RATE_LIMIT_STORE=mongodb or redis; memory limits are process-local.');
    }
    if (config.privacy.abuseFingerprintSecret.length < 32) {
      throw new Error('Production requires ABUSE_FINGERPRINT_SECRET with at least 32 characters.');
    }
    if (!config.postingAuthorization.enabled) {
      throw new Error('Production anonymous posting requires POSTING_AUTH_REQUIRED=true.');
    }
    if (!turnstile.enabled || turnstile.failureMode !== 'closed') {
      throw new Error('Production posting authorization requires Turnstile enabled in closed failure mode.');
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

module.exports = { DEFAULTS, loadConfig, mergeConfig };
