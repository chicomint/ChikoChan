'use strict';

const { loadConfig } = require('../config');
const { diagnose } = require('../lib/diagnostics');
const { MongoStore } = require('../lib/mongo-store');
const { JsonStore } = require('../lib/store');
const { UploadManager } = require('../lib/uploads');

async function main() {
  const config = loadConfig();
  const store = config.storage === 'json' ? new JsonStore(config) : new MongoStore(config);
  const uploads = new UploadManager(config);
  try {
    const report = await diagnose(config, store, uploads);
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`ChikoChan diagnostics: ${report.ok ? 'OK' : 'problems found'}`);
      console.log(`Storage: ${report.storage}; schema: ${report.schema.stored}/${report.schema.current}`);
      console.log(`Boards: ${report.counts.boards}; posts: ${report.counts.posts}; attachments: ${report.counts.attachments}; media: ${report.counts.media}`);
      console.log(`Errors: ${report.summary.errors}; warnings: ${report.summary.warnings}`);
      for (const entry of report.issues) {
        const subject = entry.assetId || entry.postId || entry.path || entry.location || '';
        console.log(`[${entry.severity.toUpperCase()}] ${entry.code}${subject ? ` (${subject})` : ''}: ${entry.message}`);
      }
    }
    if (!report.ok) process.exitCode = 1;
  } finally {
    await store.close?.();
  }
}

main().catch(error => {
  console.error(`Diagnostics failed: ${error.message}`);
  process.exitCode = 1;
});
