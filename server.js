'use strict';

const { createBootstrap } = require('./lib/bootstrap');
let bootstrap;
let shuttingDown = false;
let server;

async function start() {
  bootstrap = await createBootstrap();
  if (shuttingDown) {
    await bootstrap.close();
    return;
  }
  const { app, config: { host, port } } = bootstrap;
  await new Promise((resolve, reject) => {
    server = app.listen(port, host, error => error ? reject(error) : resolve());
  });
  console.log(`ChikoChan is running at http://${host === '0.0.0.0' ? 'localhost' : host}:${server.address().port}`);
  return server;
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; closing the HTTP server.`);

  if (!server) {
    // start() closes resources if startup completes after this signal.
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
    await bootstrap.close();
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const started = start().catch(async () => {
  // MongoDB errors can contain credentials. Keep startup diagnostics private.
  console.error('Could not start ChikoChan. Check database access and the configuration requirements in README.md.');
  process.exitCode = 1;
  await bootstrap?.close();
});

module.exports = started;
