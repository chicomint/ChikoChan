'use strict';

const sanitizeHTML = require('sanitize-html');
const { httpError } = require('./utils');
const { httpUrl } = require('./text-page');

const SECTION_TYPES = ['banner', 'welcome', 'news', 'activeThreads', 'boards', 'latestImages', 'latestPosts', 'statistics', 'footer', 'image', 'text', 'html'];
const TITLES = { banner: 'Banner', welcome: 'Welcome', news: 'News', activeThreads: 'Active Threads', boards: 'Boards', latestImages: 'Latest Images', latestPosts: 'Latest Posts', statistics: 'Around ChikoChan', footer: 'Footer', image: 'Custom image', text: 'Custom text', html: 'Custom HTML' };
const IMAGE_PATH = /^\/(?:banner\.png|banner\/[a-z0-9][a-z0-9._-]{0,199}\.(?:jpe?g|png|gif|webp)|src\/[a-z0-9][a-z0-9._-]{0,199}\.(?:jpe?g|png|gif|webp))$/i;
const COLOR = /^#[a-f0-9]{6}$/i;
const FONTS = { inherit: 'inherit', arial: 'Arial,Helvetica,sans-serif', verdana: 'Verdana,Arial,sans-serif', georgia: 'Georgia,serif', monospace: 'monospace' };
const PAGE_BACKGROUND_KEYS = ['background', 'gradientEnd', 'image', 'size', 'position', 'repeat', 'overlay', 'overlayColor'];
const THEME_IDS = ['light', 'dark', 'yotsuba-b', 'miku'];
const cleanText = (value, limit) => String(value || '').replace(/\0/g, '').slice(0, limit);

function safeHTML(value) {
  return sanitizeHTML(cleanText(value, 20000), {
    allowedTags: ['p', 'br', 'strong', 'em', 's', 'u', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'a', 'hr'],
    allowedAttributes: { a: ['href', 'title', 'rel'] },
    allowedSchemes: ['http', 'https'], allowProtocolRelative: false,
    transformTags: { a: (tag, attributes) => ({ tagName: 'a', attribs: { href: httpUrl(attributes.href) || (/^\/(?!\/)[^\s<>"'\\]*$/.test(attributes.href || '') ? attributes.href : '#'), rel: 'noopener noreferrer', title: cleanText(attributes.title, 200) } }) }
  });
}

function defaultLayout() {
  return { version: 1, gap: 20, maxWidth: 1470, defaultTheme: 'light', navigation: {}, pageBackground: {}, sections: SECTION_TYPES.slice(0, 9).map(type => ({
    id: type, type, title: type === 'statistics' ? '' : TITLES[type], hidden: false, content: '', image: '', link: '',
    desktop: type === 'activeThreads' ? 7 : type === 'boards' ? 5 : type === 'latestImages' ? 5 : type === 'latestPosts' ? 7 : 12,
    tablet: ['activeThreads', 'boards'].includes(type) ? 6 : type === 'latestImages' ? 5 : type === 'latestPosts' ? 7 : 12,
    mobile: 12, positions: {}, style: {}, header: {}
  })) };
}

function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function number(value, min, max, name) {
  if (!Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max) throw httpError(400, `${name} must be between ${min} and ${max}.`);
  return Math.round(Number(value) * 100) / 100;
}
function styles(source = {}) {
  if (!object(source)) throw httpError(400, 'Invalid section styling.');
  const result = {};
  for (const key of ['background', 'color', 'borderColor', 'gradientEnd', 'overlayColor']) {
    if (!source[key]) continue;
    if (!COLOR.test(source[key])) throw httpError(400, `Invalid ${key} color.`);
    result[key] = source[key].toLowerCase();
  }
  for (const [key, range] of Object.entries({ height: [0, 1600], padding: [0, 100], radius: [0, 80], borderWidth: [0, 12], fontSize: [10, 64], overlay: [0, 1] })) {
    if (source[key] !== undefined && source[key] !== '') result[key] = number(source[key], ...range, key);
  }
  for (const [key, options] of Object.entries({ size: ['cover', 'contain', 'auto'], position: ['center', 'top', 'bottom', 'left', 'right'], repeat: ['no-repeat', 'repeat', 'repeat-x', 'repeat-y'], borderStyle: ['solid', 'dashed', 'dotted', 'none'], font: Object.keys(FONTS), align: ['left', 'center', 'right'] })) {
    if (!source[key]) continue;
    if (!options.includes(source[key])) throw httpError(400, `Invalid ${key}.`);
    result[key] = source[key];
  }
  if (source.image) {
    if (!IMAGE_PATH.test(source.image)) throw httpError(400, 'Choose an uploaded image or a local banner.');
    result.image = source.image;
  }
  return result;
}

function positions(value) {
  if (value === undefined) return {};
  if (!object(value)) throw httpError(400, 'Invalid section placement.');
  const result = {};
  for (const view of ['desktop', 'tablet', 'mobile']) {
    if (value[view] === undefined) continue;
    if (!object(value[view])) throw httpError(400, 'Invalid responsive placement.');
    result[view] = { x: number(value[view].x, 0, 12, 'Horizontal position'), y: number(value[view].y, 0, 100000, 'Vertical position') };
    if (value[view].anchor) {
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value[view].anchor)) throw httpError(400, 'Invalid placement anchor.');
      result[view].anchor = value[view].anchor;
      result[view].offset = number(value[view].offset ?? 0, 0, 100000, 'Anchor spacing');
    }
  }
  return result;
}

function pageBackground(value = {}) {
  if (!object(value)) throw httpError(400, 'Invalid page background.');
  return styles(Object.fromEntries(Object.entries(value).filter(([key]) => PAGE_BACKGROUND_KEYS.includes(key))));
}

function validateLayout(value) {
  if (!object(value) || !Array.isArray(value.sections) || !value.sections.length || value.sections.length > 30) throw httpError(400, 'A layout needs between 1 and 30 sections.');
  const defaultTheme = value.defaultTheme === undefined ? 'light' : value.defaultTheme;
  if (!THEME_IDS.includes(defaultTheme)) throw httpError(400, 'Choose a supported default theme.');
  const ids = new Set();
  const unique = new Set();
  const sections = value.sections.map(section => {
    if (!object(section) || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(section.id || '') || ids.has(section.id) || !SECTION_TYPES.includes(section.type)) throw httpError(400, 'Invalid or duplicate section.');
    ids.add(section.id);
    if (!['image', 'text', 'html'].includes(section.type)) {
      if (unique.has(section.type)) throw httpError(400, 'Built-in sections may only appear once.');
      unique.add(section.type);
    }
    if (section.image && !IMAGE_PATH.test(section.image)) throw httpError(400, 'Invalid section image.');
    const link = section.link || '';
    if (link && !httpUrl(link) && !/^\/(?!\/)[^\s<>"'\\]*$/.test(link)) throw httpError(400, 'Invalid image link.');
    return { id: section.id, type: section.type, title: cleanText(section.title, 120), hidden: section.hidden === true,
      content: section.type === 'html' ? safeHTML(section.content) : cleanText(section.content, 20000), image: section.image || '', link,
      desktop: number(section.desktop ?? 12, 1, 12, 'Desktop columns'), tablet: number(section.tablet ?? 12, 1, 12, 'Tablet columns'), mobile: number(section.mobile ?? 12, 1, 12, 'Mobile columns'),
      positions: positions(section.positions), style: styles(section.style), header: styles(section.header) };
  });
  const byId = new Map(sections.map(section => [section.id, section]));
  for (const section of sections) for (const view of ['desktop', 'tablet', 'mobile']) {
    const seen = new Set([section.id]);
    let anchor = section.positions[view]?.anchor;
    while (anchor) {
      if (!byId.has(anchor) || seen.has(anchor)) throw httpError(400, 'Section placement contains a missing or circular anchor.');
      seen.add(anchor); anchor = byId.get(anchor).positions[view]?.anchor;
    }
  }
  return { version: 1, sections, gap: number(value.gap ?? 16, 0, 80, 'Spacing'), maxWidth: number(value.maxWidth ?? 1240, 320, 2000, 'Page width'), defaultTheme, navigation: styles(value.navigation), pageBackground: pageBackground(value.pageBackground) };
}

function normalizeHomepage(value) {
  const source = object(value) ? value : {};
  const safe = layout => { try { return validateLayout(layout); } catch { return defaultLayout(); } };
  return { revision: Number.isSafeInteger(source.revision) ? source.revision : 0,
    published: safe(source.published), draft: safe(source.draft || source.published),
    history: (Array.isArray(source.history) ? source.history : []).slice(-12).filter(object).map(item => ({ id: cleanText(item.id, 80), at: Number(item.at) || 0, label: cleanText(item.label, 80), layout: safe(item.layout) })),
    savedLayouts: (Array.isArray(source.savedLayouts) ? source.savedLayouts : []).slice(-8).filter(object).map(item => ({ id: cleanText(item.id, 80), at: Number(item.at) || 0, label: cleanText(item.label, 80), layout: safe(item.layout) })) };
}

function cssStyles(style) {
  const s = styles(style);
  const rules = [];
  const properties = { background: 'background-color', color: 'color', borderColor: 'border-color', radius: 'border-radius', borderWidth: 'border-width', borderStyle: 'border-style', height: 'min-height', padding: 'padding', fontSize: 'font-size', align: 'text-align' };
  for (const [key, property] of Object.entries(properties)) if (s[key] !== undefined) rules.push(`${property}:${s[key]}${['radius', 'borderWidth', 'height', 'padding', 'fontSize'].includes(key) ? 'px' : ''}`);
  if (s.font) rules.push(`font-family:${FONTS[s.font]}`);
  const backgrounds = [];
  if (s.image && s.overlay) {
    const c = s.overlayColor || '#000000';
    const rgb = [1, 3, 5].map(offset => parseInt(c.slice(offset, offset + 2), 16)).join(',');
    backgrounds.push(`linear-gradient(rgba(${rgb},${s.overlay}),rgba(${rgb},${s.overlay}))`);
  }
  if (s.image) backgrounds.push(`url("${s.image}")`);
  else if (s.gradientEnd) backgrounds.push(`linear-gradient(120deg,${s.background || '#ffffff'},${s.gradientEnd})`);
  if (backgrounds.length) rules.push(`background-image:${backgrounds.join(',')}`);
  if (s.image) rules.push(`background-size:${s.size || 'cover'};background-position:${s.position || 'center'};background-repeat:${s.repeat || 'no-repeat'}`);
  return rules.join(';');
}

function layoutCSS(value) {
  const layout = validateLayout(value);
  const background = layout.pageBackground;
  // Always reset first: a cleared draft must override the published preview CSS.
  const page = `html body.site-home[data-homepage]{background:var(--bg-gradient),var(--bg-color);${background.image || background.background || background.gradientEnd ? `background-image:none;${cssStyles(background)}` : ''}}`;
  return [page, `.home-layout{max-width:${layout.maxWidth}px;gap:${layout.gap}px}`, `.utility-nav{${cssStyles(layout.navigation)}}`, ...layout.sections.flatMap(section => [
    `.home-section[data-section="${section.id}"]{grid-column:span ${Math.round(section.desktop)};${cssStyles(section.style)}}`,
    `.home-section[data-section="${section.id}"]>.section-heading{${cssStyles(section.header)}}`,
    ...(section.type === 'image' && section.style.height ? [`.home-section[data-section="${section.id}"] .custom-image img{height:${section.style.height}px;object-fit:contain}`] : []),
    `@media(max-width:960px){.home-section[data-section="${section.id}"]{grid-column:span ${Math.round(section.tablet)}}}`,
    `@media(max-width:600px){.home-section[data-section="${section.id}"]{grid-column:span ${Math.round(section.mobile)}}}`
  ])].join('\n');
}

function siteAssetPaths(customization = {}) {
  const paths = [customization.logoPath, customization.faviconPath, ...(customization.assets || []).map(asset => asset.path), ...(customization.news || []).flatMap(article => (article.images || []).map(image => image.src))];
  const home = customization.homepage || {};
  for (const layout of [home.draft, home.published, ...(home.history || []).map(item => item.layout), ...(home.savedLayouts || []).map(item => item.layout)]) {
    if (!layout) continue;
    paths.push(layout.navigation?.image, layout.pageBackground?.image);
    for (const section of layout.sections || []) paths.push(section.image, section.header?.image, section.style?.image);
  }
  return [...new Set(paths.filter(Boolean))];
}

function normalizeNews(value) {
  if (!Array.isArray(value)) return [];
  const ids = new Set();
  return value.slice(-100).filter(item => object(item) && /^[a-zA-Z0-9_-]{1,80}$/.test(item.id || '') && !ids.has(item.id) && ids.add(item.id)).map(item => ({
    id: item.id, title: cleanText(item.title, 160), author: cleanText(item.author || 'ChikoChan', 80), content: cleanText(item.content, 50000),
    status: item.status === 'published' ? 'published' : 'draft', publishedAt: Number.isFinite(Number(item.publishedAt)) && Number(item.publishedAt) >= 0 && Number(item.publishedAt) <= 8640000000000000 ? Number(item.publishedAt) : 0, updatedAt: Number(item.updatedAt) || 0,
    images: (Array.isArray(item.images) ? item.images : []).slice(0, 12).filter(image => object(image) && IMAGE_PATH.test(image.src || '')).map(image => ({ src: image.src, caption: cleanText(image.caption, 1000), alt: cleanText(image.alt, 300), link: httpUrl(image.link) }))
  }));
}

module.exports = { TITLES, SECTION_TYPES, IMAGE_PATH, siteAssetPaths, safeHTML, styles, defaultLayout, validateLayout, normalizeHomepage, normalizeNews, layoutCSS };
