'use strict';

const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { SettingsStore } = require('./settings');
const { httpError, parseCookies } = require('./utils');

const COOKIE = 'chikochan_preferences';
const KEYS = ['chikochan-theme', 'chikochan-hidden-posts', 'chikochan-post-password'];

function cleanPreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !KEYS.includes(key))) throw httpError(400, 'Invalid preferences.');
  const theme = value[KEYS[0]] || 'light';
  const password = value[KEYS[2]] || '';
  let hidden;
  try { hidden = JSON.parse(value[KEYS[1]] || '[]'); } catch { throw httpError(400, 'Invalid hidden posts.'); }
  if (!['light', 'dark', 'yotsuba-b'].includes(theme) || typeof password !== 'string' || password.length > 256
    || !Array.isArray(hidden) || hidden.length > 300 || hidden.some(id => !/^\d{1,16}$/.test(String(id)))) {
    throw httpError(400, 'Invalid preferences.');
  }
  return { [KEYS[0]]: theme, [KEYS[1]]: JSON.stringify(hidden.map(String)), [KEYS[2]]: password };
}

function installPreferences(app, config, persistence, { keyFile, limit }) {
  async function preferences(request, response, write = false) {
    let id = parseCookies(request.headers.cookie)[COOKIE];
    if (!/^[a-f0-9]{64}$/.test(id || '')) {
      if (write) throw httpError(403, 'Reload the page before saving preferences.');
      id = crypto.randomBytes(32).toString('hex');
      response.append('Set-Cookie', `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${request.secure || config.deployment.publicOrigin.startsWith('https://') ? '; Secure' : ''}`);
    }
    await persistence.ready;
    const store = new SettingsStore(config, { keyFile, id, normalize: cleanPreferences, validate: cleanPreferences });
    // Mongo preferences share the application's client and never close it.
    if (config.storage === 'mongodb') store.collection = persistence.db.collection('settings');
    else await store.open();
    response.set('Cache-Control', 'private, no-store');
    const saved = await store.read();
    if (write) { await store.save(cleanPreferences(request.body)); return response.sendStatus(204); }
    response.json({ fresh: !saved, values: saved || {} });
  }
  app.get('/theme-init.js', async (request, response) => {
    response.type('application/javascript').set('Cache-Control', 'private, no-store');
    let theme = 'light';
    const id = parseCookies(request.headers.cookie)[COOKIE];
    if (/^[a-f0-9]{64}$/.test(id || '')) {
      try {
        await persistence.ready;
        const store = new SettingsStore(config, { keyFile, id, normalize: cleanPreferences, validate: cleanPreferences });
        if (config.storage === 'mongodb') store.collection = persistence.db.collection('settings');
        else await store.open();
        const saved = await store.read();
        if (['light', 'dark', 'yotsuba-b'].includes(saved?.[KEYS[0]])) theme = saved[KEYS[0]];
      } catch { /* Local theme preferences still work if server preferences are unavailable. */ }
    }
    response.send(fs.readFileSync(path.join(config.rootDir, 'theme-init.js'), 'utf8').replace('THEME_DEFAULT', theme));
  });

  app.get('/preferences', (request, response) => preferences(request, response));
  app.post('/preferences', limit, express.json({ limit: '8kb', inflate: false }), (request, response) => {
    if (!request.is('application/json')) throw httpError(415, 'Use JSON to save preferences.');
    return preferences(request, response, true);
  });
}

module.exports = { cleanPreferences, installPreferences };
