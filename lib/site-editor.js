'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { Renderer } = require('./render');
const { defaultLayout, validateLayout, normalizeNews, IMAGE_PATH, layoutCSS } = require('./home-layout');
const { httpError } = require('./utils');

function installSiteEditor(app, context) {
  const { config, service, store, renderer, uploads, mediaSafety, admin, requireAdmin, requireCsrf, requirePermission, staffActionContext, staffRateLimit } = context;
  const json = express.json({ limit: '256kb', inflate: false });
  const permission = (request, response, next) => { requirePermission(request, 'site.manage'); next(); };
  const authorize = (request, response, next) => { requireCsrf(request); next(); };
  const guarded = [requireAdmin, permission];

  async function mutate(request, action, change) {
    return (await store.update(data => {
      service.assertStaffPermission(staffActionContext(request), 'site.manage', '', data);
      const result = change(data.customization, data);
      service.logModeration(data, action, 'Updated site presentation or moderation metadata', staffActionContext(request));
      return result;
    })).result;
  }

  app.get('/admin/customization/state', ...guarded, (request, response) => {
    const customization = service.getCustomization();
    response.json({ homepage: customization.homepage, titles: require('./home-layout').TITLES });
  });

  async function preview(request, response) {
    const view = await service.publicHome();
    const customization = await service.publicCustomization();
    const layout = request.method === 'POST' ? validateLayout(request.body.layout) : customization.homepage.draft;
    const previewRenderer = new Renderer(config, () => ({ ...view.data, boards: view.boards, customization: { ...customization, homepage: { ...customization.homepage, published: layout } } }), renderer.i18n);
    const homeArgs = [view.data, view.boards, view.stats, view.latestPosts, view.latestImages, view.activeThreads, view.recentlyRepliedThreads];
    if (request.method === 'POST') {
      response.json({ html: previewRenderer.homeContent(...homeArgs), css: layoutCSS(layout), navigation: previewRenderer.utilityNav() });
    } else {
      response.set('X-Frame-Options', 'SAMEORIGIN');
      response.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'none'; form-action 'none'");
      response.send(previewRenderer.home(...homeArgs).replace('<html ', '<html data-theme-preview ').replace('/custom.css', '/admin/customization/preview.css').replace('</head>', '<link id="editor-layout-style" rel="stylesheet" href="/admin/customization/runtime.css"></head>'));
    }
  }
  app.get('/admin/customization/preview', ...guarded, preview);
  app.get('/admin/customization/runtime.css', requireAdmin, permission, (request, response) => response.type('css').send('/* Live layout preview */'));
  app.post('/admin/customization/preview', ...guarded, staffRateLimit('editorPreview'), json, authorize, preview);
  app.get('/admin/customization/preview.css', requireAdmin, permission, (request, response) => response.type('css').send(renderer.customStyles() + '\n' + layoutCSS(service.getCustomization().homepage.draft)));

  app.post('/admin/customization/layout', ...guarded, json, authorize, async (request, response) => {
    const action = request.body.action;
    if (!['save', 'publish', 'reset', 'snapshot', 'restore'].includes(action)) throw httpError(400, 'Unknown layout action.');
    const layout = ['save', 'publish', 'snapshot'].includes(action) ? validateLayout(request.body.layout) : null;
    if (layout && JSON.stringify(layout).length > 160000) throw httpError(400, 'The layout is too large.');
    const result = await mutate(request, `layout-${action}`, customization => {
      const home = customization.homepage;
      if (Number(request.body.revision) !== home.revision) throw httpError(409, 'This layout changed in another window. Reload before saving.');
      if (action === 'restore') {
        const record = [...home.history, ...home.savedLayouts].find(item => item.id === request.body.id);
        if (!record) throw httpError(404, 'Saved layout not found.');
        home.draft = structuredClone(record.layout);
      } else if (action === 'snapshot') {
        const label = String(request.body.label || '').trim().slice(0, 80);
        if (!label) throw httpError(400, 'Name the saved layout.');
        home.savedLayouts.push({ id: crypto.randomUUID(), at: Date.now(), label, layout });
        home.savedLayouts = home.savedLayouts.slice(-8);
        home.draft = layout;
      } else home.draft = action === 'reset' ? defaultLayout() : layout;
      if (action === 'publish') {
        home.history.push({ id: crypto.randomUUID(), at: Date.now(), label: 'Previous publication', layout: structuredClone(home.published) });
        home.history = home.history.slice(-12);
        home.published = structuredClone(layout);
      }
      home.revision += 1;
      return home;
    });
    response.json({ homepage: result });
  });

  // This endpoint uses the same decoder, limits, safety checks and private staging
  // as post uploads. Authentication and CSRF run before any file is opened.
  app.post('/admin/assets', ...guarded, staffRateLimit('apiMutation'), (request, response, next) => {
    request.body = { csrf: request.get('x-csrf-token') };
    requireCsrf(request);
    next();
  }, uploads.middleware, async (request, response) => {
    const files = uploads.filesFromRequest(request);
    const candidates = [];
    let committed = false;
    try {
      if (files.length !== 1) throw httpError(400, 'Choose one image.');
      const candidate = await uploads.validate(files[0]);
      candidates.push(candidate);
      if (candidate.mediaKind !== 'image') throw httpError(400, 'Choose an image for site presentation.');
      const board = await service.publicDefaultBoard();
      await mediaSafety.evaluate(board, candidates);
      await uploads.approveCandidate(candidate);
      const saved = await mutate(request, 'site-asset-upload', (customization, data) => {
        const existing = data.media.find(asset => asset.id === candidate._asset.id);
        if (existing && (existing.state !== 'approved' || !existing.path)) {
          throw httpError(409, 'This image is held for moderation and cannot be used.');
        }
        if (!existing) data.media.push({ ...candidate._asset, refCount: 1, purpose: 'site' });
        const imagePath = `/${existing?.path || candidate.image}`;
        if (!customization.assets.some(asset => asset.path === imagePath)) {
          customization.assets.push({ path: imagePath, name: candidate.imageName, at: Date.now() });
        }
        customization.assets = customization.assets.slice(-200);
        return { path: imagePath, reused: Boolean(existing) };
      });
      committed = true;
      if (saved.reused) await uploads.removeCandidate(candidate);
      response.status(201).json({ path: saved.path });
    } finally {
      if (!committed) await Promise.all(candidates.map(candidate => uploads.removeCandidate(candidate)));
      for (const file of files) uploads.removePath(file.path);
    }
  });

  app.get('/admin/news', ...guarded, (request, response) => response.send(renderer.adminNews(service.getCustomization().news, admin.csrf(request.adminSession))));
  app.post('/admin/news/save', ...guarded, json, authorize, async (request, response) => {
    const fields = request.body.article;
    if (!fields || !String(fields.title || '').trim() || String(fields.title).length > 160 || String(fields.content || '').length > 50000
      || !['draft', 'published'].includes(fields.status) || !Number.isFinite(Number(fields.publishedAt)) || Number(fields.publishedAt) < 0 || Number(fields.publishedAt) > 8640000000000000
      || !Array.isArray(fields.images) || fields.images.length > 12 || fields.images.some(image => !IMAGE_PATH.test(image.src || ''))) throw httpError(400, 'Invalid article, publication date, or image.');
    const article = await mutate(request, 'news-save', customization => {
      const existing = fields.id ? customization.news.find(item => item.id === fields.id) : null;
      if (fields.id && !existing) throw httpError(404, 'Article not found.');
      if (existing && Number(fields.updatedAt) !== existing.updatedAt) throw httpError(409, 'This article changed in another window. Reload before saving.');
      if (!existing && customization.news.length >= 100) throw httpError(400, 'The news archive is limited to 100 articles.');
      const article = normalizeNews([{ ...fields, id: existing?.id || crypto.randomUUID(), updatedAt: Math.max(Date.now(), (existing?.updatedAt || 0) + 1) }])[0];
      if (existing) customization.news[customization.news.indexOf(existing)] = article;
      else customization.news.push(article);
      return article;
    });
    response.json({ article });
  });
  app.post('/admin/news/preview', ...guarded, json, authorize, (request, response) => {
    const articles = normalizeNews([{ ...request.body.article, id: 'preview' }]);
    response.json({ html: renderer.newsArticles(articles, true) });
  });
  app.post('/admin/news/delete', ...guarded, json, authorize, async (request, response) => {
    await mutate(request, 'news-delete', customization => {
      const index = customization.news.findIndex(item => item.id === request.body.id);
      if (index < 0) throw httpError(404, 'Article not found.');
      customization.news.splice(index, 1);
    });
    response.json({ ok: true });
  });

  app.get('/admin/media/policy', ...guarded, (request, response) => response.send(renderer.adminMediaPolicy(service.getData(), admin.csrf(request.adminSession), mediaSafety.status())));
  app.post('/admin/media/policy', ...guarded, authorize, async (request, response) => {
    const adultPolicy = String(request.body.adultPolicy || 'off');
    if (!['off', 'block', 'review'].includes(adultPolicy)) throw httpError(400, 'Invalid adult-content policy.');
    const boards = {};
    for (const board of service.getBoards()) {
      const policy = request.body[`policy_${board.id}`];
      if (policy && policy !== 'inherit') {
        if (!['off', 'block', 'review'].includes(policy)) throw httpError(400, 'Invalid board policy.');
        boards[board.id] = policy;
      }
    }
    await mutate(request, 'media-policy', customization => { customization.moderation = { adultPolicy, boards, requireKnownIllegalCheck: request.body.requireKnownIllegalCheck === '1' }; });
    response.redirect(303, '/admin/media/policy');
  });
  app.post('/admin/media/incidents/resolve', ...guarded, authorize, async (request, response) => {
    const resolution = String(request.body.resolution || '');
    if (!['escalated', 'reported', 'false-positive', 'closed'].includes(resolution)) throw httpError(400, 'Invalid incident resolution.');
    await mutate(request, 'media-incident-resolve', (customization, data) => {
      const incident = data.meta.mediaIncidents?.find(item => item.id === request.body.id);
      if (!incident) throw httpError(404, 'Incident not found.');
      incident.status = 'closed'; incident.resolution = resolution; incident.resolvedAt = Date.now(); incident.actorId = request.staff.id;
      incident.reportReference = String(request.body.reportReference || '').replace(/[\u0000-\u001f]/g, '').slice(0, 200);
    });
    response.redirect(303, '/admin/media/policy');
  });
}

module.exports = { installSiteEditor };
