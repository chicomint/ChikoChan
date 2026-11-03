'use strict';

// One-time import names from releases before database settings.
const LEGACY = {
  ABUSE_FINGERPRINT_SECRET: 'privacy.abuseFingerprintSecret:string',
  ADMIN_PAGE_SIZE: 'limits.adminPageSize:number',
  ADMIN_PASSWORD: 'adminPassword:string',
  ADMIN_SESSION_SECRET: 'adminSessionSecret:string',
  CATALOG_THREADS_PER_PAGE: 'limits.catalogThreadsPerPage:number',
  DATA_DIR: 'dataDir:string',
  DEFAULT_LANGUAGE: 'i18n.defaultLanguage:string',
  FFMPEG_PATH: 'media.ffmpegPath:string',
  FFPROBE_PATH: 'media.ffprobePath:string',
  HOST: 'host:string',
  HSTS_ENABLED: 'security.hsts.enabled:boolean',
  HSTS_INCLUDE_SUBDOMAINS: 'security.hsts.includeSubDomains:boolean',
  HSTS_MAX_AGE_SECONDS: 'security.hsts.maxAgeSeconds:number',
  HSTS_PRELOAD: 'security.hsts.preload:boolean',
  INSTANCE_ID: 'deployment.instanceId:string',
  KNOWN_ILLEGAL_MEDIA_FAIL_CLOSED: 'mediaSafety.failClosed:boolean',
  KNOWN_ILLEGAL_MEDIA_PROVIDER: 'mediaSafety.knownIllegalProvider:string',
  MAINTENANCE_ENABLED: 'maintenance.enabled:boolean',
  MAINTENANCE_INTERVAL_MS: 'maintenance.intervalMs:number',
  MAINTENANCE_LEASE_MS: 'maintenance.leaseMs:number',
  MAINTENANCE_STARTUP_DELAY_MS: 'maintenance.startupDelayMs:number',
  MAX_FILES_PER_POST: 'limits.maxFilesPerPost:number',
  MAX_REQUEST_BYTES: 'limits.maxRequestBytes:number',
  MAX_VIDEO_BYTES: 'limits.maxVideoBytes:number',
  MEDIA_PUBLIC_BASE_URL: 'mediaStorage.object.publicBaseUrl:string',
  MEDIA_STORAGE_BACKEND: 'mediaStorage.backend:string',
  MEDIA_WORKER_CONCURRENCY: 'mediaWorker.concurrency:number',
  MEDIA_WORKER_EXPECTED_MEMORY_MB: 'mediaWorker.expectedMemoryMb:number',
  MEDIA_WORKER_MAX_QUEUE: 'mediaWorker.maxQueue:number',
  MEDIA_WORKER_MODE: 'mediaWorker.mode:string',
  MEDIA_WORKER_RETRY_LIMIT: 'mediaWorker.retryLimit:number',
  MEDIA_WORKER_TIMEOUT_MS: 'mediaWorker.timeoutMs:number',
  MONGODB_URI: 'mongoUrl:string',
  MONGO_DB_NAME: 'mongoDbName:string',
  MONGO_REQUIRE_TRANSACTIONS: 'mongo.requireTransactions:boolean',
  MONGO_URL: 'mongoUrl:string',
  MULTI_INSTANCE: 'deployment.multiInstance:boolean',
  NODE_ENV: 'deployment.environment:string',
  PORT: 'port:number',
  POSTING_AUTH_REQUIRED: 'postingAuthorization.enabled:boolean',
  POSTING_AUTH_SECRET: 'postingAuthorization.secret:string',
  POSTING_AUTH_TTL_MS: 'postingAuthorization.ttlMs:number',
  POST_RATE_LIMIT: 'limits.postRateLimit:number',
  POST_RATE_WINDOW_MS: 'limits.postRateWindowMs:number',
  PUBLIC_ORIGIN: 'deployment.publicOrigin:string',
  QUARANTINE_RETENTION_HOURS: 'lifecycle.quarantineRetentionHours:number',
  RATE_LIMIT_BACKEND: 'rateLimit.backend:string',
  RATE_LIMIT_PREFIX: 'rateLimit.prefix:string',
  RATE_LIMIT_STORE: 'rateLimit.backend:string',
  REDIS_URL: 'rateLimit.redisUrl:string',
  REQUIRE_METADATA_STRIPPING: 'media.stripMetadataRequired:boolean',
  RETAIN_MEDIA_PROVIDER_RESULTS: 'mediaSafety.retainProviderResults:boolean',
  S3_ACCESS_KEY_ID: 'mediaStorage.object.accessKeyId:string',
  S3_ENDPOINT: 'mediaStorage.object.endpoint:string',
  S3_PATH_STYLE: 'mediaStorage.object.pathStyle:boolean',
  S3_PUBLIC_BUCKET: 'mediaStorage.object.publicBucket:string',
  S3_QUARANTINE_BUCKET: 'mediaStorage.object.quarantineBucket:string',
  S3_REGION: 'mediaStorage.object.region:string',
  S3_REQUEST_TIMEOUT_MS: 'mediaStorage.object.requestTimeoutMs:number',
  S3_SECRET_ACCESS_KEY: 'mediaStorage.object.secretAccessKey:string',
  S3_SESSION_TOKEN: 'mediaStorage.object.sessionToken:string',
  SITE_DESCRIPTION: 'site.description:string',
  SITE_NAME: 'site.title:string',
  STAFF_MFA_ENABLED: 'staffMfa.enabled:boolean',
  STAFF_MFA_ENCRYPTION_KEY: 'staffMfa.encryptionKey:string',
  STAFF_MFA_ISSUER: 'staffMfa.issuer:string',
  STAFF_TRASH_RETENTION_DAYS: 'lifecycle.staffTrashRetentionDays:number',
  STORAGE: 'storage:string',
  STRIP_MEDIA_METADATA: 'media.stripMetadata:boolean',
  TRUST_PROXY: 'trustProxy:proxy',
  TURNSTILE_ALLOWED_HOSTNAMES: 'antiAbuse.turnstile.allowedHostnames:list',
  TURNSTILE_ENABLED: 'antiAbuse.turnstile.enabled:boolean',
  TURNSTILE_FAILURE_MODE: 'antiAbuse.turnstile.failureMode:string',
  TURNSTILE_SECRET_KEY: 'antiAbuse.turnstile.secretKey:string',
  TURNSTILE_SITE_KEY: 'antiAbuse.turnstile.siteKey:string',
  TURNSTILE_TIMEOUT_MS: 'antiAbuse.turnstile.timeoutMs:number',
};

function importLegacy(environment, fromFile = {}) {
  const { mergeConfig } = require('../config');
  const settings = mergeConfig({}, fromFile);
  for (const [name, descriptor] of Object.entries(LEGACY)) {
    if (environment[name] === undefined) continue;
    const [key, type] = descriptor.split(':');
    const raw = environment[name];
    let value = raw;
    if (type === 'number') {
      value = Number(raw);
      if (!Number.isFinite(value) || value < 0) throw new Error('Invalid legacy numeric setting.');
    }
    if (type === 'boolean') {
      if (!/^(true|false|yes|no|1|0|)$/i.test(raw.trim())) throw new Error('Invalid legacy boolean setting.');
      value = /^(true|yes|1)$/i.test(raw.trim());
    }
    if (type === 'list') value = raw.split(',').map(part => part.trim()).filter(Boolean);
    if (type === 'proxy') {
      value = /^\d+$/.test(raw) ? Number(raw) : /^(true|yes)$/i.test(raw) ? true
        : /^(false|no|)$/i.test(raw) ? false : raw.split(',').map(part => part.trim());
      if (value === 0) value = false;
    }
    const parts = key.split('.');
    let target = settings;
    for (const part of parts.slice(0, -1)) target = target[part] ||= {};
    target[parts.at(-1)] = value;
  }
  for (const operation of Object.keys(require('../config').DEFAULTS.rateLimit.operations)) {
    const prefix = operation.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
    for (const [suffix, key] of [['_RATE_WINDOW_MS', 'windowMs'], ['_RATE_LIMIT', 'limit']]) {
      if (environment[prefix + suffix] === undefined) continue;
      settings.rateLimit ||= {};
      settings.rateLimit.operations ||= {};
      settings.rateLimit.operations[operation] ||= {};
      settings.rateLimit.operations[operation][key] = Number(environment[prefix + suffix]);
    }
  }
  return settings;
}

module.exports = { importLegacy, LEGACY };
