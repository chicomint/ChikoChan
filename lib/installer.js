'use strict';

const crypto = require('node:crypto');
const express = require('express');
const path = require('node:path');
const { parseEnv } = require('node:util');
let MongoClient;
try { ({ MongoClient } = require('mongodb')); } catch { /* The welcome check reports missing support. */ }
const { ENV_FILE } = require('../config');
const {
  PLATFORM_HELP, configurationWritable, environmentLine, installedEnvironment, readEnvironment
} = require('./install-state');
const { escapeHTML, httpError, parseCookies, timingSafeEqualStrings } = require('./utils');

const COOKIE = 'chikochan_install';
const SESSION_TTL = 30 * 60 * 1000;
const STEPS = ['Welcome', 'Storage', 'Site', 'Administrator', 'Finish'];

function installerError(status, message) {
  const error = httpError(status, message);
  error.exposeInstaller = true;
  return error;
}

function validateEnvironmentValue(key, value) {
  try { environmentLine(key, value); }
  catch { throw installerError(400, 'This value contains a combination of quotes that cannot be saved. Change the quotes and try again.'); }
}

function field(body, key, max, { optional = false, multiline = false } = {}) {
  const value = body?.[key];
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || value.length > max
    || (multiline ? /[\u0000-\u0008\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value)
    || (!optional && !value.trim())) {
    throw installerError(400, `Enter a valid ${key} (maximum ${max} characters).`);
  }
  return value;
}

function validateDatabase(body) {
  const mongoUrl = field(body, 'mongoUrl', 2048).trim();
  const mongoDbName = field(body, 'mongoDbName', 63).trim();
  if (!/^mongodb(?:\+srv)?:\/\//.test(mongoUrl) || /\s/.test(mongoUrl)) {
    throw installerError(400, 'Enter a valid mongodb:// or mongodb+srv:// connection string.');
  }
  if (!/^[a-zA-Z0-9_-]{1,63}$/.test(mongoDbName)) {
    throw installerError(400, 'Database names may contain up to 63 letters, numbers, underscores, or hyphens.');
  }
  validateEnvironmentValue('MONGO_URL', mongoUrl);
  return { mongoUrl, mongoDbName };
}

function validateSite(body) {
  const title = field(body, 'siteName', 100).trim();
  const normalizedBody = { ...body };
  if (typeof normalizedBody.siteDescription === 'string') normalizedBody.siteDescription = normalizedBody.siteDescription.replace(/\r\n/g, '\n');
  const description = field(normalizedBody, 'siteDescription', 2000, { optional: true, multiline: true });
  validateEnvironmentValue('SITE_NAME', title);
  validateEnvironmentValue('SITE_DESCRIPTION', description);
  return { title, description };
}

function validateAdministrator(body) {
  const password = field(body, 'password', 256);
  const confirmation = field(body, 'confirmPassword', 256);
  if (password.length < 12) throw installerError(400, 'Use an administrator password of at least 12 characters.');
  if (!timingSafeEqualStrings(password, confirmation)) throw installerError(400, 'Administrator passwords do not match.');
  validateEnvironmentValue('ADMIN_PASSWORD', password);
  return password;
}

async function testMongoConnection(database, { Client = MongoClient } = {}) {
  let client;
  try {
    client = new Client(database.mongoUrl, {
      serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000,
      socketTimeoutMS: 5000, maxPoolSize: 1
    });
    await client.connect();
    await client.db(database.mongoDbName).command({ ping: 1 });
  } catch {
    // Driver errors can contain the complete URI, password, or server details.
    throw installerError(400, 'Could not connect to MongoDB. Check the connection string, database name, credentials, and network access.');
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

function createInstaller({ config, complete, envFile = ENV_FILE, testConnection = testMongoConnection }) {
  const app = express();
  const sessions = new Map();
  const cleanup = setInterval(() => {
    for (const [id, session] of sessions) if (session.expires <= Date.now()) sessions.delete(id);
  }, 60000);
  cleanup.unref();
  let installing = false;
  let completed = false;
  let stopped = false;
  let connections = 0;
  let completion;
  const disabled = /^(true|1|yes)$/i.test(process.env.INSTALLER_DISABLED || '');
  const writable = configurationWritable(envFile);
  const nodeSupported = Number(process.versions.node.split('.')[0]) >= 22;
  const mongoSupported = typeof MongoClient === 'function';
  const usable = !disabled && writable && nodeSupported && mongoSupported;
  const production = config.deployment.environment === 'production';

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  function secure(request) {
    return production || request.secure || config.deployment.publicOrigin.startsWith('https:');
  }
  function clearCookie(request, response) {
    response.setHeader('Set-Cookie', `${COOKIE}=; Path=/install; HttpOnly; SameSite=Strict; Max-Age=0${secure(request) ? '; Secure' : ''}`);
  }
  function externallyConfigured() {
    try { return installedEnvironment(parseEnv(readEnvironment(envFile))); }
    catch { return true; } // A replaced/unsafe configuration must fail closed.
  }

  app.use((request, response, next) => {
    response.set({
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Permitted-Cross-Domain-Policies': 'none',
      'Content-Security-Policy': "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; media-src 'self'; object-src 'none'; script-src 'self'; frame-src 'none'; connect-src 'self'; style-src 'self'"
    });
    const hsts = config.security.hsts;
    if (hsts.enabled && request.secure) {
      response.set('Strict-Transport-Security', `max-age=${hsts.maxAgeSeconds}${hsts.includeSubDomains ? '; includeSubDomains' : ''}${hsts.preload ? '; preload' : ''}`);
    }
    if (completed) return response.redirect(303, '/');
    if (externallyConfigured()) {
      clearCookie(request, response);
      return response.status(409).type('text').send(`Setup is locked because configuration already exists or cannot safely be read. ${PLATFORM_HELP}`);
    }
    if (stopped || (installing && request.path !== '/healthz')) return response.status(503).type('text').send('Setup is busy. Please wait.');
    next();
  });

  app.get('/style.css', (request, response) => response.sendFile(path.join(config.rootDir, 'style.css')));
  app.get('/chikki.ico', (request, response) => response.sendFile(path.join(config.rootDir, 'chikki.ico')));
  app.get('/install/client.js', (request, response) => response.sendFile(path.join(__dirname, 'installer-client.js')));
  app.get('/healthz', (request, response) => response.json({ status: 'ok' }));
  app.get('/readyz', (request, response) => response.status(503).json({ status: 'installation-required' }));

  app.use((request, response, next) => {
    if (request.method !== 'POST') return next();
    try {
      if (request.path !== '/install' && !request.path.startsWith('/install/')) throw installerError(403, 'Invalid setup request.');
      if (['cross-site', 'same-site'].includes(String(request.get('sec-fetch-site') || '').toLowerCase())) {
        throw installerError(403, 'Cross-origin setup request rejected.');
      }
      const origin = request.get('origin');
      const expected = new URL(config.deployment.publicOrigin || `${request.protocol}://${request.get('host')}`).origin;
      if (origin && new URL(origin).origin !== expected) throw installerError(403, 'Cross-origin setup request rejected.');
      next();
    } catch { next(installerError(403, 'Cross-origin setup request rejected.')); }
  });
  app.use(express.urlencoded({ extended: false, limit: '12kb', parameterLimit: 12, inflate: false }));

  function sessionFor(request, response, create = false) {
    const now = Date.now();
    for (const [id, session] of sessions) if (session.expires <= now) sessions.delete(id);
    const cookie = parseCookies(request.headers.cookie)[COOKIE];
    let session = sessions.get(cookie);
    if (!session && create) {
      if (sessions.size >= 20) throw installerError(429, 'Too many setup sessions. Please try again later.');
      const id = crypto.randomBytes(32).toString('hex');
      session = { step: 1, storage: production ? 'mongodb' : 'json', csrf: crypto.randomBytes(32).toString('hex'), expires: now + SESSION_TTL, attempts: [] };
      sessions.set(id, session);
      response.setHeader('Set-Cookie', `${COOKIE}=${id}; Path=/install; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}${secure(request) ? '; Secure' : ''}`);
    }
    if (!session) throw installerError(403, 'Setup session expired. Open /install to begin again.');
    return session;
  }

  function page(response, session, { message = '', error = false } = {}) {
    if (completed) return response.redirect(303, '/');
    const hidden = `<input type="hidden" name="csrf" value="${escapeHTML(session.csrf)}">`;
    const form = (route, body) => `<form method="post" action="/install/${route}">${hidden}${body}</form>`;
    let content;
    if (session.step === 1) {
      const checks = [
        `Node.js ${escapeHTML(process.versions.node)}: ${nodeSupported ? 'supported' : 'Node.js 22 or newer required'}`,
        `Writable configuration: ${writable ? 'ready' : 'unavailable'}`,
        `MongoDB support: ${mongoSupported ? 'ready' : 'unavailable'}`
      ];
      content = `<p>Welcome to ChikoChan. This short setup chooses storage and creates administrator access.</p><ul>${checks.map(check => `<li>${check}</li>`).join('')}</ul>`;
      if (!usable) content += `<p>${escapeHTML(PLATFORM_HELP)}</p>`;
      else content += form('welcome', '<button type="submit">Continue</button>');
    } else if (session.step === 2) {
      content = form('storage', `<fieldset class="installer-storage-options"><legend>Choose how ChikoChan stores its data:</legend>
        <label class="installer-storage-option"><input type="radio" name="storage" value="json"${session.storage === 'json' ? ' checked' : ''}${production ? ' disabled' : ''}><span><strong>Local storage</strong><span>Simple setup. No database server required.</span><span>Data is stored inside <code>./data/</code></span><span>Best for local use and small single-server installations.${production ? ' Unavailable in production mode.' : ''}</span></span></label>
        <label class="installer-storage-option"><input type="radio" name="storage" value="mongodb"${session.storage === 'mongodb' ? ' checked' : ''}><span><strong>MongoDB</strong><span>Recommended for larger/production installations.</span></span></label></fieldset>
        <fieldset id="installer-mongo" class="installer-mongo"${session.storage === 'mongodb' ? '' : ' hidden disabled'}><legend>MongoDB connection</legend><label for="mongoUrl">MongoDB connection string</label><input id="mongoUrl" name="mongoUrl" type="password" maxlength="2048" autocomplete="off" spellcheck="false" placeholder="${session.database ? 'Connection saved; leave blank to keep it' : 'mongodb://localhost:27017/chikochan'}"${session.database ? '' : ' required'}><label for="mongoDbName">Database name</label><input id="mongoDbName" name="mongoDbName" maxlength="63" value="${escapeHTML(session.database?.mongoDbName || 'chikochan')}" required><button name="action" value="test" type="submit">Test Connection</button></fieldset>
        <noscript><p>To use MongoDB, select it and Continue to enter the connection details.</p></noscript><button name="action" value="continue" type="submit">Continue</button>`);
    } else if (session.step === 3) {
      content = form('site', `<label for="siteName">Site name</label><input id="siteName" name="siteName" maxlength="100" value="${escapeHTML(session.site?.title || 'ChikoChan')}" required><label for="siteDescription">Site description (optional)</label><textarea id="siteDescription" name="siteDescription" maxlength="2000" rows="4">${escapeHTML(session.site?.description || '')}</textarea><button type="submit">Continue</button>`);
    } else if (session.step === 4) {
      content = '<p>Choose an administrator password with at least 12 characters.</p>'
        + form('administrator', '<label for="password">Admin password</label><input id="password" name="password" type="password" minlength="12" maxlength="256" autocomplete="new-password" required><label for="confirmPassword">Confirm admin password</label><input id="confirmPassword" name="confirmPassword" type="password" minlength="12" maxlength="256" autocomplete="new-password" required><button type="submit">Continue</button>');
    } else {
      content = `<p>Ready to install <strong>${escapeHTML(session.site.title)}</strong>. ${session.storage === 'json' ? 'Local storage will save data inside ./data/.' : 'MongoDB will be checked again.'} ChikoChan will initialize its default board.</p><p>Setup locks after installation. Keep your .env file private and backed up.</p>`
        + form('finish', '<button type="submit">Install ChikoChan</button>');
    }
    if (session.step > 1) content += form('back', '<button type="submit">Back</button>');
    response.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Install ChikoChan</title><link rel="icon" href="/chikki.ico"><link rel="stylesheet" href="/style.css"><script src="/install/client.js" defer></script></head><body><header><h1><img class="installer-logo" src="/chikki.ico" width="40" height="40" alt=""> ChikoChan</h1><p>First-run setup</p></header><main class="admin-page installer-page"><section class="admin-panel installer-panel"><nav aria-label="Setup progress"><ol class="installer-steps">${STEPS.map((step, index) => `<li${session.step === index + 1 ? ' aria-current="step"' : ''}>${index + 1}. ${step}</li>`).join('')}</ol></nav><h2>${session.step}. ${STEPS[session.step - 1]}</h2>${message ? `<p role="${error ? 'alert' : 'status'}" class="${error ? 'admin-error' : 'admin-muted'}">${escapeHTML(message)}</p>` : ''}${content}</section></main></body></html>`);
  }

  app.get(['/install', '/install/'], (request, response) => page(response, sessionFor(request, response, true)));
  app.use('/install', (request, response, next) => {
    if (request.method !== 'POST') return next();
    if (!usable) throw installerError(503, PLATFORM_HELP);
    const session = sessionFor(request, response);
    if (typeof request.body?.csrf !== 'string' || request.body.csrf.length !== 64
      || !timingSafeEqualStrings(session.csrf, request.body.csrf)) throw installerError(403, 'Invalid setup token. Reload /install.');
    if (session.busy) throw installerError(409, 'A setup request is already running. Please wait.');
    session.busy = true;
    response.on('finish', () => { session.busy = false; });
    response.on('close', () => { session.busy = false; });
    request.installSession = session;
    next();
  });

  function step(request, number) {
    const session = request.installSession;
    if (session.step !== number) throw installerError(409, 'Complete the current setup step first.');
    return session;
  }
  async function checkConnection(session, database) {
    session.attempts = session.attempts.filter(time => time > Date.now() - 60000);
    if (session.attempts.length >= 10 || connections >= 2) throw installerError(429, 'Too many connection checks. Please try again shortly.');
    session.attempts.push(Date.now());
    connections++;
    try { await testConnection(database); }
    finally { connections--; }
  }
  app.post('/install/welcome', (request, response) => {
    step(request, 1).step = 2;
    response.redirect(303, '/install');
  });
  app.post('/install/storage', async (request, response) => {
    const session = step(request, 2);
    const action = field(request.body, 'action', 8);
    if (!['test', 'continue'].includes(action)) throw installerError(400, 'Invalid storage action.');
    const storage = field(request.body, 'storage', 7);
    if (!['json', 'mongodb'].includes(storage)) throw installerError(400, 'Choose Local storage or MongoDB.');
    if (storage === 'json') {
      if (production) throw installerError(400, 'Production requires MongoDB. Choose MongoDB to continue.');
      if (action !== 'continue') throw installerError(400, 'Connection tests are only needed for MongoDB.');
      session.storage = storage;
      delete session.database;
      session.step = 3;
      return response.redirect(303, '/install');
    }
    session.storage = storage;
    // Without JavaScript, the first Mongo selection renders its connection fields.
    if (request.body.mongoUrl === undefined && !session.database) {
      return page(response, session, { message: 'Enter your MongoDB connection details, then test or continue.' });
    }
    const database = validateDatabase({
      mongoUrl: request.body.mongoUrl === '' ? session.database?.mongoUrl : request.body.mongoUrl,
      mongoDbName: request.body.mongoDbName
    });
    delete session.database;
    await checkConnection(session, database);
    session.database = database;
    if (action === 'continue') {
      session.step = 3;
      response.redirect(303, '/install');
    } else page(response, session, { message: 'MongoDB connection successful. Continue to site settings.' });
  });
  app.post('/install/site', (request, response) => {
    const session = step(request, 3);
    session.site = validateSite(request.body);
    session.step = 4;
    response.redirect(303, '/install');
  });
  app.post('/install/administrator', (request, response) => {
    const session = step(request, 4);
    session.password = validateAdministrator(request.body);
    session.step = 5;
    response.redirect(303, '/install');
  });
  app.post('/install/back', (request, response) => {
    const session = request.installSession;
    delete session.password;
    session.step = Math.max(1, session.step - 1);
    response.redirect(303, '/install');
  });
  app.post('/install/finish', async (request, response) => {
    const session = step(request, 5);
    installing = true;
    completion = (async () => {
      const settings = {
        STORAGE: session.storage,
        SITE_NAME: session.site.title, SITE_DESCRIPTION: session.site.description,
        ADMIN_PASSWORD: session.password, ADMIN_SESSION_SECRET: crypto.randomBytes(32).toString('hex')
      };
      if (session.storage === 'mongodb') {
        await checkConnection(session, session.database);
        settings.MONGO_URL = session.database.mongoUrl;
        settings.MONGO_DB_NAME = session.database.mongoDbName;
      } else settings.DATA_DIR = './data';
      await complete(settings);
      completed = true;
      sessions.clear();
      clearInterval(cleanup);
    })();
    try {
      await completion;
      clearCookie(request, response);
      response.redirect(303, '/');
    } finally { installing = false; }
  });
  app.use((request, response) => {
    if (request.method === 'GET' || request.method === 'HEAD') response.redirect(302, '/install');
    else response.sendStatus(405);
  });
  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    const status = [400, 403, 409, 413, 415, 429].includes(error.status) ? error.status : 503;
    // Only our own validation messages are safe; never reflect parser/driver errors.
    const safe = error.exposeInstaller === true;
    const message = safe ? error.message : `Setup could not finish. Check storage access and writable configuration. ${PLATFORM_HELP}`;
    response.status(status);
    if (request.installSession) page(response, request.installSession, { message, error: true });
    else response.type('text').send(message);
  });

  return {
    app,
    async close() {
      stopped = true;
      sessions.clear();
      clearInterval(cleanup);
      if (completion) await completion.catch(() => {});
    }
  };
}

module.exports = { createInstaller, testMongoConnection, validateAdministrator, validateDatabase, validateSite };
