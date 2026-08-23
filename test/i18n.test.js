'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadConfig } = require('../config');
const { Translator } = require('../lib/i18n');
const { Renderer } = require('../lib/render');
const { formatDate } = require('../lib/utils');

test('the default English catalog preserves date output and supports bounded interpolation', () => {
  const translator = new Translator(loadConfig(), {
    sample: {
      en: { greeting: 'Hello, {name}!' }
    }
  });
  const timestamp = Date.UTC(2026, 7, 24, 12, 34, 56);
  assert.equal(translator.language, 'en');
  assert.equal(translator.t('form.post'), 'Post');
  assert.equal(translator.t('extension.sample.greeting', { name: 'Chiko' }), 'Hello, Chiko!');
  assert.equal(translator.formatDate(timestamp), formatDate(timestamp));
  assert.equal(translator.t('missing.translation'), 'missing.translation');
});

test('fixed locale files fall back by base language and renderer escapes translated text', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chikochan-i18n-'));
  const localeDir = path.join(directory, 'locales');
  fs.mkdirSync(localeDir);
  fs.writeFileSync(path.join(localeDir, 'en.json'), JSON.stringify({
    'form.post': 'Post',
    'nav.home': 'Home',
    'theme.dark': 'Dark',
    'theme.toggle': 'Toggle dark mode'
  }));
  fs.writeFileSync(path.join(localeDir, 'fr.json'), JSON.stringify({
    'form.post': '<img src=x onerror=alert(1)>',
    'nav.home': 'Accueil'
  }));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const config = {
    ...loadConfig(),
    rootDir: directory,
    i18n: { defaultLanguage: 'fr-FR' }
  };
  const translator = new Translator(config, {
    sample: {
      en: { greeting: 'Hello' },
      fr: { greeting: 'Bonjour' }
    }
  });
  const renderer = new Renderer(config, null, translator);
  assert.equal(translator.language, 'fr-FR');
  assert.equal(translator.t('extension.sample.greeting'), 'Bonjour');
  assert.equal(renderer.t('form.post'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.match(renderer.siteShell('Test', '<main>safe</main>'), /<html lang="fr-FR">/);
  assert.doesNotMatch(renderer.siteShell('Test', renderer.t('form.post')), /<img src=x/);
});

test('translation files and extension namespaces reject unsafe or unbounded definitions', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chikochan-invalid-i18n-'));
  const localeDir = path.join(directory, 'locales');
  fs.mkdirSync(localeDir);
  fs.writeFileSync(path.join(localeDir, 'en.json'), JSON.stringify({ 'form.post': 'Post' }));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = { ...loadConfig(), rootDir: directory, i18n: { defaultLanguage: 'en' } };

  assert.throws(
    () => new Translator(config, { '../unsafe': { en: { greeting: 'No' } } }),
    /Invalid extension translation namespace/
  );
  assert.throws(
    () => new Translator(config, { sample: { en: { 'bad key': 'No' } } }),
    /invalid translation key/
  );
  assert.throws(
    () => new Translator({ ...config, i18n: { defaultLanguage: 'zz-ZZ' } }),
    /No translation catalog/
  );
});
