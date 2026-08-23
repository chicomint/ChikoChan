'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { formatDate: legacyFormatDate } = require('./utils');

const LANGUAGE_PATTERN = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i;
const KEY_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

function canonicalLanguage(value) {
  const supplied = String(value || '').trim();
  if (!LANGUAGE_PATTERN.test(supplied)) throw new Error('i18n.defaultLanguage must be a valid language tag.');
  try {
    return Intl.getCanonicalLocales(supplied)[0];
  } catch {
    throw new Error('i18n.defaultLanguage must be a valid language tag.');
  }
}

function validatedCatalog(value, label, maximum = 1000) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a flat translation object.`);
  }
  const entries = Object.entries(value);
  if (entries.length > maximum) throw new Error(`${label} contains too many translation entries.`);
  const catalog = Object.create(null);
  for (const [key, translation] of entries) {
    if (!KEY_PATTERN.test(key)) throw new Error(`${label} contains an invalid translation key.`);
    if (typeof translation !== 'string' || translation.length > 1000 || translation.includes('\0')) {
      throw new Error(`${label}.${key} must be a string no longer than 1000 characters.`);
    }
    catalog[key] = translation;
  }
  return catalog;
}

function readCatalog(rootDir, language, required = false) {
  const filename = `${language.toLowerCase()}.json`;
  const localeDir = path.join(rootDir, 'locales');
  const catalogPath = path.join(localeDir, filename);
  if (!catalogPath.startsWith(`${localeDir}${path.sep}`)) throw new Error('Invalid locale path.');
  if (!fs.existsSync(catalogPath)) {
    if (required) throw new Error(`Required translation catalog locales/${filename} is missing.`);
    return null;
  }
  try {
    return validatedCatalog(JSON.parse(fs.readFileSync(catalogPath, 'utf8')), `locales/${filename}`);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Could not parse locales/${filename}: ${error.message}`);
    throw error;
  }
}

function languageCandidates(language) {
  const candidates = [language.toLowerCase()];
  const base = language.split('-')[0].toLowerCase();
  if (!candidates.includes(base)) candidates.push(base);
  return candidates;
}

function extensionCatalogs(definitions, language) {
  if (definitions === undefined || definitions === null) return Object.create(null);
  if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) {
    throw new Error('Extension translations must be an object keyed by namespace.');
  }
  const namespaces = Object.entries(definitions);
  if (namespaces.length > 50) throw new Error('At most 50 extension translation namespaces may be registered.');
  const merged = Object.create(null);
  for (const [namespace, languageMap] of namespaces) {
    if (!NAMESPACE_PATTERN.test(namespace)) throw new Error(`Invalid extension translation namespace: ${namespace}.`);
    if (!languageMap || typeof languageMap !== 'object' || Array.isArray(languageMap)) {
      throw new Error(`Extension translations for ${namespace} must be keyed by language.`);
    }
    const normalized = new Map();
    for (const [tag, catalog] of Object.entries(languageMap)) {
      normalized.set(canonicalLanguage(tag).toLowerCase(), validatedCatalog(
        catalog,
        `extension translations ${namespace}.${tag}`,
        500
      ));
    }
    const candidates = [...languageCandidates(language), 'en'];
    const selected = candidates.map(candidate => normalized.get(candidate)).find(Boolean);
    for (const [key, translation] of Object.entries(selected || {})) {
      merged[`extension.${namespace}.${key}`] = translation;
    }
  }
  return merged;
}

class Translator {
  constructor(config, extensions = {}) {
    this.language = canonicalLanguage(config.i18n.defaultLanguage);
    this.fallback = readCatalog(config.rootDir, 'en', true);
    this.catalog = this.fallback;
    for (const candidate of languageCandidates(this.language)) {
      const loaded = readCatalog(config.rootDir, candidate);
      if (loaded) {
        this.catalog = { ...this.fallback, ...loaded };
        break;
      }
    }
    if (this.language.split('-')[0].toLowerCase() !== 'en' && this.catalog === this.fallback) {
      throw new Error(`No translation catalog is available for ${this.language}.`);
    }
    this.extensions = extensionCatalogs(extensions, this.language);
    this.dateFormatter = this.language === 'en' ? null : new Intl.DateTimeFormat(this.language, {
      weekday: 'short',
      year: '2-digit',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    });
  }

  t(key, variables = {}) {
    const lookup = String(key || '');
    const template = Object.hasOwn(this.extensions, lookup)
      ? this.extensions[lookup]
      : (Object.hasOwn(this.catalog, lookup) ? this.catalog[lookup] : this.fallback[lookup]);
    const value = template === undefined ? lookup : template;
    return value.replace(/\{([a-z][a-z0-9_]*)\}/gi, (match, name) => (
      Object.hasOwn(variables, name) ? String(variables[name]) : match
    ));
  }

  formatDate(timestamp) {
    if (!this.dateFormatter) return legacyFormatDate(timestamp);
    return this.dateFormatter.format(new Date(Number(timestamp) || Date.now()));
  }
}

module.exports = {
  Translator,
  canonicalLanguage,
  extensionCatalogs,
  readCatalog,
  validatedCatalog
};
