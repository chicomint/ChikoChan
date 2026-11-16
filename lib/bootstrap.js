'use strict';

const express = require('express');
const path = require('node:path');
const { ENV_FILE, loadConfig, loadStartupConfig } = require('../config');
const { createInstaller } = require('./installer');
const { prepareInstallation } = require('./install-state');
const { KEY_FILE, SettingsStore, connectionSettings } = require('./settings');

async function closeApplication(application) {
  if (!application) return;
  const { maintenance, uploads, rateLimitStore, store, mediaSafety } = application.locals.chikochan;
  await maintenance.stop().catch(() => {});
  await Promise.allSettled([mediaSafety?.close?.(), uploads.close?.(), rateLimitStore.close?.(), store.close?.()]);
}

async function createBootstrap({ overrides = {}, envFile = ENV_FILE, keyFile = KEY_FILE, createApplication, testConnection, settingsClient } = {}) {
  const connection = connectionSettings(envFile);
  let settingsStore = await new SettingsStore(connection, { keyFile, client: settingsClient }).open();
  let application;
  let installer;
  let closing = false;
  const app = express();
  app.disable('x-powered-by');

  async function initialize(settings) {
    let candidate;
    let store;
    try {
      const runtimeConfig = loadConfig({ ...settings, ...overrides });
      if (!createApplication) {
        const Store = runtimeConfig.storage === 'json' ? require('./store').JsonStore : require('./mongo-store').MongoStore;
        store = overrides.store || new Store(runtimeConfig);
        await store.ready;
      }
      candidate = (createApplication || require('../app').createApp)({ ...runtimeConfig, keyFile, ...(store ? { store } : {}) });
      await candidate.locals.chikochan.store.ready;
      return candidate;
    } catch (error) {
      if (candidate) await closeApplication(candidate);
      else await store?.close?.();
      throw error;
    }
  }

  let config;
  try {
    const saved = await settingsStore.read();
    config = loadStartupConfig({ ...(saved || { host: '127.0.0.1' }), ...connection, ...overrides });
    app.set('env', config.deployment.environment);
    if (saved) {
      application = await initialize({ ...saved, ...connection });
      application.locals.chikochan.maintenance.start();
    } else {
      installer = createInstaller({ config: { ...config, rootDir: __dirname + '/..' }, envFile, testConnection,
        isConfigured: async () => Boolean(await settingsStore.read()),
        complete: async ({ connection: selected, ...settings }) => {
          const url = selected.storage === 'json' ? 'json:./data' : selected.mongoUrl;
          const target = { ...selected, ...(selected.storage === 'json' ? { dataDir: path.resolve(path.dirname(envFile), 'data') } : {}), url };
          const prepared = prepareInstallation({ DATABASE_URL: url, ...(selected.mongoDbName ? { DB_NAME: selected.mongoDbName } : {}) }, envFile);
          let candidate;
          let targetStore;
          try {
            targetStore = await new SettingsStore(target, { keyFile, client: settingsClient }).open();
            if (await targetStore.read()) throw new Error('Setup is already complete.');
            const chikoSettings = { ...settings, ...(target.storage === 'mongodb' ? { dataDir: './data' } : {}), ...target };
            candidate = await initialize(chikoSettings);
            if (closing) throw new Error('Server is shutting down.');
            await targetStore.save(chikoSettings);
            prepared.commit();
            application = candidate;
            application.locals.chikochan.maintenance.start();
            await settingsStore.close();
            settingsStore = targetStore;
            targetStore = null;
          } catch (error) {
            await closeApplication(candidate);
            throw error;
          } finally { prepared.release(); await targetStore?.close(); }
        }
      });
    }
  } catch (error) { await settingsStore.close(); throw error; }
  app.use((request, response, next) => (application || installer.app)(request, response, next));
  return {
    app, config,
    get application() { return application; },
    async close() {
      closing = true;
      await installer?.close();
      await closeApplication(application);
      await settingsStore.close();
    }
  };
}

module.exports = { closeApplication, createBootstrap };
