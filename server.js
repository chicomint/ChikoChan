'use strict';

const { createApp } = require('./app');

const app = createApp();
const { config, maintenance, rateLimitStore, store, uploads } = app.locals.chikochan;
const { host, port } = config;
let shuttingDown = false;
let server;

async function start() {
  await store.ready;
  maintenance.start();
  server = app.listen(port, host, error => {
    if (error) {
      console.error(`Could not start ChikoChan: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`ChikoChan is running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  });
  return server;
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; closing the HTTP server.`);

  if (!server) {
    void maintenance.stop()
      .then(() => uploads.close?.())
      .then(() => rateLimitStore.close?.())
      .then(() => store.close?.())
      .finally(() => process.exit());
    return;
  }

  const forceClose = setTimeout(() => {
    console.error('Graceful shutdown timed out; closing remaining connections.');
    server.closeAllConnections?.();
    process.exitCode = 1;
  }, 10_000);
  forceClose.unref();

  server.closeIdleConnections?.();
  server.close(async error => {
    clearTimeout(forceClose);
    await maintenance.stop();
    await uploads.close?.();
    await rateLimitStore.close?.();
    await store.close?.();
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const started = start().catch(error => {
  console.error(`Could not start ChikoChan: ${error.message}`);
  process.exitCode = 1;
  throw error;
});

module.exports = started;
