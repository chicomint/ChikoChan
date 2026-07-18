'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./config');
const { AdminAuth } = require('./lib/admin-auth');
const { apiBoards, apiCatalog, apiThread, apiThreads } = require('./lib/api');
const { BoardService } = require('./lib/board');
const { Renderer } = require('./lib/render');
const { JsonStore } = require('./lib/store');
const { UploadManager } = require('./lib/uploads');
const { escapeXML, httpError } = require('./lib/utils');

class MemoryRateLimiter {
  constructor(windowMs, limit, message) {
    this.windowMs = windowMs;
    this.limit = limit;
    this.message = message;
    this.buckets = new Map();
  }

  check(key) {
    const now = Date.now();
    const existing = this.buckets.get(key);
    const bucket = existing && now - existing.startedAt < this.windowMs
      ? existing
      : { startedAt: now, count: 0 };
    if (bucket.count >= this.limit) throw httpError(429, this.message);
    bucket.count += 1;
    this.buckets.set(key, bucket);

    if (this.buckets.size > 1000) {
      for (const [bucketKey, value] of this.buckets) {
        if (now - value.startedAt >= this.windowMs) this.buckets.delete(bucketKey);
      }
    }
  }
}

function clientKey(request) {
  return request.ip || request.socket?.remoteAddress || 'unknown';
}

function isJsonRequest(request) {
  return request.query.json === '1'
    || request.get('accept')?.includes('application/json')
    || request.get('x-requested-with') === 'XMLHttpRequest';
}

function safeRedirect(value, fallback) {
  const candidate = String(value || '');
  return candidate.startsWith('/') && !candidate.startsWith('//') ? candidate : fallback;
}

function createApp(overrides = {}) {
  const config = loadConfig(overrides);
  const store = new JsonStore(config);
  const uploads = new UploadManager(config);
  const service = new BoardService(config, store, uploads);
  const renderer = new Renderer(config);
  const admin = new AdminAuth(config);
  const app = express();
  const postLimiter = new MemoryRateLimiter(
    config.limits.postRateWindowMs,
    config.limits.postRateLimit,
    'Too many posts from this address. Wait a moment and try again.'
  );
  const reportLimiter = new MemoryRateLimiter(
    config.limits.reportRateWindowMs,
    config.limits.reportRateLimit,
    'Too many reports from this address. Try again later.'
  );
  const adminLoginLimiter = new MemoryRateLimiter(5 * 60 * 1000, 5, 'Too many login attempts. Try again later.');

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use((request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data:",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self'"
    ].join('; '));
    next();
  });

  app.use(express.urlencoded({ extended: false, limit: '24kb', parameterLimit: 30 }));

  function staticFile(route, filename, contentType, cacheControl = 'no-cache') {
    app.get(route, (request, response) => {
      if (contentType) response.type(contentType);
      response.setHeader('Cache-Control', cacheControl);
      response.sendFile(path.join(config.rootDir, filename));
    });
  }

  staticFile(['/style.css', `/${config.board.uri}/style.css`], 'style.css', 'text/css');
  staticFile(['/client.js', `/${config.board.uri}/client.js`], 'client.js', 'application/javascript');
  staticFile(['/chikki.ico', '/favicon.ico'], 'chikki.ico', 'image/x-icon', 'public, max-age=86400');

  function serveUpload(request, response) {
    const image = uploads.inspectServedFile(request.params.filename);
    if (!image) {
      response.status(404).send('Not found');
      return;
    }
    response.type(image.mime);
    response.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    response.sendFile(image.filePath);
  }

  app.get('/src/:filename', serveUpload);
  app.get(`/${config.board.uri}/src/:filename`, serveUpload);

  app.get('/healthz', (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json({ status: 'ok' });
  });

  app.get('/readyz', (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    try {
      service.getData();
      fs.accessSync(config.dataDir, fs.constants.R_OK | fs.constants.W_OK);
      fs.accessSync(config.uploadDir, fs.constants.R_OK | fs.constants.W_OK);
      response.json({ status: 'ready' });
    } catch (error) {
      console.error(`Readiness check failed: ${error.message}`);
      response.status(503).json({ status: 'not-ready' });
    }
  });

  function apiResponse(response, value) {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cache-Control', 'no-cache');
    response.json(value);
  }

  if (config.features.api) {
    app.get('/boards.json', (request, response) => apiResponse(response, apiBoards(config)));
    app.get(`/${config.board.uri}/catalog.json`, (request, response) => {
      const data = service.getData();
      apiResponse(response, apiCatalog(service, data));
    });
    app.get(`/${config.board.uri}/threads.json`, (request, response) => {
      const data = service.getData();
      apiResponse(response, apiThreads(service, data));
    });
    app.get(`/${config.board.uri}/archive.json`, (request, response) => apiResponse(response, []));
    app.get(`/${config.board.uri}/index.json`, (request, response) => {
      const page = service.getPage(1);
      apiResponse(response, { threads: page.threads.map(thread => apiThread(thread, page.data, config, true)) });
    });
    app.get(`/${config.board.uri}/thread/:id.json`, (request, response) => {
      const data = service.getData();
      const thread = service.getThread(request.params.id, data);
      if (!thread) throw httpError(404, 'Thread not found.');
      apiResponse(response, apiThread(thread, data, config));
    });
    app.get(`/${config.board.uri}/res/:id.json`, (request, response) => {
      const data = service.getData();
      const thread = service.getThread(request.params.id, data);
      if (!thread) throw httpError(404, 'Thread not found.');
      apiResponse(response, apiThread(thread, data, config));
    });
    const pageApiPattern = new RegExp(`^/${config.board.uri}/(\\d+)\\.json$`);
    app.get(pageApiPattern, (request, response) => {
      const pageNumber = Number(request.params[0]) === 0 ? 1 : request.params[0];
      const page = service.getPage(pageNumber);
      if (!page) throw httpError(404, 'Board page not found.');
      apiResponse(response, { threads: page.threads.map(thread => apiThread(thread, page.data, config, true)) });
    });
  }

  function renderBoardPage(pageNumber, response) {
    const page = service.getPage(pageNumber);
    if (!page) throw httpError(404, 'Board page not found.');
    response.send(renderer.board(page));
  }

  app.get(['/', '/index.html', `/${config.board.uri}/`, `/${config.board.uri}/index.html`], (request, response) => {
    renderBoardPage(1, response);
  });

  const pageHtmlPattern = new RegExp(`^/${config.board.uri}/(\\d+)\\.html$`);
  app.get(pageHtmlPattern, (request, response) => renderBoardPage(request.params[0], response));

  app.get(['/catalog', `/${config.board.uri}/catalog`, `/${config.board.uri}/catalog.html`], (request, response) => {
    const data = service.getData();
    const threads = service.getSortedThreads(data);
    response.send(renderer.catalog(data, threads, service.getStats(data)));
  });

  function renderThread(request, response) {
    const data = service.getData();
    const thread = service.getThread(request.params.id, data);
    if (!thread) throw httpError(404, 'Thread not found.');
    response.send(renderer.thread(thread, data, service.getStats(data)));
  }

  app.get('/thread/:id', renderThread);
  app.get(`/${config.board.uri}/thread/:id`, renderThread);
  app.get(`/${config.board.uri}/res/:id.html`, renderThread);

  if (config.features.search) {
    app.get('/search', (request, response) => {
      const search = service.search(request.query.q);
      const data = search.data || service.getData();
      response.send(renderer.search(search.query, search.results, data, service.getStats(data)));
    });
  }

  if (config.features.rss) {
    app.get('/feed.xml', (request, response) => {
      const data = service.getData();
      const items = service.getSortedThreads(data).slice(0, 20).map(thread => {
        const url = `${request.protocol}://${request.get('host')}${renderer.threadPath(thread.id)}`;
        return `<item><title>${escapeXML(thread.title || `Thread No.${thread.id}`)}</title><link>${escapeXML(url)}</link><guid>${escapeXML(url)}</guid><pubDate>${new Date(thread.createdAt).toUTCString()}</pubDate><description>${escapeXML(thread.comment)}</description></item>`;
      }).join('');
      response.type('application/rss+xml').send(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${escapeXML(config.board.title)}</title><link>${escapeXML(`${request.protocol}://${request.get('host')}/`)}</link><description>${escapeXML(config.board.description)}</description>${items}</channel></rss>`);
    });
  }

  app.get('/robots.txt', (request, response) => response.type('text/plain').send('User-agent: *\nDisallow: /admin\n'));

  function rateLimit(limiter) {
    return (request, response, next) => {
      try {
        limiter.check(clientKey(request));
        next();
      } catch (error) {
        next(error);
      }
    };
  }

  function assertHoneypot(request) {
    if (String(request.body.website || '').trim()) throw httpError(400, 'Post rejected.');
    if (request.body.board && String(request.body.board) !== config.board.uri) {
      throw httpError(400, 'Unknown board.');
    }
  }

  function postHandler(forceReply = false) {
    return (request, response, next) => {
      const file = uploads.fileFromRequest(request);
      try {
        assertHoneypot(request);
        const image = uploads.validate(file);
        const threadId = Number.parseInt(request.body.threadId || request.body.resto, 10) || 0;
        const result = forceReply || threadId
          ? service.createReply(threadId, request.body, image, { clientKey: clientKey(request) })
          : service.createThread(request.body, image, { clientKey: clientKey(request) });
        const location = `${renderer.threadPath(result.threadId)}#p${result.id}`;
        if (isJsonRequest(request)) {
          response.status(201).json({ ok: true, id: result.id, threadId: result.threadId, url: location });
        } else {
          response.redirect(303, location);
        }
      } catch (error) {
        if (file?.path) uploads.removePath(file.path);
        next(error);
      }
    };
  }

  app.post(['/post', '/post.php', `/${config.board.uri}/post`], rateLimit(postLimiter), uploads.middleware, postHandler(false));
  app.post('/reply', rateLimit(postLimiter), uploads.middleware, postHandler(true));

  app.post('/delete', (request, response, next) => {
    try {
      const result = service.deleteByPassword(request.body.postIds, request.body.password || request.body.pwd, Boolean(request.body.fileOnly));
      if (isJsonRequest(request)) response.json({ ok: true, ...result });
      else response.redirect(303, '/');
    } catch (error) {
      next(error);
    }
  });

  app.post('/report', rateLimit(reportLimiter), (request, response, next) => {
    try {
      const report = service.reportPost(request.body.postId, request.body.reason);
      if (isJsonRequest(request)) response.status(201).json({ ok: true, reportId: report.id });
      else {
        const destination = safeRedirect(request.body.redirectTo, '/');
        response.status(201).send(renderer.message('Report submitted', 'Thank you. A moderator can now review this post.', service.getStats(), destination));
      }
    } catch (error) {
      next(error);
    }
  });

  function requireAdmin(request, response, next) {
    if (!admin.configured) {
      response.status(404).send('Not found');
      return;
    }
    const session = admin.readSession(request);
    if (!session) {
      response.redirect(303, '/admin/login');
      return;
    }
    request.adminSession = session;
    response.setHeader('Cache-Control', 'no-store');
    next();
  }

  function requireCsrf(request) {
    if (!admin.verifyCsrf(request)) throw httpError(403, 'Invalid admin form token.');
  }

  app.get('/admin/login', (request, response) => {
    if (!admin.configured) {
      response.status(404).send('Not found');
      return;
    }
    if (admin.readSession(request)) {
      response.redirect(303, '/admin');
      return;
    }
    response.setHeader('Cache-Control', 'no-store');
    response.send(renderer.adminLogin());
  });

  app.post('/admin/login', (request, response, next) => {
    try {
      if (!admin.configured) throw httpError(404, 'Not found.');
      adminLoginLimiter.check(clientKey(request));
      if (!admin.verifyPassword(request.body.password)) {
        response.status(401).send(renderer.adminLogin('Wrong password.'));
        return;
      }
      admin.setCookie(request, response, admin.createToken());
      response.redirect(303, '/admin');
    } catch (error) {
      next(error);
    }
  });

  app.get('/admin', requireAdmin, (request, response) => {
    response.send(renderer.adminDashboard(service.getData(), admin.csrf(request.adminSession)));
  });

  app.post('/admin/logout', requireAdmin, (request, response, next) => {
    try {
      requireCsrf(request);
      admin.clearCookie(request, response);
      response.redirect(303, '/admin/login');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/delete', requireAdmin, (request, response, next) => {
    try {
      requireCsrf(request);
      service.adminDelete(request.body.postId);
      response.redirect(303, '/admin');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/thread-setting', requireAdmin, (request, response, next) => {
    try {
      requireCsrf(request);
      service.setThreadFlag(request.body.threadId, request.body.flag, request.body.value === '1');
      response.redirect(303, '/admin');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/dismiss-report', requireAdmin, (request, response, next) => {
    try {
      requireCsrf(request);
      service.dismissReport(request.body.reportId);
      response.redirect(303, '/admin');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/ban', requireAdmin, (request, response, next) => {
    try {
      requireCsrf(request);
      const allowedDurations = new Set([0, 3600000, 86400000, 604800000]);
      const duration = Number(request.body.duration);
      if (!allowedDurations.has(duration)) throw httpError(400, 'Invalid ban duration.');
      service.banPost(request.body.postId, duration, request.body.reason);
      response.redirect(303, '/admin');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/unban', requireAdmin, (request, response, next) => {
    try {
      requireCsrf(request);
      service.unban(request.body.banId);
      response.redirect(303, '/admin');
    } catch (error) {
      next(error);
    }
  });

  app.use((request, response) => {
    response.status(404).send(renderer.message('Not found', 'That page or thread does not exist.', service.getStats(), '/'));
  });

  app.use((error, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const isTooLarge = error.code === 'LIMIT_FILE_SIZE';
    const status = isTooLarge ? 413 : (Number(error.status) || 400);
    const message = isTooLarge ? `Images are limited to ${config.limits.maxFileBytes} bytes.` : error.message;
    response.status(status);
    if (isJsonRequest(request)) response.json({ ok: false, error: message });
    else response.send(renderer.message(
      status >= 500 ? 'Server error' : 'Request failed',
      message,
      service.getStats(),
      safeRedirect(request.get('referer'), '/')
    ));
  });

  app.locals.chikochan = { config, store, uploads, service, renderer };
  return app;
}

module.exports = { createApp };
