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

test('trusted proxies and production security requirements fail closed', () => {
  assert.equal(loadConfig({ trustProxy: 1 }).trustProxy, 1);
  assert.deepEqual(loadConfig({ trustProxy: ['loopback', '10.0.0.0/8'] }).trustProxy, [
    'loopback', '10.0.0.0/8'
  ]);
  assert.throws(() => loadConfig({
    deployment: { environment: 'production' },
    trustProxy: true,
    storage: 'mongodb',
    mongoUrl: 'mongodb://localhost/chikochan'
  }), /forbidden in production/);

  const production = {
    deployment: { environment: 'production', publicOrigin: 'https://boards.example' },
    storage: 'mongodb',
    mongoUrl: 'mongodb://localhost/chikochan',
    mongo: { requireTransactions: true },
    trustProxy: 1,
    privacy: { abuseFingerprintSecret: 'privacy-secret-that-is-at-least-32-characters' },
    postingAuthorization: {
      enabled: true,
      secret: 'posting-secret-that-is-at-least-32-characters',
      ttlMs: 120000
    },
    rateLimit: { backend: 'mongodb' },
    media: { stripMetadata: true, stripMetadataRequired: true },
    antiAbuse: {
      turnstile: {
        enabled: true,
        siteKey: 'site-key',
        secretKey: 'secret-key',
        failureMode: 'closed'
      }
    }
  };
  assert.equal(loadConfig(production).deployment.isProduction, true);
  assert.throws(
    () => loadConfig({ ...production, rateLimit: { backend: 'memory' } }),
    /shared MongoDB storage|RATE_LIMIT_STORE/
  );
  assert.throws(
    () => loadConfig({ ...production, postingAuthorization: { enabled: false } }),
    /POSTING_AUTH_REQUIRED/
  );
});

test('request, quarantine, metadata, and shared limiter settings are typed', () => {
  const config = loadConfig({
    storage: 'json',
    limits: { maxRequestBytes: 30 * 1024 * 1024 },
    lifecycle: { quarantineRetentionHours: 6 },
    rateLimit: {
      backend: 'memory',
      operations: { deletePassword: { windowMs: 2000, limit: 2 } }
    }
  });
  assert.equal(config.limits.maxRequestBytes, 30 * 1024 * 1024);
  assert.equal(config.lifecycle.quarantineRetentionHours, 6);
  assert.deepEqual(config.rateLimit.operations.deletePassword, { windowMs: 2000, limit: 2 });
  assert.throws(
    () => loadConfig({ rateLimit: { backend: 'redis', redisUrl: '' } }),
    /requires REDIS_URL/
  );
  assert.throws(
    () => loadConfig({ media: { stripMetadata: false, stripMetadataRequired: true } }),
    /cannot be enabled/
  );
});

test('staff MFA requires an environment-style 32-byte encryption key when enabled', () => {
  const config = loadConfig({
    staffMfa: {
      enabled: true,
      issuer: 'ChikoChan Test',
      encryptionKey: '22'.repeat(32)
    }
  });
  assert.equal(config.staffMfa.enabled, true);
  assert.equal(config.staffMfa.issuer, 'ChikoChan Test');
  assert.equal(config.staffMfa.encryptionKey, '22'.repeat(32));
  assert.throws(
    () => loadConfig({ staffMfa: { enabled: true, encryptionKey: 'too-short' } }),
    /encode exactly 32 random bytes/
  );
  assert.throws(
    () => loadConfig({ staffMfa: { issuer: 'bad\nissuer' } }),
    /staffMfa/
  );
});

test('object storage is explicit, credential-safe, and required for declared multi-instance deployments', () => {
  const object = {
    backend: 'object',
    object: {
      endpoint: 'https://objects.example.test',
      region: 'us-east-1',
      quarantineBucket: 'chiko-quarantine',
      publicBucket: 'chiko-public',
      publicBaseUrl: 'https://media.example.test',
      pathStyle: true,
      requestTimeoutMs: 5000,
      accessKeyId: 'synthetic-access-key',
      secretAccessKey: 'synthetic-secret-key'
    }
  };
  const config = loadConfig({ storage: 'json', mediaStorage: object });
  assert.equal(config.mediaStorage.backend, 'object');
  assert.equal(config.mediaStorage.object.publicBucket, 'chiko-public');
  assert.throws(
    () => loadConfig({ storage: 'json', mediaStorage: { ...object, object: { ...object.object, publicBucket: 'chiko-quarantine' } } }),
    /different buckets/
  );
  assert.throws(
    () => loadConfig({ deployment: { environment: 'production', multiInstance: true } }),
    /Production requires shared MongoDB storage|shared object media storage/
  );
});
