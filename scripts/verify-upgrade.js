'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../config');
const { dataFromDocuments, documentsFromData } = require('../lib/mongo-store');
const { SCHEMA_VERSION, createDefaultBoard, normalizeData } = require('../lib/store');

function activePostIds(data) {
  return data.threads.flatMap(thread => [thread.id, ...thread.replies.map(reply => reply.id)]);
}

function summary(data) {
  return {
    schemaVersion: data.version,
    lastId: data.lastId,
    boards: data.boards.length,
    threads: data.threads.length,
    posts: activePostIds(data).length,
    media: data.media.length,
    reports: data.reports.length,
    sanctions: data.bans.length,
    appeals: data.appeals.length,
    trash: data.trash.length,
    revisions: data.revisions.length,
    staff: data.staff.length,
    mediaHashBans: data.mediaHashBans.length,
    mediaDecisions: data.mediaDecisions.length
  };
}

function verifyParsedUpgrade(parsed, options) {
  const maximumCites = options.maximumCites;
  const defaultBoard = options.defaultBoard;
  const sourceIds = (Array.isArray(parsed.threads) ? parsed.threads : [])
    .flatMap(thread => [Number(thread.id), ...(Array.isArray(thread.replies) ? thread.replies.map(reply => Number(reply.id)) : [])])
    .filter(Number.isSafeInteger);
  const upgraded = normalizeData(structuredClone(parsed), maximumCites, defaultBoard);
  const repeated = normalizeData(structuredClone(upgraded), maximumCites, defaultBoard);
  assert.deepEqual(repeated, upgraded, 'normalization must be idempotent');
  const mongoRoundTrip = normalizeData(
    dataFromDocuments(documentsFromData(upgraded)),
    maximumCites,
    defaultBoard
  );
  assert.deepEqual(mongoRoundTrip, upgraded, 'Mongo document conversion must preserve normalized data');
  const upgradedIds = new Set(activePostIds(upgraded));
  for (const id of sourceIds) assert.equal(upgradedIds.has(id), true, `post ${id} must be retained`);
  assert.equal(upgraded.version, SCHEMA_VERSION);
  return { data: upgraded, summary: summary(upgraded) };
}

function parseArguments(argv) {
  const values = { source: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--source') values.source = argv[++index] || '';
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return values;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const config = loadConfig();
  const sourcePath = path.resolve(args.source || config.dataFile);
  const parsed = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  const result = verifyParsedUpgrade(parsed, {
    maximumCites: config.limits.maxCites,
    defaultBoard: createDefaultBoard(config)
  });
  console.log(`Upgrade verification passed for ${sourcePath}`);
  for (const [name, count] of Object.entries(result.summary)) console.log(`  ${name}: ${count}`);
  console.log('No source files or database records were changed.');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Upgrade verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { parseArguments, summary, verifyParsedUpgrade };
