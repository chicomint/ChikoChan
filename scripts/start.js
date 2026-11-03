'use strict';

async function start() {
  // Railway's existing service runs `npm start`. Prepare its volume key before
  // the server reads encrypted settings; local startup keeps its normal path.
  if (process.env.RAILWAY_SERVICE_ID) {
    process.umask(0o077);
    const { prepareKey, prepareSettings } = require('./start-railway');
    prepareKey();
    await prepareSettings();
  }
  return require('../server');
}

if (require.main === module) {
  start().catch(() => {
    console.error('Could not prepare ChikoChan startup. Check the database connection and private settings key; see RAILWAY_DEPLOYMENT.md.');
    process.exitCode = 1;
  });
}

module.exports = { start };
