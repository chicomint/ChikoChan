'use strict';

const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./config');
const { AdminAuth } = require('./lib/admin-auth');
const { TURNSTILE_ORIGIN, TurnstileAdapter } = require('./lib/anti-abuse');
const { ClientAddressPolicy } = require('./lib/client-address');
const { apiBoards, apiCatalog, apiThread, apiThreads } = require('./lib/api');
const { BoardService, findPost } = require('./lib/board');
const { MongoStore } = require('./lib/mongo-store');
const { MaintenanceRunner } = require('./lib/maintenance');
const { MediaSafetyService } = require('./lib/media-safety');
const { Renderer } = require('./lib/render');
const { staffCan } = require('./lib/staff');
const { JsonStore } = require('./lib/store');
const { HookRegistry } = require('./lib/hooks');
const { Translator } = require('./lib/i18n');
const { UploadManager } = require('./lib/uploads');
const { escapeXML, httpError } = require('./lib/utils');
const { createAuthorizationNonceStore, PostingAuthorization } = require('./lib/posting-authorization');
const { createRateLimitStore, RateLimiter } = require('./lib/rate-limit');

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
  const uploads = new UploadManager(config, {
    mediaJobQueue: overrides.mediaJobQueue,
    storageAdapter: overrides.mediaStorageAdapter,
    storageFetch: overrides.mediaStorageFetch,
    logger: overrides.logger
  });
  const hooks = new HookRegistry(config, overrides.extensionHooks, { logger: overrides.logger });
  const i18n = new Translator(config, overrides.translations);
  const service = new BoardService(config, store, uploads);
  const mediaSafety = new MediaSafetyService(config, service, {
    provider: overrides.knownIllegalMediaProvider,
    logger: overrides.logger
  });
  const mediaSafetyStatus = mediaSafety.status();
  if (mediaSafetyStatus.configured && !mediaSafetyStatus.provider.available) {
    (overrides.logger || console).warn(
      `Known-illegal-media provider ${mediaSafetyStatus.provider.name} is configured but unavailable.`
    );
    mediaSafety.unavailableWarningEmitted = true;
    if (mediaSafetyStatus.failClosed) {
      throw new Error('Configured known-illegal-media provider is unavailable while fail-closed mode is enabled.');
    }
  }
  const renderer = new Renderer(config, () => store.cache || service.getData(), i18n);
  const admin = new AdminAuth(config);
  const antiAbuse = new TurnstileAdapter(config, {
    fetchImpl: overrides.turnstileFetch,
    logger: overrides.logger
  });
  const maintenance = new MaintenanceRunner(config, store, service, { logger: overrides.logger });
  const clientAddresses = new ClientAddressPolicy(config);
  const rateLimitStore = createRateLimitStore(config, store, overrides);
  const rateLimiter = new RateLimiter(config, rateLimitStore);
  const authorizationNonceStore = createAuthorizationNonceStore(config, store, overrides);
  const postingAuthorization = new PostingAuthorization(config, authorizationNonceStore);
  const app = express();
  const publicMediaOrigin = config.mediaStorage.backend === 'object'
    ? new URL(config.mediaStorage.object.publicBaseUrl).origin
    : '';

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use((request, response, next) => {
    const suppliedRequestId = String(request.get('x-request-id') || '');
    request.id = /^[A-Za-z0-9._-]{8,100}$/.test(suppliedRequestId)
      ? suppliedRequestId
      : crypto.randomUUID();
    response.setHeader('X-Request-Id', request.id);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    if (config.security.hsts.enabled && request.secure) {
      const hsts = [`max-age=${config.security.hsts.maxAgeSeconds}`];
      if (config.security.hsts.includeSubDomains) hsts.push('includeSubDomains');
      if (config.security.hsts.preload) hsts.push('preload');
      response.setHeader('Strict-Transport-Security', hsts.join('; '));
    }
    response.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      `img-src 'self' data:${publicMediaOrigin ? ` ${publicMediaOrigin}` : ''}`,
      `media-src 'self'${publicMediaOrigin ? ` ${publicMediaOrigin}` : ''}`,
      "object-src 'none'",
      antiAbuse.enabled ? `script-src 'self' ${TURNSTILE_ORIGIN}` : "script-src 'self'",
      antiAbuse.enabled ? `frame-src ${TURNSTILE_ORIGIN}` : "frame-src 'none'",
      antiAbuse.enabled ? `connect-src 'self' ${TURNSTILE_ORIGIN}` : "connect-src 'self'",
      "style-src 'self'"
    ].join('; '));
    next();
  });

  app.use((request, response, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      next();
      return;
    }
    try {
      const fetchSite = String(request.get('sec-fetch-site') || '').toLowerCase();
      if (fetchSite === 'cross-site') throw httpError(403, 'Cross-origin mutation rejected.');
      const origin = String(request.get('origin') || '');
      if (origin) {
        const supplied = new URL(origin);
        const expected = config.deployment.publicOrigin
          ? new URL(config.deployment.publicOrigin)
          : new URL(`${request.protocol}://${request.get('host')}`);
        if (supplied.origin !== expected.origin) throw httpError(403, 'Cross-origin mutation rejected.');
      }
      next();
    } catch (error) {
      next(Number(error?.status) ? error : httpError(403, 'Cross-origin mutation rejected.'));
    }
  });

  const moderationHookActions = new Map([
    ['/admin/delete', 'post-delete'],
    ['/admin/edit', 'post-edit'],
    ['/admin/thread-setting', 'thread-setting'],
    ['/admin/sanction', 'sanction-create'],
    ['/admin/unban', 'sanction-lift'],
    ['/admin/media/hash-ban', 'media-hash-ban'],
    ['/admin/media/hash-unban', 'media-hash-unban'],
    ['/admin/reports/resolve', 'report-resolve'],
    ['/admin/reports/reopen', 'report-reopen'],
    ['/admin/trash/restore', 'trash-restore'],
    ['/admin/trash/purge', 'trash-purge'],
    ['/admin/boards/add', 'board-add'],
    ['/admin/boards/edit', 'board-edit'],
    ['/admin/boards/delete', 'board-delete'],
    ['/admin/boards/filters/add', 'board-filter-add'],
    ['/admin/boards/filters/delete', 'board-filter-delete']
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

  async function serveUpload(request, response) {
    const asset = await service.approvedMediaRecord(request.params.filename);
    if (!asset) {
      response.status(404).send('Not found');
      return;
    }
    const delivery = uploads.delivery(request.params.filename);
    if (!delivery) {
      response.status(404).send('Not found');
      return;
    }
    if (delivery.kind === 'redirect') {
      response.setHeader('Cache-Control', 'no-store');
      response.redirect(302, delivery.url);
      return;
    }
    response.type(delivery.mime);
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Cache-Control', 'private, no-cache');
    response.sendFile(delivery.filePath, { acceptRanges: true });
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
      if (typeof store.healthCheck === 'function') await store.healthCheck();
      else service.getData();
      fs.accessSync(config.dataDir, fs.constants.R_OK | fs.constants.W_OK);
      fs.accessSync(config.uploadDir, fs.constants.R_OK | fs.constants.W_OK);
      fs.accessSync(config.quarantineDir, fs.constants.R_OK | fs.constants.W_OK);
      await rateLimitStore.healthCheck();
      if (!await uploads.healthCheck()) throw new Error('Media worker queue is not ready.');
      if (postingAuthorization.enabled) await authorizationNonceStore.healthCheck();
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
    app.get('/boards.json', async (request, response) => {
      const boards = await service.publicBoards();
      apiResponse(response, apiBoards(config, { boards }));
    });
  }

  async function renderHome(request, response) {
    const view = await service.publicHome();
    response.send(renderer.home(
      view.data,
      view.boards,
      view.stats,
      view.latestPosts,
      view.latestImages
    ));
  }

  app.get(['/', '/index.html'], renderHome);

  for (const [key, page] of Object.entries(config.site?.pages || {})) {
    app.get(`/${key}`, (request, response) => {
      response.send(renderer.page(key, page));
    });
  }

  app.get('/pages/:slug', async (request, response) => {
    const page = await service.publicCustomPage(request.params.slug);
    if (!page) throw httpError(404, 'Page not found.');
    response.send(renderer.page(page.slug, page));
  });

  async function renderBoardPage(board, pageNumber, response) {
    const page = await service.publicBoardPage(board, pageNumber);
    if (!page) throw httpError(404, 'Board page not found.');
    response.send(renderer.board(page));
  }

  async function renderThread(request, response, boardId = '') {
    const view = await service.publicThread(request.params.id, boardId);
    if (!view) throw httpError(404, 'Thread not found.');
    response.send(renderer.thread(view.thread, view.data, view.board, view.stats));
  }

  app.get('/thread/:id', (request, response) => renderThread(request, response));

  app.get('/catalog', async (request, response) => {
    const board = await service.publicDefaultBoard();
    if (!board) throw httpError(404, 'Board not found.');
    const view = await service.publicCatalog(board, request.query.page);
    response.send(renderer.catalog(view.data, view.threads, board, view.stats, view));
  });

  async function renderOverboard(request, response, sfw) {
    const view = await service.publicOverboard({
      page: request.query.page,
      sfw,
      tag: request.query.tag
    });
    if (!view) throw httpError(404, 'Overboard page not found.');
    response.send(renderer.overboard(view.entries, view));
  }

  app.get('/overboard', (request, response) => renderOverboard(request, response, false));
  app.get('/overboard/sfw', (request, response) => renderOverboard(request, response, true));

  if (config.features.search) {
    app.get('/search', rateLimit('expensiveRead', 'Too many searches. Wait a moment and try again.'), async (request, response) => {
      const search = await service.publicSearch(request.query.q);
      const stats = service.usesTargetedQueries ? await store.siteStats() : service.getSiteStats(search.data);
      response.send(renderer.search(search.query, search.results, search.data, stats));
    });
  }

  if (config.features.rss) {
    app.get('/feed.xml', async (request, response) => {
      const view = await service.publicHome();
      const items = view.latestPosts.slice(0, 20).map(entry => {
        const url = `${request.protocol}://${request.get('host')}${renderer.threadPath(entry.board, entry.threadId)}#p${entry.post.id}`;
        return `<item><title>${escapeXML(entry.post.title || `Post No.${entry.post.id}`)}</title><link>${escapeXML(url)}</link><guid>${escapeXML(url)}</guid><pubDate>${new Date(entry.post.createdAt).toUTCString()}</pubDate><description>${escapeXML(entry.post.comment)}</description></item>`;
      }).join('');
      response.type('application/rss+xml').send(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${escapeXML(renderer.siteTitle())}</title><link>${escapeXML(`${request.protocol}://${request.get('host')}/`)}</link><description>${escapeXML(renderer.siteDescription())}</description>${items}</channel></rss>`);
    });
  }

  app.get('/robots.txt', (request, response) => response.type('text/plain').send('User-agent: *\nDisallow: /admin\n'));

  function abuseIdentity(request, purpose) {
    return clientAddresses.fingerprint(request, purpose);
  }

  function rateLimit(operation, message) {
    return rateLimiter.middleware(
      operation,
      request => abuseIdentity(request, `rate:${operation}`),
      message
    );
  }

  function staffRateLimit(operation, message) {
    return rateLimiter.middleware(
      operation,
      request => request.staff?.id || abuseIdentity(request, `rate:${operation}`),
      message
    );
  }

  async function postRateLimit(request, response, next) {
    const operation = Number(request.query.threadId) > 0 ? 'replyCreate' : 'threadCreate';
    return rateLimit(operation, 'Too many posts from this address. Wait a moment and try again.')(request, response, next);
  }

  app.get('/posting-authorizations/new', async (request, response, next) => {
    try {
      if (!postingAuthorization.enabled) throw httpError(404, 'Not found.');
      const board = await service.publicBoard(request.query.board);
      if (!board || !board.enabled) throw httpError(404, 'Board not found.');
      const threadId = Number(request.query.threadId) || 0;
      if (!Number.isSafeInteger(threadId) || threadId < 0) throw httpError(400, 'Invalid thread.');
      if (threadId) {
        const thread = (await service.publicThread(threadId, board.id))?.thread;
        if (!thread || thread.boardId !== board.id || thread.locked || thread.archived) {
          throw httpError(404, 'Thread not found.');
        }
      }
      const returnTo = safeRedirect(request.query.returnTo, threadId
        ? `${renderer.threadPath(board, threadId)}#reply-form-${threadId}`
        : `${renderer.boardPath(board)}#post-form`);
      response.setHeader('Cache-Control', 'no-store');
      response.send(renderer.postingAuthorizationPage(board, threadId, returnTo));
    } catch (error) {
      next(error);
    }
  });

  app.post(
    '/posting-authorizations',
    rateLimit('captchaAuthorization', 'Too many posting authorization attempts. Try again later.'),
    async (request, response, next) => {
      try {
        if (!postingAuthorization.enabled) throw httpError(404, 'Not found.');
        const board = await service.publicBoard(request.body.board);
        if (!board || !board.enabled) throw httpError(404, 'Board not found.');
        const threadId = Number(request.body.threadId) || 0;
        if (!Number.isSafeInteger(threadId) || threadId < 0) throw httpError(400, 'Invalid thread.');
        if (threadId) {
          const thread = (await service.publicThread(threadId, board.id))?.thread;
          if (!thread || thread.boardId !== board.id || thread.locked || thread.archived) {
            throw httpError(404, 'Thread not found.');
          }
        }
        await antiAbuse.verify(request.body['cf-turnstile-response']);
        const authorization = await postingAuthorization.issue({
          boardUri: board.uri,
          threadId,
          addressKey: abuseIdentity(request, 'posting-authorization')
        });
        postingAuthorization.setCookie(request, response, authorization.token);
        response.setHeader('Cache-Control', 'no-store');
        if (isJsonRequest(request)) {
          response.status(201).json({
            ok: true,
            token: authorization.token,
            expiresAt: authorization.expiresAt
          });
        } else {
          response.redirect(303, safeRedirect(request.body.returnTo, `/${board.uri}/`));
        }
      } catch (error) {
        next(error);
      }
    }
  );

  async function requirePostingAuthorization(request, response, next) {
    if (!postingAuthorization.enabled) {
      next();
      return;
    }
    try {
      const boardUri = String(request.params.boardUri || request.query.board || '').toLowerCase();
      const rawThreadId = String(request.query.threadId || '0');
      if (!/^\d+$/.test(rawThreadId)) throw httpError(403, 'Posting authorization is required.');
      const threadId = Number(rawThreadId);
      const authorization = await postingAuthorization.consume(request, {
        boardUri,
        threadId,
        addressKey: abuseIdentity(request, 'posting-authorization')
      });
      postingAuthorization.clearCookie(request, response);
      if (!authorization) throw httpError(403, 'Posting authorization is invalid, expired, or already used.');
      request.postAuthorization = authorization;
      next();
    } catch (error) {
      next(error);
    }
  }

  function postHandler(forceReply = false, staffOnly = false) {
    return async (request, response, next) => {
      const files = uploads.filesFromRequest(request);
      const media = [];
      let postCommitted = false;
      try {
        const boardUri = request.board?.uri || request.body.board;
        let board = request.board || (boardUri ? await service.publicBoard(boardUri) : null);
        if (!board) board = await service.publicDefaultBoard();
        if (!board || !board.enabled) throw httpError(404, 'Board not found.');

        const maximumAttachments = service.boardSetting(
          board,
          'maxFilesPerPost',
          config.limits.maxFilesPerPost
        );
        if (files.length > maximumAttachments) {
          throw httpError(400, `This board allows at most ${maximumAttachments} attachment${maximumAttachments === 1 ? '' : 's'} per post.`);
        }

        if (String(request.body.website || '').trim()) throw httpError(400, 'Post rejected.');
        if (!staffOnly && request.body.capcode !== undefined) {
          throw httpError(403, 'Capcodes require the authenticated staff posting form.');
        }
        if (staffOnly) {
          requireCsrf(request);
          requirePermission(request, 'posts.capcode', board.id);
        }
        if (!staffOnly && !postingAuthorization.enabled) {
          await antiAbuse.verify(request.body['cf-turnstile-response']);
        }

        const threadId = Number.parseInt(request.body.threadId || request.body.resto, 10) || 0;
        if (!staffOnly && request.postAuthorization
          && (request.postAuthorization.board !== board.uri
            || Number(request.postAuthorization.thread) !== threadId)) {
          throw httpError(403, 'Posting authorization scope does not match this post.');
        }
        if (!staffOnly && files.length) {
          await rateLimiter.consume(
            'mediaPost',
            abuseIdentity(request, 'rate:mediaPost'),
            'Too many media posts from this address. Try again later.'
          );
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
        await mediaSafety.evaluate(board, media);
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
        await Promise.all(media.map(candidate => uploads.approveCandidate(candidate)));
        const capcodeValues = Array.isArray(request.body.capcode)
          ? request.body.capcode
          : [request.body.capcode];
        const context = {
          clientKey: abuseIdentity(request, 'poster'),
          ...(staffOnly ? {
            actor: request.staff,
            capcode: capcodeValues.includes('1')
          } : {})
        };
        const result = await (forceReply || threadId
          ? service.createReply(threadId, request.body, media, { ...context, boardUri: board.uri })
          : service.createThread(request.body, media, { ...context, boardId: board.id }));
        postCommitted = true;
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
        if (!postCommitted) await Promise.all(media.map(candidate => uploads.removeCandidate(candidate)));
        for (const file of files) uploads.removePath(file?.path);
        next(error);
      }
    };
  }

  app.post(['/post', '/post.php'], postRateLimit, requirePostingAuthorization, uploads.middleware, postHandler(false));
  app.post('/reply', postRateLimit, requirePostingAuthorization, uploads.middleware, postHandler(true));

  app.post('/delete', rateLimit('deletePassword', 'Too many deletion attempts. Try again later.'), async (request, response, next) => {
    try {
      const result = await service.deleteByPassword(request.body.postIds, request.body.password || request.body.pwd, Boolean(request.body.fileOnly));
      if (isJsonRequest(request)) response.json({ ok: true, ...result });
      else response.redirect(303, safeRedirect(request.body.redirectTo, '/'));
    } catch (error) {
      next(error);
    }
  });

  app.post('/report', rateLimit('reportCreate', 'Too many reports from this address. Try again later.'), async (request, response, next) => {
    try {
      const report = await service.reportPost(request.body.postId, request.body.reason, {
        category: request.body.category,
        clientKey: abuseIdentity(request, 'reporter')
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

  app.post('/appeals/:appealId', rateLimit('reportCreate', 'Too many appeal attempts. Try again later.'), async (request, response, next) => {
    try {
      await service.submitAppeal(request.params.appealId, request.body.message);
      response.redirect(303, `/appeals/${encodeURIComponent(request.params.appealId)}`);
    } catch (error) {
      next(error);
    }
  });

  async function requireAdmin(request, response, next) {
    if (!admin.configured) {
      response.status(404).send('Not found');
      return;
    }
    const session = admin.readSession(request);
    if (!session) {
      response.redirect(303, '/admin/login');
      return;
    }
    const staff = await service.resolveStaffSessionFresh(session);
    if (!staff) {
      admin.clearCookie(request, response);
      response.redirect(303, '/admin/login');
      return;
    }
    request.adminSession = session;
    request.staff = staff;
    const repositoryBackedQueue = request.path === '/admin/reports'
      || request.path === '/admin/dismiss-report'
      || request.path === '/admin/appeals'
      || request.path === '/admin/trash'
      || request.path === '/admin/revisions'
      || request.path.startsWith('/admin/reports/');
    if (!repositoryBackedQueue && store.cacheDirty && typeof store.refreshCache === 'function') {
      await store.refreshCache();
    }
    response.setHeader('Cache-Control', 'no-store');
    next();
  }

  function requireCsrf(request) {
    if (!admin.verifyCsrf(request)) throw httpError(403, 'Invalid admin form token.');
  }

  function staffActionContext(request) {
    return { actor: request.staff, requestId: request.id, actionId: crypto.randomUUID() };
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
      await rateLimiter.consume(
        'adminLogin',
        abuseIdentity(request, 'rate:adminLogin'),
        'Too many login attempts. Try again later.'
      );
      const username = String(request.body.username || '').trim();
      const account = username
        ? await service.authenticateStaff(username, request.body.password, request.body.mfaCode)
        : null;
      const legacyLogin = !username && admin.verifyPassword(request.body.password);
      if (!account && !legacyLogin) {
        response.status(401).send(renderer.adminLogin('Wrong username, password, or authentication code.'));
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

  app.get('/admin/reports', requireAdmin, async (request, response) => {
    requirePermission(request, 'reports.manage');
    const filters = {
      status: String(request.query.status || ''),
      boardId: String(request.query.board || ''),
      page: String(request.query.page || '')
    };
    const view = await service.moderationQueueFor(request.staff, 'reports', filters);
    response.send(renderer.adminReports(view.data, admin.csrf(request.adminSession), {
      ...filters,
      pageInfo: view.pageInfo
    }, request.staff));
  });

  app.get('/admin/appeals', requireAdmin, async (request, response) => {
    requirePermission(request, 'reports.manage');
    const filters = { status: String(request.query.status || ''), page: String(request.query.page || '') };
    const view = await service.moderationQueueFor(request.staff, 'appeals', filters);
    response.send(renderer.adminAppeals(
      view.data,
      admin.csrf(request.adminSession),
      { ...filters, pageInfo: view.pageInfo },
      request.staff
    ));
  });

  app.get('/admin/trash', requireAdmin, async (request, response) => {
    requirePermission(request, 'posts.delete');
    const filters = { page: String(request.query.page || '') };
    const view = await service.moderationQueueFor(request.staff, 'trash', filters);
    response.send(renderer.adminTrash(
      view.data,
      admin.csrf(request.adminSession),
      request.staff,
      { ...filters, pageInfo: view.pageInfo }
    ));
  });

  app.get('/admin/media', requireAdmin, (request, response) => {
    requirePermission(request, 'posts.delete');
    response.send(renderer.adminMedia(
      service.moderationDataFor(request.staff),
      admin.csrf(request.adminSession),
      {
        state: String(request.query.state || ''),
        boardId: String(request.query.board || ''),
        postId: String(request.query.postId || ''),
        page: String(request.query.page || '')
      },
      request.staff,
      { worker: uploads.workerStatus(), storage: uploads.storageStatus() }
    ));
  });

  app.get('/admin/revisions', requireAdmin, async (request, response) => {
    requirePermission(request, 'posts.edit');
    const filters = { postId: request.query.postId, page: String(request.query.page || '') };
    const view = await service.moderationQueueFor(request.staff, 'revisions', filters);
    response.send(renderer.adminRevisions(
      view.data,
      admin.csrf(request.adminSession),
      { ...filters, pageInfo: view.pageInfo },
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

  app.post(
    '/admin/post',
    requireAdmin,
    staffRateLimit('apiMutation', 'Too many staff posting actions. Wait and try again.'),
    uploads.middleware,
    postHandler(false, true)
  );

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
      requirePermission(request, 'reports.manage');
      await service.dismissReport(request.body.reportId, staffActionContext(request));
      response.redirect(303, '/admin');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/reports/resolve', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      requirePermission(request, 'reports.manage');
      await service.resolveReport(
        request.body.reportId,
        request.body.resolution,
        request.body.note,
        staffActionContext(request)
      );
      response.redirect(303, '/admin/reports');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/reports/reopen', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      requirePermission(request, 'reports.manage');
      await service.reopenReport(request.body.reportId, staffActionContext(request));
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

  app.post('/admin/media/hash-ban', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      requirePermission(
        request,
        'bans.manage',
        request.body.scope === 'board' ? String(request.body.boardId || '') : ''
      );
      await service.createMediaHashBan(request.body, { actor: request.staff });
      response.redirect(303, '/admin/media');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/media/hash-unban', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      requirePermission(request, 'bans.manage');
      await service.liftMediaHashBan(request.body.hashBanId, { actor: request.staff });
      response.redirect(303, '/admin/media');
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

  app.post(
    '/admin/boards/add',
    requireAdmin,
    staffRateLimit('boardCreate', 'Too many board creation attempts. Try again later.'),
    async (request, response, next) => {
    try {
      requireCsrf(request);
      requirePermission(request, 'boards.manage');
      await service.addBoard(request.body, { actor: request.staff });
      response.redirect(303, '/admin/boards');
    } catch (error) {
      next(error);
    }
    }
  );

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
        changes.tags = request.body.tags;
        changes.sfw = request.body.sfw;
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

  app.post('/admin/boards/filters/add', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      requirePermission(request, 'boards.manage');
      const filter = await service.addBoardFilter(request.body.uri, request.body, { actor: request.staff });
      const board = service.getBoard(request.body.uri);
      response.redirect(303, `/admin/boards/${encodeURIComponent(board.uri)}/settings#filter-${encodeURIComponent(filter.id)}`);
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/boards/filters/delete', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      requirePermission(request, 'boards.manage');
      await service.deleteBoardFilter(request.body.uri, request.body.filterId, { actor: request.staff });
      const board = service.getBoard(request.body.uri);
      response.redirect(303, `/admin/boards/${encodeURIComponent(board.uri)}/settings`);
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

  app.post('/admin/account/mfa/setup', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      requirePermission(request, 'dashboard.view');
      const enrollment = await service.beginStaffMfa(request.body.currentPassword, request.staff);
      response.setHeader('Cache-Control', 'no-store');
      response.send(renderer.adminMfaSetup(
        request.staff,
        admin.csrf(request.adminSession),
        enrollment
      ));
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/account/mfa/confirm', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      requirePermission(request, 'dashboard.view');
      await service.confirmStaffMfa(request.body.mfaCode, request.staff);
      admin.clearCookie(request, response);
      response.redirect(303, '/admin/login');
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/account/mfa/disable', requireAdmin, async (request, response, next) => {
    try {
      requireCsrf(request);
      requirePermission(request, 'dashboard.view');
      await service.disableStaffMfa(
        request.body.currentPassword,
        request.body.mfaCode,
        request.staff
      );
      admin.clearCookie(request, response);
      response.redirect(303, '/admin/login');
    } catch (error) {
      next(error);
    }
  });

  async function resolveBoard(request, response, next, value) {
    try {
      const board = await service.publicBoard(value);
      if (!board || !board.enabled) return next(httpError(404, 'Board not found.'));
      request.board = board;
      next();
    } catch (error) {
      next(error);
    }
  }

  app.param('boardUri', resolveBoard);

  if (config.features.api) {
    app.get('/:boardUri/rules.json', (request, response) => {
      apiResponse(response, request.board.rules.map(rule => rule.text));
    });
    app.get('/:boardUri/catalog.json', async (request, response) => {
      const view = await service.publicCatalog(request.board, request.query.page);
      apiResponse(response, apiCatalog(service, view.data, request.board));
    });
    app.get('/:boardUri/threads.json', async (request, response) => {
      const view = await service.publicCatalog(request.board, request.query.page);
      apiResponse(response, apiThreads(service, view.data, request.board));
    });
    app.get('/:boardUri/archive.json', async (request, response) => {
      const view = await service.publicArchive(request.board, request.query.page);
      apiResponse(response, view.threads.map(thread => thread.id));
    });
    app.get('/:boardUri/index.json', async (request, response) => {
      const page = await service.publicBoardPage(request.board, 1);
      if (!page) throw httpError(404, 'Board page not found.');
      apiResponse(response, { threads: page.threads.map(thread => apiThread(thread, page.data, config, request.board, true)) });
    });
    app.get('/:boardUri/thread/:id.json', async (request, response) => {
      const view = await service.publicThread(request.params.id, request.board.id);
      if (!view) throw httpError(404, 'Thread not found.');
      apiResponse(response, apiThread(view.thread, view.data, config, request.board));
    });
    app.get('/:boardUri/res/:id.json', async (request, response) => {
      const view = await service.publicThread(request.params.id, request.board.id);
      if (!view) throw httpError(404, 'Thread not found.');
      apiResponse(response, apiThread(view.thread, view.data, config, request.board));
    });
    app.get('/:boardUri/:page.json', async (request, response) => {
      const pageNumber = Number(request.params.page) === 0 ? 1 : request.params.page;
      const page = await service.publicBoardPage(request.board, pageNumber);
      if (!page) throw httpError(404, 'Board page not found.');
      apiResponse(response, { threads: page.threads.map(thread => apiThread(thread, page.data, config, request.board, true)) });
    });
  }

  app.post('/:boardUri/post', postRateLimit, requirePostingAuthorization, uploads.middleware, postHandler(false));
  app.post('/:boardUri/post.php', postRateLimit, requirePostingAuthorization, uploads.middleware, postHandler(false));

  app.get('/:boardUri/', (request, response) => renderBoardPage(request.board, 1, response));
  app.get('/:boardUri/index.html', (request, response) => renderBoardPage(request.board, 1, response));
  app.get('/:boardUri/catalog', async (request, response) => {
    const view = await service.publicCatalog(request.board, request.query.page);
    response.send(renderer.catalog(view.data, view.threads, request.board, view.stats, view));
  });
  app.get('/:boardUri/catalog.html', async (request, response) => {
    const view = await service.publicCatalog(request.board, request.query.page);
    response.send(renderer.catalog(view.data, view.threads, request.board, view.stats, view));
  });
  app.get(['/:boardUri/archive', '/:boardUri/archive.html'], async (request, response) => {
    const view = await service.publicArchive(request.board, request.query.page);
    response.send(renderer.archive(view.threads, request.board, view.stats, view));
  });
  app.get(['/:boardUri/rules', '/:boardUri/rules.html'], async (request, response) => {
    const stats = service.usesTargetedQueries
      ? await store.boardStats(request.board.id)
      : service.getStats(service.getData(), request.board.uri);
    response.send(renderer.boardRules(request.board, stats));
  });
  app.get('/:boardUri/:page.html', (request, response) => renderBoardPage(request.board, request.params.page, response));
  app.get('/:boardUri/thread/:id', (request, response) => renderThread(request, response, request.board.id));
  app.get('/:boardUri/res/:id.html', (request, response) => renderThread(request, response, request.board.id));

  app.use((request, response) => {
    response.status(404).send(renderer.message('Not found', 'That page or thread does not exist.', { line: '' }, '/'));
  });

  app.use((error, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const isTooLarge = error.code === 'LIMIT_FILE_SIZE';
    const suppliedStatus = Number(error.status);
    const status = isTooLarge
      ? 413
      : (suppliedStatus >= 400 && suppliedStatus <= 599 ? suppliedStatus : 500);
    const message = isTooLarge
      ? `Uploads are limited to ${Math.max(config.limits.maxFileBytes, config.limits.maxVideoBytes)} bytes.`
      : (status >= 500 ? 'The server could not complete this request. Try again later.' : error.message);
    if (status >= 500) {
      (overrides.logger || console).error(JSON.stringify({
        level: 'error',
        category: 'request-failure',
        requestId: request.id,
        method: request.method,
        path: request.path,
        status,
        error: String(error?.message || 'Unknown error').slice(0, 1000)
      }));
    }
    response.status(status);
    if (isJsonRequest(request)) {
      response.json({ ok: false, error: message, ...(error.appealUrl ? { appealUrl: error.appealUrl } : {}) });
    } else response.send(renderer.message(
      status >= 500 ? 'Server error' : 'Request failed',
      message,
      { line: '' },
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
    mediaSafety,
    clientAddresses,
    rateLimiter,
    rateLimitStore,
    postingAuthorization,
    authorizationNonceStore,
    hooks,
    maintenance
  };
  return app;
}

module.exports = { createApp };
