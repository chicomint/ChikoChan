'use strict';

const { performance } = require('node:perf_hooks');

function boundedInteger(value, name, fallback, minimum, maximum) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function parseArguments(argv) {
  const values = { url: 'http://127.0.0.1:3000', path: '/healthz', requests: 100, concurrency: 10, timeoutMs: 5000 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--url') values.url = argv[++index] || '';
    else if (argument === '--path') values.path = argv[++index] || '';
    else if (argument === '--requests') values.requests = argv[++index];
    else if (argument === '--concurrency') values.concurrency = argv[++index];
    else if (argument === '--timeout-ms') values.timeoutMs = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  const url = new URL(values.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('--url must be an HTTP(S) origin without credentials, query, or fragment.');
  }
  if (!values.path.startsWith('/') || values.path.startsWith('//') || values.path.includes('#')) {
    throw new Error('--path must be an absolute HTTP path.');
  }
  return {
    url: url.origin,
    path: values.path,
    requests: boundedInteger(values.requests, 'requests', 100, 1, 1000000),
    concurrency: boundedInteger(values.concurrency, 'concurrency', 10, 1, 1000),
    timeoutMs: boundedInteger(values.timeoutMs, 'timeout-ms', 5000, 100, 60000)
  };
}

function percentile(sorted, fraction) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function runLoad(options, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const clock = dependencies.clock || (() => performance.now());
  const durations = [];
  const statuses = new Map();
  let next = 0;
  let failures = 0;
  const startedAt = clock();
  async function worker() {
    while (next < options.requests) {
      next += 1;
      const started = clock();
      try {
        const response = await fetchImpl(`${options.url}${options.path}`, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(options.timeoutMs)
        });
        await response.arrayBuffer();
        statuses.set(response.status, (statuses.get(response.status) || 0) + 1);
        if (response.status < 200 || response.status >= 400) failures += 1;
      } catch {
        failures += 1;
        statuses.set('error', (statuses.get('error') || 0) + 1);
      }
      durations.push(clock() - started);
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, options.requests) }, worker));
  const elapsedMs = Math.max(0.001, clock() - startedAt);
  durations.sort((left, right) => left - right);
  return {
    requests: options.requests,
    failures,
    elapsedMs,
    requestsPerSecond: options.requests / (elapsedMs / 1000),
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    statuses: Object.fromEntries([...statuses.entries()].map(([status, count]) => [String(status), count]))
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await runLoad(options);
  console.log(JSON.stringify(result, null, 2));
  if (result.failures) process.exitCode = 1;
}

if (require.main === module) main().catch(error => {
  console.error(`Load test failed: ${error.message}`);
  process.exitCode = 1;
});

module.exports = { boundedInteger, parseArguments, percentile, runLoad };
