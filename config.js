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
    description: 'Welcome to /chiko/!\n' +
    'This little imageboard is just a place to post whatever\'s on your mind — cute pictures, random thoughts, memes, art, games, hobbies.\n' +
    'There aren\'t many rules here...\n' +
    'Be kind, no NSFW, don\'t harass or bully people.\n\n' +
    'If you\'re making a thread, don\'t worry if it\'s random. /chiko/ can be anything! Just follow the rules!\n\n' +
    'Feel free to stay and have fun <3',
    announcement: 'ChikoChan just update? What do you guys think? ^^'
  },
  limits: {
    maxFileBytes: 5 * 1024 * 1024,
    maxNameLength: 80,
    maxSubjectLength: 120,
    maxCommentLength: 4000,
    maxCommentLines: 100,
    maxLinks: 20,
    maxCites: 45,
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
    fortunes: true
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
  const hasInjectedAdminPassword = Object.hasOwn(overrides, 'adminPassword');
  const hasInjectedAdminSecret = Object.hasOwn(overrides, 'adminSessionSecret');
  let config = mergeConfig(mergeConfig(DEFAULTS, fromFile), overrides);

  config = mergeConfig(config, {
    host: process.env.HOST || config.host,
    port: envNumber('PORT', config.port),
    dataDir: process.env.DATA_DIR || config.dataDir,
    mongoUrl: process.env.MONGO_URL || process.env.MONGODB_URI || config.mongoUrl,
    mongoDbName: process.env.MONGO_DB_NAME || config.mongoDbName,
    trustProxy: envTrustProxy(config.trustProxy),
    limits: {
      postRateWindowMs: envNumber('POST_RATE_WINDOW_MS', config.limits.postRateWindowMs),
      postRateLimit: envNumber('POST_RATE_LIMIT', config.limits.postRateLimit)
    }
  });

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

  if (!['mongodb', 'json'].includes(config.storage)) {
    throw new Error('storage must be either "mongodb" or "json".');
  }

  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error('port must be an integer between 0 and 65535.');
  }

  const positiveLimits = [
    'maxFileBytes', 'maxNameLength', 'maxSubjectLength', 'maxCommentLength',
    'maxCommentLines', 'maxLinks', 'maxCites', 'maxThreads', 'threadsPerPage',
    'previewReplies', 'bumpLimit', 'replyLimit', 'postRateWindowMs', 'postRateLimit',
    'reportRateWindowMs', 'reportRateLimit'
  ];
  for (const key of positiveLimits) {
    if (!Number.isInteger(config.limits[key]) || config.limits[key] < 1) {
      throw new Error(`limits.${key} must be a positive integer.`);
    }
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

  return config;
}

module.exports = { DEFAULTS, loadConfig, mergeConfig };
