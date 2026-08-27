'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createDefaultBoard, normalizeData } = require('../lib/store');

function boundedInteger(value, name, fallback, maximum) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 0 and ${maximum}.`);
  }
  return parsed;
}

function createLoadFixture(options = {}) {
  const threadCount = boundedInteger(options.threads, 'threads', 1000, 100000);
  const repliesPerThread = boundedInteger(options.replies, 'replies', 10, 500);
  const board = createDefaultBoard({
    board: { uri: 'load', title: 'Synthetic Load Test' },
    site: { title: 'ChikoChan', description: 'Synthetic fixture' }
  });
  const threads = [];
  let id = 0;
  for (let threadIndex = 0; threadIndex < threadCount; threadIndex += 1) {
    const threadId = ++id;
    const createdAt = 1700000000000 + threadId;
    const replies = [];
    for (let replyIndex = 0; replyIndex < repliesPerThread; replyIndex += 1) {
      const replyId = ++id;
      replies.push({
        id: replyId,
        name: 'Synthetic user',
        comment: `Synthetic reply ${replyIndex + 1} to >>${threadId}`,
        createdAt: createdAt + replyIndex + 1
      });
    }
    threads.push({
      id: threadId,
      boardId: board.id,
      name: 'Synthetic user',
      title: `Synthetic thread ${threadIndex + 1}`,
      comment: 'Harmless generated text for local load and pagination testing.',
      createdAt,
      bumpedAt: createdAt + repliesPerThread,
      replies
    });
  }
  return normalizeData({ lastId: id, boards: [board], threads }, 45, board);
}

function parseArguments(argv) {
  const values = { output: '', threads: undefined, replies: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--output') values.output = argv[++index] || '';
    else if (argument === '--threads') values.threads = argv[++index];
    else if (argument === '--replies') values.replies = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!values.output) throw new Error('--output is required.');
  return values;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const output = path.resolve(args.output);
  if (fs.existsSync(output)) throw new Error(`Refusing to overwrite existing file: ${output}`);
  const fixture = createLoadFixture(args);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(`Wrote ${fixture.threads.length} synthetic threads and ${fixture.lastId} posts to ${output}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Fixture generation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { boundedInteger, createLoadFixture, parseArguments };
