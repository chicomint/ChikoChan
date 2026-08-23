'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadConfig } = require('../config');

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('STORAGE supports environment configuration and explicit app overrides remain isolated', t => {
  const previousStorage = process.env.STORAGE;
  const previousDataDir = process.env.DATA_DIR;
  t.after(() => {
    restoreEnvironment('STORAGE', previousStorage);
    restoreEnvironment('DATA_DIR', previousDataDir);
  });

  process.env.STORAGE = 'json';
  process.env.DATA_DIR = '/environment-data';
  const environmentConfig = loadConfig();
  assert.equal(environmentConfig.storage, 'json');
  assert.equal(environmentConfig.dataDir, '/environment-data');

  const isolatedDirectory = path.join(os.tmpdir(), 'chikochan-config-override');
  const overrideConfig = loadConfig({ storage: 'mongodb', dataDir: isolatedDirectory });
  assert.equal(overrideConfig.storage, 'mongodb');
  assert.equal(overrideConfig.dataDir, isolatedDirectory);
});

test('report categories are typed, unique, and include the configured default', () => {
  const config = loadConfig({
    reports: {
      defaultCategory: 'custom',
      categories: [{ id: 'custom', label: 'Custom reason' }]
    }
  });
  assert.deepEqual(config.reports.categories, [{ id: 'custom', label: 'Custom reason' }]);

  assert.throws(() => loadConfig({
    reports: {
      categories: [
        { id: 'duplicate', label: 'First' },
        { id: 'duplicate', label: 'Second' }
      ],
      defaultCategory: 'duplicate'
    }
  }), /Duplicate report category/);
  assert.throws(() => loadConfig({ reports: { defaultCategory: 'missing' } }), /must match/);
});

test('media limits and processor commands are typed without requiring installed binaries', () => {
  const config = loadConfig({
    limits: { maxVideoBytes: 123456, maxVideoDurationSeconds: 42 },
    media: { ffprobePath: 'custom-ffprobe', ffmpegPath: 'custom-ffmpeg' }
  });
  assert.equal(config.limits.maxVideoBytes, 123456);
  assert.equal(config.limits.maxVideoDurationSeconds, 42);
  assert.equal(config.media.ffprobePath, 'custom-ffprobe');
  assert.equal(config.media.ffmpegPath, 'custom-ffmpeg');

  assert.throws(() => loadConfig({ limits: { maxVideoPixels: 0 } }), /positive integer/);
  assert.throws(() => loadConfig({ media: { ffprobePath: '' } }), /non-empty command or path/);
});

test('multiple attachments remain opt-in with a hard safety cap', () => {
  assert.equal(loadConfig().limits.maxFilesPerPost, 1);
  assert.equal(loadConfig({ limits: { maxFilesPerPost: 4 } }).limits.maxFilesPerPost, 4);
  assert.throws(
    () => loadConfig({ limits: { maxFilesPerPost: 5 } }),
    /hard safety cap of 4/
  );
  assert.throws(
    () => loadConfig({ limits: { maxFilesPerPost: 0 } }),
    /positive integer/
  );
});

test('localization defaults to English and accepts only bounded language tags', () => {
  assert.equal(loadConfig().i18n.defaultLanguage, 'en');
  assert.equal(loadConfig({ i18n: { defaultLanguage: 'fr-CA' } }).i18n.defaultLanguage, 'fr-CA');
  assert.throws(
    () => loadConfig({ i18n: { defaultLanguage: '../../locale' } }),
    /valid language tag/
  );
});

test('Turnstile is disabled by default and requires typed environment-only secrets', t => {
  assert.equal(loadConfig().antiAbuse.turnstile.enabled, false);
  const enabled = loadConfig({
    antiAbuse: {
      turnstile: {
        enabled: true,
        siteKey: 'site-key',
        secretKey: 'secret-key',
        timeoutMs: 2500,
        failureMode: 'closed',
        allowedHostnames: ['Boards.Example', 'boards.example']
      }
    }
  });
  assert.deepEqual(enabled.antiAbuse.turnstile.allowedHostnames, ['boards.example']);
  assert.equal(enabled.antiAbuse.turnstile.timeoutMs, 2500);
  assert.throws(() => loadConfig({
    antiAbuse: { turnstile: { enabled: true, siteKey: 'site-key', secretKey: '' } }
  }), /requires TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY/);
  assert.throws(() => loadConfig({
    antiAbuse: { turnstile: { failureMode: 'sometimes' } }
  }), /failureMode/);
  assert.throws(() => loadConfig({
    antiAbuse: { turnstile: { allowedHostnames: ['https://boards.example/path'] } }
  }), /valid hostnames/);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chikochan-turnstile-config-'));
  const configPath = path.join(directory, 'config.json');
  const previousPath = process.env.CHIKO_CONFIG;
  t.after(() => {
    restoreEnvironment('CHIKO_CONFIG', previousPath);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.writeFileSync(configPath, JSON.stringify({
    antiAbuse: { turnstile: { secretKey: 'must-not-live-here' } }
  }));
  process.env.CHIKO_CONFIG = configPath;
  assert.throws(() => loadConfig(), /secret keys are environment-only/);
});
