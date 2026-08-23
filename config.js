'use strict';

const fs = require('node:fs');
const path = require('node:path');

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
  dataDir: '.',
  trustProxy: false,
  anonymousName: 'Anonymous',
  site: {
    title: 'ChikoChan',
    description:
    'Welcome to ChikoChan!\n\n' +
    'This little imageboard is a place to share whatever is on your mind — cute pictures, random thoughts, memes, art, games, hobbies, and more.\n\n' +
    'Some boards have specific categories, so please make sure your posts fit the board and follow the rules: https://boards.chiko.cc/rules\n\n' +
    'Feel free to stay and have fun! ^-^',
    announcement: 'The ui post being strange.. I\'ll fix it up soon, sowwy!!'
  },
  limits: {
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
    processTimeoutMs: 15 * 1000,
    thumbnailMaxWidth: 320,
    thumbnailMaxHeight: 320,
    thumbnailThresholdBytes: 512 * 1024,
    maxThumbnailBytes: 2 * 1024 * 1024
  },
  lifecycle: {
    staffTrashRetentionDays: 14,
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
  const value = process.env.TRUST_PROXY.trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(value)) return true;
  if (['0', 'false', 'no', ''].includes(value)) return false;
  return process.env.TRUST_PROXY;
}

function envBoolean(name, fallback) {
  if (process.env[name] === undefined) return fallback;
  const value = process.env[name].trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(value)) return true;
  if (['0', 'false', 'no', ''].includes(value)) return false;
  throw new Error(`${name} must be true or false.`);
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
  const hasInjectedAdminPassword = Object.hasOwn(overrides, 'adminPassword');
  const hasInjectedAdminSecret = Object.hasOwn(overrides, 'adminSessionSecret');
  const hasInjectedTurnstileSecret = Object.hasOwn(overrides.antiAbuse?.turnstile || {}, 'secretKey');
  let config = mergeConfig(DEFAULTS, fromFile);

  config = mergeConfig(config, {
    host: process.env.HOST || config.host,
    port: envNumber('PORT', config.port),
    storage: process.env.STORAGE || config.storage,
    dataDir: process.env.DATA_DIR || config.dataDir,
    mongoUrl: process.env.MONGO_URL || process.env.MONGODB_URI || config.mongoUrl,
    mongoDbName: process.env.MONGO_DB_NAME || config.mongoDbName,
    trustProxy: envTrustProxy(config.trustProxy),
    media: {
      ffprobePath: process.env.FFPROBE_PATH || config.media.ffprobePath,
      ffmpegPath: process.env.FFMPEG_PATH || config.media.ffmpegPath
    },
    lifecycle: {
      staffTrashRetentionDays: envNumber(
        'STAFF_TRASH_RETENTION_DAYS',
        config.lifecycle.staffTrashRetentionDays
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
      maxVideoBytes: envNumber('MAX_VIDEO_BYTES', config.limits.maxVideoBytes),
      maxFilesPerPost: envNumber('MAX_FILES_PER_POST', config.limits.maxFilesPerPost),
      postRateWindowMs: envNumber('POST_RATE_WINDOW_MS', config.limits.postRateWindowMs),
      postRateLimit: envNumber('POST_RATE_LIMIT', config.limits.postRateLimit)
    }
  });
  config = mergeConfig(config, overrides);

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

  if (!['mongodb', 'json'].includes(config.storage)) {
    throw new Error('storage must be either "mongodb" or "json".');
  }

  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error('port must be an integer between 0 and 65535.');
  }

  const positiveLimits = [
    'maxFileBytes', 'maxVideoBytes', 'maxFilesPerPost', 'maxImageDimension', 'maxImagePixels',
    'maxVideoDimension', 'maxVideoPixels', 'maxVideoDurationSeconds', 'maxVideoFrameRate',
    'maxNameLength', 'maxSubjectLength', 'maxCommentLength',
    'maxCommentLines', 'maxLinks', 'maxCites', 'maxBoardRules', 'maxBoardRuleLength',
    'maxStaffAccounts', 'maxThreads', 'threadsPerPage', 'previewReplies', 'bumpLimit', 'replyLimit',
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
  if (!Number.isInteger(config.maintenance.startupDelayMs) || config.maintenance.startupDelayMs < 0) {
    throw new Error('maintenance.startupDelayMs must be a non-negative integer.');
  }
  for (const key of ['intervalMs', 'leaseMs']) {
    if (!Number.isInteger(config.maintenance[key]) || config.maintenance[key] < 10000) {
      throw new Error(`maintenance.${key} must be an integer of at least 10000.`);
    }
  }
  for (const key of ['staffTrashRetentionDays', 'maxRevisionsPerPost']) {
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
