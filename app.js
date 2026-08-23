'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./config');
const { AdminAuth } = require('./lib/admin-auth');
const { TURNSTILE_ORIGIN, TurnstileAdapter } = require('./lib/anti-abuse');
const { apiBoards, apiCatalog, apiThread, apiThreads } = require('./lib/api');
const { BoardService, findPost } = require('./lib/board');
const { MongoStore } = require('./lib/mongo-store');
const { MaintenanceRunner } = require('./lib/maintenance');
const { Renderer } = require('./lib/render');
const { staffCan } = require('./lib/staff');
const { JsonStore } = require('./lib/store');
const { HookRegistry } = require('./lib/hooks');
const { Translator } = require('./lib/i18n');
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

function optionalBoolean(value) {
  if (String(value) === '1') return true;
  if (String(value) === '0') return false;
  return undefined;
}

function optionalPositiveInteger(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== String(value).trim()) {
    throw httpError(400, 'Board limit overrides must be positive integers.');
  }
  return parsed;
}

function createApp(overrides = {}) {
  const config = loadConfig(overrides);
  const store = overrides.store || (config.storage === 'json' ? new JsonStore(config) : new MongoStore(config));
  store.ready ||= Promise.resolve(store);
  const uploads = new UploadManager(config);
  const hooks = new HookRegistry(config, overrides.extensionHooks, { logger: overrides.logger });
  const i18n = new Translator(config, overrides.translations);
  const service = new BoardService(config, store, uploads);
  const renderer = new Renderer(config, () => store.cache || service.getData(), i18n);
  const admin = new AdminAuth(config);
  const antiAbuse = new TurnstileAdapter(config, {
    fetchImpl: overrides.turnstileFetch,
    logger: overrides.logger
  });
  const maintenance = new MaintenanceRunner(config, store, service, { logger: overrides.logger });
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
      "media-src 'self'",
      "object-src 'none'",
      antiAbuse.enabled ? `script-src 'self' ${TURNSTILE_ORIGIN}` : "script-src 'self'",
      antiAbuse.enabled ? `frame-src ${TURNSTILE_ORIGIN}` : "frame-src 'none'",
      "style-src 'self'"
    ].join('; '));
    next();
  });

  const moderationHookActions = new Map([
    ['/admin/delete', 'post-delete'],
    ['/admin/edit', 'post-edit'],
    ['/admin/thread-setting', 'thread-setting'],
    ['/admin/sanction', 'sanction-create'],
    ['/admin/unban', 'sanction-lift'],
    ['/admin/reports/resolve', 'report-resolve'],
    ['/admin/reports/reopen', 'report-reopen'],
    ['/admin/trash/restore', 'trash-restore'],
    ['/admin/trash/purge', 'trash-purge'],
    ['/admin/boards/add', 'board-add'],
    ['/admin/boards/edit', 'board-edit'],
    ['/admin/boards/delete', 'board-delete']
  ]);
  app.use((request, response, next) => {
    const action = request.method === 'POST' ? moderationHookActions.get(request.path) : '';
    if (action) {
      response.on('finish', () => {
        if (!request.staff || response.statusCode < 200 || response.statusCode >= 400) return;
        hooks.notify('moderationAction', {
          action,
          boardUri: String(request.body?.board || request.body?.uri || ''),
          actorRole: String(request.staff.role || '')
        });
      });
    }
    next();
  });

  const standardFormParser = express.urlencoded({ extended: false, limit: '24kb', parameterLimit: 64 });
  const staffFormParser = express.urlencoded({ extended: false, limit: '24kb', parameterLimit: 256 });
  app.use((request, response, next) => {
    const parser = request.path.startsWith('/admin/staff') ? staffFormParser : standardFormParser;
    parser(request, response, next);
  });

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

  app.get('/custom.css', (request, response) => {
    response.type('text/css');
    response.setHeader('Cache-Control', 'no-cache');
    response.send(renderer.customStyles());
  });

  app.get('/banner.png', (request, response, next) => {
    const bannerPath = path.join(config.rootDir, 'banner.png');
    if (!fs.existsSync(bannerPath)) return next();
    response.setHeader('Cache-Control', 'public, max-age=3600');
    response.sendFile(bannerPath);
  });

  function serveUpload(request, response) {
    const media = uploads.inspectServedFile(request.params.filename);
    if (!media) {
      response.status(404).send('Not found');
      return;
    }
    response.type(media.mime);
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    response.sendFile(media.filePath, { acceptRanges: true });
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
    const latestPosts = service.latestPosts(30, data);
    const latestImages = service.latestImages(24, data);
    response.send(renderer.home(data, boards, siteStats, latestPosts, latestImages));
  }

  app.get(['/', '/index.html'], renderHome);

  for (const [key, page] of Object.entries(config.site?.pages || {})) {
    app.get(`/${key}`, (request, response) => {
      response.send(renderer.page(key, page));
    });
  }

  app.get('/pages/:slug', (request, response) => {
    const page = service.getCustomPage(request.params.slug);
    if (!page) throw httpError(404, 'Page not found.');
    response.send(renderer.page(page.slug, page));
  });

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

  function postHandler(forceReply = false, staffOnly = false) {
    return async (request, response, next) => {
      const files = uploads.filesFromRequest(request);
      const media = [];
      try {
        const boardUri = request.board?.uri || request.body.board;
        let board = boardUri ? service.getBoard(boardUri) : null;
        if (!board) board = service.getDefaultBoard();
        if (!board || !board.enabled) throw httpError(404, 'Board not found.');

        if (String(request.body.website || '').trim()) throw httpError(400, 'Post rejected.');
        if (!staffOnly && request.body.capcode !== undefined) {
          throw httpError(403, 'Capcodes require the authenticated staff posting form.');
        }
        if (staffOnly) {
          requireCsrf(request);
          requirePermission(request, 'posts.capcode', board.id);
        }
        if (!staffOnly) {
          await antiAbuse.verify(request.body['cf-turnstile-response']);
        }

        for (const file of files) {
          await hooks.runBlocking('beforeUpload', {
            boardUri: board.uri,
            staff: staffOnly,
            extension: path.extname(String(file.originalname || '')).toLowerCase(),
            declaredMime: String(file.mimetype || '').toLowerCase(),
            bytes: Number(file.size) || 0
          });
          const candidate = await uploads.validate(file);
          media.push(candidate);
          hooks.notify('afterUpload', {
            boardUri: board.uri,
            staff: staffOnly,
            kind: candidate.mediaKind,
            mime: candidate.imageMime,
            bytes: candidate.imageBytes,
            sha256: candidate.sha256
          });
        }
        const threadId = Number.parseInt(request.body.threadId || request.body.resto, 10) || 0;
        await hooks.runBlocking('beforePost', {
          boardUri: board.uri,
          threadId,
          isThread: !(forceReply || threadId),
          staff: staffOnly,
          text: {
            name: String(request.body.name || ''),
            subject: String(request.body.title || request.body.subject || request.body.sub || ''),
            comment: String(request.body.comment || request.body.com || '')
          },
          attachments: media.map(candidate => ({
            kind: candidate.mediaKind,
            mime: candidate.imageMime,
            bytes: candidate.imageBytes,
            sha256: candidate.sha256
          }))
        });
        const capcodeValues = Array.isArray(request.body.capcode)
          ? request.body.capcode
          : [request.body.capcode];
        const context = {
          clientKey: clientKey(request),
          ...(staffOnly ? {
            actor: request.staff,
            capcode: capcodeValues.includes('1')
          } : {})
        };
        const result = await (forceReply || threadId
          ? service.createReply(threadId, request.body, media, { ...context, boardUri: board.uri })
          : service.createThread(request.body, media, { ...context, boardId: board.id }));
        hooks.notify('afterPost', {
          boardUri: board.uri,
          threadId: result.threadId,
          postId: result.id,
          isThread: result.id === result.threadId,
          staff: staffOnly,
          attachmentCount: media.length
        });
        const location = `${renderer.threadPath(board, result.threadId)}#p${result.id}`;
        if (isJsonRequest(request)) {
          response.status(201).json({ ok: true, id: result.id, threadId: result.threadId, url: location });
        } else {
          response.redirect(303, safeRedirect(request.body.redirectTo, location));
        }
      } catch (error) {
        for (const candidate of media) uploads.removeCandidate(candidate);
        for (const file of files) uploads.removePath(file?.path);
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
      const report = await service.reportPost(request.body.postId, request.body.reason, {
        category: request.body.category,
        clientKey: clientKey(request)
      });
      hooks.notify('reportCreated', {
        reportId: report.id,
        boardId: report.boardId,
        threadId: report.threadId,
        postId: report.postId,
        category: report.category,
        reason: report.reason
      });
      if (isJsonRequest(request)) response.status(201).json({ ok: true, reportId: report.id });
      else {
        const destination = safeRedirect(request.body.redirectTo, '/');
        response.status(201).send(renderer.message('Report submitted', 'Thank you. A moderator can now review this post.', service.getSiteStats(), destination));
      }
    } catch (error) {
      next(error);
    }
  });

  app.get('/appeals/:appealId', (request, response, next) => {
    try {
      const context = service.getAppealContext(request.params.appealId);
      if (!context) throw httpError(404, 'Appeal link not found.');
      response.setHeader('Cache-Control', 'no-store');
      response.send(renderer.appeal(context));
    } catch (error) {
      next(error);
    }
  });

  app.post('/appeals/:appealId', rateLimit(reportLimiter), async (request, response, next) => {
    try {
      await service.submitAppeal(request.params.appealId, request.body.message);
      response.redirect(303, `/appeals/${encodeURIComponent(request.params.appealId)}`);
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
    const staff = service.resolveStaffSession(session);
    if (!staff) {
      admin.clearCookie(request, response);
      response.redirect(303, '/admin/login');
      return;
    }
    request.adminSession = session;
    request.staff = staff;
    response.setHeader('Cache-Control', 'no-store');
    next();
  }

  function requireCsrf(request) {
    if (!admin.verifyCsrf(request)) throw httpError(403, 'Invalid admin form token.');
  }

  function requirePermission(request, permission, boardId = '') {
    if (!staffCan(request.staff, permission, boardId)) {
      throw httpError(403, 'Your staff account does not have permission for that action.');
    }
  }

  function targetForPost(postId, data = service.getData()) {
    const target = findPost(data, postId);
    if (!target) throw httpError(404, 'Post not found.');
    return target;
  }

  function reportById(reportId, data = service.getData()) {
    const report = data.reports.find(item => item.id === String(reportId || ''));
    if (!report) throw httpError(404, 'Report not found.');
    return report;
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

  app.post('/admin/login', async (request, response, next) => {
    try {
      if (!admin.configured) throw httpError(404, 'Not found.');
      adminLoginLimiter.check(clientKey(request));
      const username = String(request.body.username || '').trim();
      const account = username
        ? await service.authenticateStaff(username, request.body.password)
        : null;
      const legacyLogin = !username && admin.verifyPassword(request.body.password);
      if (!account && !legacyLogin) {
        response.status(401).send(renderer.adminLogin('Wrong username or password.'));
        return;
      }
      admin.setCookie(request, response, admin.createToken(account ? {
        accountId: account.id,
        sessionVersion: account.sessionVersion
      } : {}));
      response.redirect(303, '/admin');
    } catch (error) {
      next(error);
    }
  });

  app.get('/admin', requireAdmin, (request, response) => {
    requirePermission(request, 'dashboard.view');
    response.send(renderer.adminDashboard(
      service.moderationDataFor(request.staff),
      admin.csrf(request.adminSession),
      request.staff
    ));
  });

  app.get('/admin/boards', requireAdmin, (request, response) => {
    requirePermission(request, 'boards.manage');
    const data = service.getData();
    response.send(renderer.adminBoards(
      data.boards,
      service.getDefaultBoard(data).id,
      admin.csrf(request.adminSession),
      request.staff
    ));
  });

  app.get('/admin/reports', requireAdmin, (request, response) => {
    requirePermission(request, 'reports.manage');
    response.send(renderer.adminReports(service.moderationDataFor(request.staff), admin.csrf(request.adminSession), {
      status: String(request.query.status || ''),
      boardId: String(request.query.board || '')
    }, request.staff));
  });

  app.get('/admin/appeals', requireAdmin, (request, response) => {
    requirePermission(request, 'reports.manage');
    response.send(renderer.adminAppeals(
      service.moderationDataFor(request.staff),
      admin.csrf(request.adminSession),
      { status: String(request.query.status || '') },
      request.staff
    ));
  });

  app.get('/admin/trash', requireAdmin, (request, response) => {
    requirePermission(request, 'posts.delete');
    response.send(renderer.adminTrash(
      service.moderationDataFor(request.staff),
      admin.csrf(request.adminSession),
      request.staff
    ));
  });

  app.get('/admin/revisions', requireAdmin, (request, response) => {
    requirePermission(request, 'posts.edit');
    response.send(renderer.adminRevisions(
      service.moderationDataFor(request.staff),
      admin.csrf(request.adminSession),
      { postId: request.query.postId },
      request.staff
    ));
  });

  app.get('/admin/customization', requireAdmin, (request, response) => {
    requirePermission(request, 'site.manage');
    response.send(renderer.adminCustomization(
      service.getCustomization(),
      admin.csrf(request.adminSession)
    ));
  });

  app.get('/admin/staff', requireAdmin, (request, response) => {
    requirePermission(request, 'staff.manage');
    const data = service.getData();
    response.send(renderer.adminStaff(
      service.getStaffAccounts(data),
      data.boards,
      admin.csrf(request.adminSession),
      request.staff
    ));
  });

  app.get('/admin/account', requireAdmin, (request, response) => {
    requirePermission(request, 'dashboard.view');
    response.send(renderer.adminAccount(request.staff, admin.csrf(request.adminSession)));
  });

  app.get('/admin/post', requireAdmin, (request, response) => {
    const board = request.query.board
      ? service.getBoard(request.query.board)
      : service.getBoards().find(candidate => staffCan(request.staff, 'posts.capcode', candidate.id));
    if (!board || !board.enabled) throw httpError(404, 'Board not found.');
    requirePermission(request, 'posts.capcode', board.id);
    const threadId = Number.parseInt(request.query.threadId, 10) || 0;
    const thread = threadId ? service.getThread(threadId) : null;
    if (threadId && (!thread || thread.boardId !== board.id)) throw httpError(404, 'Thread not found.');
    if (thread?.archived) throw httpError(409, 'Archived threads are read-only.');
    response.send(renderer.adminPostForm(board, thread, admin.csrf(request.adminSession), request.staff));
  });

  app.post('/admin/post', requireAdmin, rateLimit(postLimiter), uploads.middleware, postHandler(false, true));

  app.get('/admin/boards/:uri/rules', requireAdmin, (request, response) => {
    requirePermission(request, 'boards.manage');
    const board = service.getBoard(request.params.uri);
    if (!board) throw httpError(404, 'Board not found.');
    response.send(renderer.adminBoardRules(board, admin.csrf(request.adminSession)));
  });

  app.get('/admin/boards/:uri/settings', requireAdmin, (request, response) => {
    requirePermission(request, 'boards.manage');
    const board = service.getBoard(request.params.uri);
    if (!board) throw httpError(404, 'Board not found.');
    response.send(renderer.adminBoardSettings(board, admin.csrf(request.adminSession)));
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
      const target = targetForPost(request.body.postId);
      requirePermission(request, 'posts.delete', target.thread.boardId);
      await service.adminDelete(request.body.postId, {
        actor: request.staff,
        fileOnly: String(request.body.fileOnly || '') === '1',
        attachmentId: request.body.attachmentId,
        reason: request.body.reason
      });
      response.redirect(303, '/admin');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/trash/restore', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      requirePermission(request, 'posts.delete');
      await service.restoreTrash(request.body.trashId, { actor: request.staff });
      response.redirect(303, '/admin/trash');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/trash/purge', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      requirePermission(request, 'posts.delete');
      await service.purgeExpiredTrash({ actor: request.staff });
      response.redirect(303, '/admin/trash');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/customization', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      requirePermission(request, 'site.manage');
      const theme = Object.fromEntries(Object.entries(request.body)
        .filter(([key]) => key.startsWith('theme_'))
        .map(([key, value]) => [key.slice(6), value]));
      await service.updateCustomization({ ...request.body, theme }, { actor: request.staff });
      response.redirect(303, '/admin/customization');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/customization/pages/add', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      requirePermission(request, 'site.manage');
      await service.addCustomPage(request.body, { actor: request.staff });
      response.redirect(303, '/admin/customization');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/customization/pages/edit', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      requirePermission(request, 'site.manage');
      await service.updateCustomPage(request.body.pageId, request.body, { actor: request.staff });
      response.redirect(303, '/admin/customization');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/customization/pages/delete', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      requirePermission(request, 'site.manage');
      await service.deleteCustomPage(request.body.pageId, { actor: request.staff });
      response.redirect(303, '/admin/customization');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/edit', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      const target = targetForPost(request.body.postId);
      requirePermission(request, 'posts.edit', target.thread.boardId);
      const result = await service.editPost(request.body.postId, {
        title: request.body.title,
        comment: request.body.comment,
        reason: request.body.reason
      }, { actor: request.staff });
      response.redirect(303, `${renderer.threadPath(service.getBoardById(target.thread.boardId), result.threadId)}#p${result.postId}`);
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/thread-setting', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      const thread = service.getThread(request.body.threadId);
      if (!thread) throw httpError(404, 'Thread not found.');
      requirePermission(request, 'threads.manage', thread.boardId);
      await service.setThreadFlag(
        request.body.threadId,
        request.body.flag,
        request.body.value === '1',
        { actor: request.staff }
      );
      response.redirect(303, '/admin');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/dismiss-report', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      const report = reportById(request.body.reportId);
      requirePermission(request, 'reports.manage', report.boardId);
      await service.dismissReport(request.body.reportId, { actor: request.staff });
      response.redirect(303, '/admin');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/reports/resolve', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      const report = reportById(request.body.reportId);
      requirePermission(request, 'reports.manage', report.boardId);
      await service.resolveReport(
        request.body.reportId,
        request.body.resolution,
        request.body.note,
        { actor: request.staff }
      );
      response.redirect(303, '/admin/reports');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/reports/reopen', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      const report = reportById(request.body.reportId);
      requirePermission(request, 'reports.manage', report.boardId);
      await service.reopenReport(request.body.reportId, { actor: request.staff });
      response.redirect(303, '/admin/reports?status=closed');
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
      const target = targetForPost(request.body.postId);
      requirePermission(request, 'bans.manage', target.thread.boardId);
      await service.banPost(request.body.postId, duration, request.body.reason, { actor: request.staff });
      response.redirect(303, '/admin');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/sanction', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      const allowedDurations = new Set([0, 3600000, 86400000, 604800000]);
      const duration = Number(request.body.duration);
      if (!allowedDurations.has(duration)) throw httpError(400, 'Invalid sanction duration.');
      const target = targetForPost(request.body.postId);
      requirePermission(request, 'bans.manage', target.thread.boardId);
      const visibleValues = Array.isArray(request.body.reasonVisible)
        ? request.body.reasonVisible
        : [request.body.reasonVisible];
      await service.sanctionPost(request.body.postId, {
        kind: request.body.kind,
        target: request.body.target,
        scope: request.body.scope,
        fileHash: request.body.fileHash,
        durationMs: duration,
        reason: request.body.reason,
        reasonVisible: visibleValues.includes('1'),
        moderatorNote: request.body.moderatorNote
      }, { actor: request.staff });
      response.redirect(303, '/admin');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/unban', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      const data = service.getData();
      const ban = data.bans.find(item => item.id === request.body.banId);
      if (!ban) throw httpError(404, 'Ban not found.');
      requirePermission(request, 'bans.manage', ban.boardId || '');
      await service.unban(request.body.banId, { actor: request.staff });
      response.redirect(303, '/admin');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/appeals/resolve', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      requirePermission(request, 'reports.manage');
      await service.resolveAppeal(
        request.body.appealId,
        request.body.decision,
        request.body.note,
        { actor: request.staff }
      );
      response.redirect(303, '/admin/appeals');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/boards/add', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      requirePermission(request, 'boards.manage');
      await service.addBoard(request.body, { actor: request.staff });
      response.redirect(303, '/admin/boards');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/boards/edit', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      requirePermission(request, 'boards.manage');
      const changes = {
        uri: request.body.newUri,
        name: request.body.name,
        description: request.body.description,
        category: request.body.category,
        enabled: request.body.enabled
      };
      if (request.body.settingsForm === '1') {
        changes.settings = {
          requireImageForThread: optionalBoolean(request.body.requireImageForThread),
          allowVideoUploads: optionalBoolean(request.body.allowVideoUploads),
          allowSpoilers: optionalBoolean(request.body.allowSpoilers),
          showPosterIds: optionalBoolean(request.body.showPosterIds),
          allowSage: optionalBoolean(request.body.allowSage),
          rejectDuplicateImages: optionalBoolean(request.body.rejectDuplicateImages),
          maxThreads: optionalPositiveInteger(request.body.maxThreads),
          bumpLimit: optionalPositiveInteger(request.body.bumpLimit),
          replyLimit: optionalPositiveInteger(request.body.replyLimit),
          maxFilesPerPost: optionalPositiveInteger(request.body.maxFilesPerPost),
          anonymousName: request.body.anonymousName
        };
        changes.appearance = {
          bannerText: request.body.bannerText,
          bannerPath: request.body.bannerPath,
          theme: Object.fromEntries(Object.entries(request.body)
            .filter(([key]) => key.startsWith('boardTheme_'))
            .map(([key, value]) => [key.slice(11), value]))
        };
      }
      await service.updateBoard(request.body.uri, changes, { actor: request.staff });
      response.redirect(303, request.body.settingsForm === '1'
        ? `/admin/boards/${encodeURIComponent(request.body.uri)}/settings`
        : '/admin/boards');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/boards/toggle', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      requirePermission(request, 'boards.manage');
      await service.toggleBoard(request.body.uri, { actor: request.staff });
      response.redirect(303, '/admin/boards');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/boards/move', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      requirePermission(request, 'boards.manage');
      await service.moveBoard(request.body.uri, request.body.direction, { actor: request.staff });
      response.redirect(303, '/admin/boards');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/boards/rules/add', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      requirePermission(request, 'boards.manage');
      const rule = await service.addBoardRule(request.body.uri, request.body.text, { actor: request.staff });
      const board = service.getBoard(request.body.uri);
      response.redirect(303, `/admin/boards/${encodeURIComponent(board.uri)}/rules#rule-${encodeURIComponent(rule.id)}`);
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/boards/rules/edit', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      requirePermission(request, 'boards.manage');
      const rule = await service.updateBoardRule(
        request.body.uri,
        request.body.ruleId,
        request.body.text,
        { actor: request.staff }
      );
      const board = service.getBoard(request.body.uri);
      response.redirect(303, `/admin/boards/${encodeURIComponent(board.uri)}/rules#rule-${encodeURIComponent(rule.id)}`);
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/boards/rules/delete', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      requirePermission(request, 'boards.manage');
      await service.deleteBoardRule(request.body.uri, request.body.ruleId, { actor: request.staff });
      const board = service.getBoard(request.body.uri);
      response.redirect(303, `/admin/boards/${encodeURIComponent(board.uri)}/rules`);
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/boards/delete', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      requirePermission(request, 'boards.manage');
      await service.deleteBoard(request.body.uri, { actor: request.staff });
      response.redirect(303, '/admin/boards');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/staff/add', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      requirePermission(request, 'staff.manage');
      await service.addStaffAccount(request.body, request.staff);
      response.redirect(303, '/admin/staff');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/staff/edit', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      requirePermission(request, 'staff.manage');
      const account = await service.updateStaffAccount(request.body.accountId, request.body, request.staff);
      if (account.id === request.staff.id && account.sessionVersion !== request.staff.sessionVersion) {
        admin.clearCookie(request, response);
        response.redirect(303, '/admin/login');
        return;
      }
      response.redirect(303, '/admin/staff');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/staff/toggle', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      requirePermission(request, 'staff.manage');
      await service.toggleStaffAccount(request.body.accountId, request.staff);
      response.redirect(303, '/admin/staff');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/account', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      requirePermission(request, 'dashboard.view');
      if (request.staff.legacy) throw httpError(400, 'The environment administrator is configured through environment variables.');
      const account = await service.updateStaffAccount(request.staff.id, {
        displayName: request.body.displayName,
        password: request.body.password,
        role: request.staff.role,
        scope: request.staff.scope,
        boardIds: request.staff.boardIds
      }, request.staff);
      if (account.sessionVersion !== request.staff.sessionVersion) {
        admin.clearCookie(request, response);
        response.redirect(303, '/admin/login');
        return;
      }
      response.redirect(303, '/admin/account');
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
    app.get('/:boardUri/rules.json', (request, response) => {
      apiResponse(response, request.board.rules.map(rule => rule.text));
    });
    app.get('/:boardUri/catalog.json', (request, response) => {
      const data = service.getData();
      apiResponse(response, apiCatalog(service, data, request.board));
    });
    app.get('/:boardUri/threads.json', (request, response) => {
      const data = service.getData();
      apiResponse(response, apiThreads(service, data, request.board));
    });
    app.get('/:boardUri/archive.json', (request, response) => {
      const data = service.getData();
      apiResponse(response, service.getArchivedThreads(data, request.board.id).map(thread => thread.id));
    });
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
  app.get(['/:boardUri/archive', '/:boardUri/archive.html'], (request, response) => {
    const data = service.getData();
    const threads = service.getArchivedThreads(data, request.board.id);
    response.send(renderer.archive(threads, request.board, service.getStats(data, request.board.uri)));
  });
  app.get(['/:boardUri/rules', '/:boardUri/rules.html'], (request, response) => {
    const data = service.getData();
    const board = service.getBoard(request.board.uri, data);
    response.send(renderer.boardRules(board, service.getStats(data, board.uri)));
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
    const message = isTooLarge
      ? `Uploads are limited to ${Math.max(config.limits.maxFileBytes, config.limits.maxVideoBytes)} bytes.`
      : error.message;
    response.status(status);
    if (isJsonRequest(request)) {
      response.json({ ok: false, error: message, ...(error.appealUrl ? { appealUrl: error.appealUrl } : {}) });
    } else response.send(renderer.message(
      status >= 500 ? 'Server error' : 'Request failed',
      message,
      service.getSiteStats(),
      safeRedirect(request.get('referer'), '/'),
      error.appealUrl ? { actionHref: error.appealUrl, actionLabel: 'Appeal this restriction' } : {}
    ));
  });

  app.locals.chikochan = {
    config,
    store,
    uploads,
    service,
    renderer,
    i18n,
    antiAbuse,
    hooks,
    maintenance
  };
  return app;
}

module.exports = { createApp };
