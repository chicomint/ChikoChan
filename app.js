'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./config');
const { AdminAuth } = require('./lib/admin-auth');
const { apiBoards, apiCatalog, apiThread, apiThreads } = require('./lib/api');
const { BoardService } = require('./lib/board');
const { MongoStore } = require('./lib/mongo-store');
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
  const store = overrides.store || (config.storage === 'json' ? new JsonStore(config) : new MongoStore(config));
  store.ready ||= Promise.resolve(store);
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

  staticFile('/style.css', 'style.css', 'text/css');
  staticFile('/client.js', 'client.js', 'application/javascript');
  staticFile(['/chikki.ico', '/favicon.ico'], 'chikki.ico', 'image/x-icon', 'public, max-age=86400');

  app.get('/banner.png', (request, response, next) => {
    const bannerPath = path.join(config.rootDir, 'banner.png');
    if (!fs.existsSync(bannerPath)) return next();
    response.setHeader('Cache-Control', 'public, max-age=3600');
    response.sendFile(bannerPath);
  });

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

  app.get('/healthz', (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json({ status: 'ok' });
  });

  app.use(async (request, response, next) => {
    try {
      await store.ready;
      next();
    } catch (error) {
      next(error);
    }
  });

  app.get('/readyz', async (request, response) => {
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
    app.get('/boards.json', (request, response) => {
      const data = service.getData();
      apiResponse(response, apiBoards(config, data));
    });
  }

  function renderHome(request, response) {
    const data = service.getData();
    const boards = service.getBoards(data);
    const siteStats = service.getSiteStats(data);
    const latestPosts = service.latestPosts(50, data);
    response.send(renderer.home(data, boards, siteStats, latestPosts));
  }

  app.get(['/', '/index.html'], renderHome);

  for (const [key, page] of Object.entries(config.site?.pages || {})) {
    app.get(`/${key}`, (request, response) => {
      response.send(renderer.page(key, page));
    });
  }

  function renderBoardPage(board, pageNumber, response) {
    const page = service.getPage(pageNumber, board.uri);
    if (!page) throw httpError(404, 'Board page not found.');
    response.send(renderer.board(page));
  }

  function renderThread(request, response, boardUri = null) {
    const data = service.getData();
    const thread = service.getThread(request.params.id, data);
    if (!thread) throw httpError(404, 'Thread not found.');
    const board = boardUri
      ? service.getBoard(boardUri, data)
      : service.getBoardById(thread.boardId, data);
    if (!board || !board.enabled || thread.boardId !== board.id) throw httpError(404, 'Thread not found.');
    response.send(renderer.thread(thread, data, board, service.getStats(data, board.uri)));
  }

  app.get('/thread/:id', (request, response) => renderThread(request, response));

  app.get('/catalog', (request, response) => {
    const data = service.getData();
    const board = service.getDefaultBoard(data);
    if (!board) throw httpError(404, 'Board not found.');
    const threads = service.getSortedThreads(data, board.id);
    response.send(renderer.catalog(data, threads, board, service.getStats(data, board.uri)));
  });

  if (config.features.search) {
    app.get('/search', (request, response) => {
      const search = service.search(request.query.q);
      const data = search.data || service.getData();
      response.send(renderer.search(search.query, search.results, data, service.getSiteStats(data)));
    });
  }

  if (config.features.rss) {
    app.get('/feed.xml', (request, response) => {
      const data = service.getData();
      const boardMap = new Map(data.boards.map(board => [board.id, board]));
      const items = service.getSortedThreads(data).slice(0, 20).map(thread => {
        const board = boardMap.get(thread.boardId) || data.boards[0];
        const url = `${request.protocol}://${request.get('host')}${renderer.threadPath(board, thread.id)}`;
        return `<item><title>${escapeXML(thread.title || `Thread No.${thread.id}`)}</title><link>${escapeXML(url)}</link><guid>${escapeXML(url)}</guid><pubDate>${new Date(thread.createdAt).toUTCString()}</pubDate><description>${escapeXML(thread.comment)}</description></item>`;
      }).join('');
      response.type('application/rss+xml').send(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${escapeXML(renderer.siteTitle())}</title><link>${escapeXML(`${request.protocol}://${request.get('host')}/`)}</link><description>${escapeXML(renderer.siteDescription())}</description>${items}</channel></rss>`);
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

  function postHandler(forceReply = false) {
    return async (request, response, next) => {
      const file = uploads.fileFromRequest(request);
      try {
        const boardUri = request.board?.uri || request.body.board;
        let board = boardUri ? service.getBoard(boardUri) : null;
        if (!board) board = service.getDefaultBoard();
        if (!board || !board.enabled) throw httpError(404, 'Board not found.');

        if (String(request.body.website || '').trim()) throw httpError(400, 'Post rejected.');

        const image = uploads.validate(file);
        const threadId = Number.parseInt(request.body.threadId || request.body.resto, 10) || 0;
        const result = await (forceReply || threadId
          ? service.createReply(threadId, request.body, image, { clientKey: clientKey(request), boardUri: board.uri })
          : service.createThread(request.body, image, { clientKey: clientKey(request), boardId: board.id }));
        const location = `${renderer.threadPath(board, result.threadId)}#p${result.id}`;
        if (isJsonRequest(request)) {
          response.status(201).json({ ok: true, id: result.id, threadId: result.threadId, url: location });
        } else {
          response.redirect(303, safeRedirect(request.body.redirectTo, location));
        }
      } catch (error) {
        if (file?.path) uploads.removePath(file.path);
        next(error);
      }
    };
  }

  app.post(['/post', '/post.php'], rateLimit(postLimiter), uploads.middleware, postHandler(false));
  app.post('/reply', rateLimit(postLimiter), uploads.middleware, postHandler(true));

  app.post('/delete', async (request, response, next) => {
    try {
      const result = await service.deleteByPassword(request.body.postIds, request.body.password || request.body.pwd, Boolean(request.body.fileOnly));
      if (isJsonRequest(request)) response.json({ ok: true, ...result });
      else response.redirect(303, safeRedirect(request.body.redirectTo, '/'));
    } catch (error) {
      next(error);
    }
  });

  app.post('/report', rateLimit(reportLimiter), async (request, response, next) => {
    try {
      const report = await service.reportPost(request.body.postId, request.body.reason);
      if (isJsonRequest(request)) response.status(201).json({ ok: true, reportId: report.id });
      else {
        const destination = safeRedirect(request.body.redirectTo, '/');
        response.status(201).send(renderer.message('Report submitted', 'Thank you. A moderator can now review this post.', service.getSiteStats(), destination));
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

  app.get('/admin/boards', requireAdmin, (request, response) => {
    const data = service.getData();
    response.send(renderer.adminBoards(data.boards, service.getDefaultBoard(data).id, admin.csrf(request.adminSession)));
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

  app.post('/admin/delete', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      await service.adminDelete(request.body.postId);
      response.redirect(303, '/admin');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/thread-setting', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      await service.setThreadFlag(request.body.threadId, request.body.flag, request.body.value === '1');
      response.redirect(303, '/admin');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/dismiss-report', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      await service.dismissReport(request.body.reportId);
      response.redirect(303, '/admin');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/ban', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      const allowedDurations = new Set([0, 3600000, 86400000, 604800000]);
      const duration = Number(request.body.duration);
      if (!allowedDurations.has(duration)) throw httpError(400, 'Invalid ban duration.');
      await service.banPost(request.body.postId, duration, request.body.reason);
      response.redirect(303, '/admin');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/unban', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      await service.unban(request.body.banId);
      response.redirect(303, '/admin');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/boards/add', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      await service.addBoard(request.body);
      response.redirect(303, '/admin/boards');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/boards/edit', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      await service.updateBoard(request.body.uri, {
        uri: request.body.newUri,
        name: request.body.name,
        description: request.body.description,
        category: request.body.category,
        enabled: request.body.enabled
      });
      response.redirect(303, '/admin/boards');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/boards/toggle', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      await service.toggleBoard(request.body.uri);
      response.redirect(303, '/admin/boards');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/boards/delete', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      await service.deleteBoard(request.body.uri);
      response.redirect(303, '/admin/boards');
    } catch (error) {
      next(error);
    }
  });

  function resolveBoard(request, response, next, value) {
    const board = service.getBoard(value);
    if (!board || !board.enabled) return next(httpError(404, 'Board not found.'));
    request.board = board;
    next();
  }

  app.param('boardUri', resolveBoard);

  if (config.features.api) {
    app.get('/:boardUri/catalog.json', (request, response) => {
      const data = service.getData();
      apiResponse(response, apiCatalog(service, data, request.board));
    });
    app.get('/:boardUri/threads.json', (request, response) => {
      const data = service.getData();
      apiResponse(response, apiThreads(service, data, request.board));
    });
    app.get('/:boardUri/archive.json', (request, response) => apiResponse(response, []));
    app.get('/:boardUri/index.json', (request, response) => {
      const page = service.getPage(1, request.board.uri);
      if (!page) throw httpError(404, 'Board page not found.');
      apiResponse(response, { threads: page.threads.map(thread => apiThread(thread, page.data, config, request.board, true)) });
    });
    app.get('/:boardUri/thread/:id.json', (request, response) => {
      const data = service.getData();
      const thread = service.getThread(request.params.id, data);
      if (!thread || thread.boardId !== request.board.id) throw httpError(404, 'Thread not found.');
      apiResponse(response, apiThread(thread, data, config, request.board));
    });
    app.get('/:boardUri/res/:id.json', (request, response) => {
      const data = service.getData();
      const thread = service.getThread(request.params.id, data);
      if (!thread || thread.boardId !== request.board.id) throw httpError(404, 'Thread not found.');
      apiResponse(response, apiThread(thread, data, config, request.board));
    });
    app.get('/:boardUri/:page.json', (request, response) => {
      const pageNumber = Number(request.params.page) === 0 ? 1 : request.params.page;
      const page = service.getPage(pageNumber, request.board.uri);
      if (!page) throw httpError(404, 'Board page not found.');
      apiResponse(response, { threads: page.threads.map(thread => apiThread(thread, page.data, config, request.board, true)) });
    });
  }

  app.post('/:boardUri/post', rateLimit(postLimiter), uploads.middleware, postHandler(false));
  app.post('/:boardUri/post.php', rateLimit(postLimiter), uploads.middleware, postHandler(false));

  app.get('/:boardUri/', (request, response) => renderBoardPage(request.board, 1, response));
  app.get('/:boardUri/index.html', (request, response) => renderBoardPage(request.board, 1, response));
  app.get('/:boardUri/catalog', (request, response) => {
    const data = service.getData();
    const threads = service.getSortedThreads(data, request.board.id);
    response.send(renderer.catalog(data, threads, request.board, service.getStats(data, request.board.uri)));
  });
  app.get('/:boardUri/catalog.html', (request, response) => {
    const data = service.getData();
    const threads = service.getSortedThreads(data, request.board.id);
    response.send(renderer.catalog(data, threads, request.board, service.getStats(data, request.board.uri)));
  });
  app.get('/:boardUri/:page.html', (request, response) => renderBoardPage(request.board, request.params.page, response));
  app.get('/:boardUri/thread/:id', (request, response) => renderThread(request, response, request.board.uri));
  app.get('/:boardUri/res/:id.html', (request, response) => renderThread(request, response, request.board.uri));

  app.use((request, response) => {
    response.status(404).send(renderer.message('Not found', 'That page or thread does not exist.', service.getSiteStats(), '/'));
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
      service.getSiteStats(),
      safeRedirect(request.get('referer'), '/')
    ));
  });

  app.locals.chikochan = { config, store, uploads, service, renderer };
  return app;
}

module.exports = { createApp };
