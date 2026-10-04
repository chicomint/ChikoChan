'use strict';

const express = require('express');
const { ENV_FILE, loadConfig, loadStartupConfig } = require('../config');
const { createInstaller } = require('./installer');
const { installationRequired, prepareInstallation } = require('./install-state');

async function closeApplication(application) {
  if (!application) return;
  const { maintenance, uploads, rateLimitStore, store } = application.locals.chikochan;
  await maintenance.stop().catch(() => {});
  // Attempt every close even if one backend fails.
  await Promise.allSettled([uploads.close?.(), rateLimitStore.close?.(), store.close?.()]);
}

async function createBootstrap({ overrides = {}, envFile = ENV_FILE, createApplication, testConnection } = {}) {
  const config = loadStartupConfig(overrides);
  const factory = createApplication || (settings => require('../app').createApp(settings));
  let application;
  let installer;
  let closing = false;
  const app = express();
  app.disable('x-powered-by');

  async function initialize(settings) {
    let candidate;
    let store;
    try {
      const appSettings = { ...overrides, ...settings };
      if (!createApplication) {
        // Validate production policy before opening resources, and own the store
        // during startup so a failed app constructor cannot strand its client.
        const runtimeConfig = loadConfig(appSettings);
        const Store = runtimeConfig.storage === 'json' ? require('./store').JsonStore : require('./mongo-store').MongoStore;
        store = appSettings.store || new Store(runtimeConfig);
        await store.ready;
        appSettings.store = store;
      }
      candidate = factory(appSettings);
      await candidate.locals.chikochan.store.ready;
      return candidate;
    } catch (error) {
      if (candidate) await closeApplication(candidate);
      else await store?.close?.();
      throw error;
    }
  }
  if (!installationRequired(config)) {
    application = await initialize({});
    application.locals.chikochan.maintenance.start();
  } else {
    installer = createInstaller({ config, envFile, testConnection, complete: async settings => {
      const prepared = prepareInstallation(settings, envFile);
      let candidate;
      try {
        candidate = await initialize({
          storage: settings.STORAGE, mongoUrl: settings.MONGO_URL || '', mongoDbName: settings.MONGO_DB_NAME || '',
          ...(settings.DATA_DIR ? { dataDir: settings.DATA_DIR } : {}),
          site: { title: settings.SITE_NAME, description: settings.SITE_DESCRIPTION },
          adminPassword: settings.ADMIN_PASSWORD, adminSessionSecret: settings.ADMIN_SESSION_SECRET
        });
        if (closing) throw new Error('Server is shutting down.');
        prepared.commit();
        Object.assign(process.env, settings, { CHIKO_INSTALLED: 'true' });
        application = candidate;
        application.locals.chikochan.maintenance.start();
      } catch (error) {
        await closeApplication(candidate);
        throw error;
      } finally { prepared.release(); }
    } });
  }
  app.use((request, response, next) => (application || installer.app)(request, response, next));
  return {
    app, config,
    get application() { return application; },
    async close() {
      closing = true;
      await installer?.close();
      await closeApplication(application);
    }
  };
}

module.exports = { closeApplication, createBootstrap };
