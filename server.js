'use strict';

const { createApp } = require('./app');

const app = createApp();
const { host, port } = app.locals.chikochan.config;
let shuttingDown = false;

const server = app.listen(port, host, error => {
  if (error) {
    console.error(`Could not start ChikoChan: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`ChikoChan is running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; closing the HTTP server.`);

  const forceClose = setTimeout(() => {
    console.error('Graceful shutdown timed out; closing remaining connections.');
    server.closeAllConnections?.();
    process.exitCode = 1;
  }, 10_000);
  forceClose.unref();

  server.closeIdleConnections?.();
  server.close(error => {
    clearTimeout(forceClose);
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = server;
