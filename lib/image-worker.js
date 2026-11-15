'use strict';

const fs = require('node:fs');
const sharp = require('sharp');
sharp.cache(false);
sharp.concurrency(1);
const MIME_BY_EXTENSION = new Map([['.jpg','image/jpeg'],['.png','image/png'],['.gif','image/gif'],['.webp','image/webp']]);
function uploadError(message) { return new Error(message); }

async function prepareImage(filePath, inspected, config) {
  const image = sharp(filePath, { animated: true, limitInputPixels: config.limits.maxImagePixels, failOn: 'warning' });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height || metadata.width > config.limits.maxImageDimension
    || (metadata.pageHeight || metadata.height) > config.limits.maxImageDimension
    || metadata.width * metadata.height > config.limits.maxImagePixels || (metadata.pages || 1) > 500) {
    throw uploadError('The image dimensions or animation exceed the configured safety limits.');
  }
  // Decoding also rejects truncated files which happen to have a valid header.
  await image.clone().stats();
  const animatedPng = inspected.mime === 'image/png' && fs.readFileSync(filePath).includes(Buffer.from('acTL'));
  if (animatedPng) {
    if (config.media.stripMetadataRequired) throw uploadError('Animated PNG metadata cannot be safely stripped on this server.');
    return { extension: '.png', mime: 'image/png', metadataStripped: false };
  }
  const extension = inspected.convert ? ((metadata.pages || 1) > 1 ? '.webp' : metadata.hasAlpha ? '.png' : '.jpg')
    : inspected.mime === 'image/jpeg' ? '.jpg' : inspected.extensions[0];
  const output = `${filePath}.converted${extension}`;
  try {
    let pipeline = image;
    if ((metadata.pages || 1) === 1) pipeline = pipeline.rotate();
    if (extension === '.jpg') pipeline = pipeline.jpeg({ quality: 90 });
    else if (extension === '.png') pipeline = pipeline.png();
    else if (extension === '.gif') pipeline = pipeline.gif();
    else pipeline = pipeline.webp({ quality: 90 });
    await pipeline.timeout({ seconds: Math.ceil(config.media.processTimeoutMs / 1000) }).toFile(output);
    if (fs.statSync(output).size > config.limits.maxFileBytes) throw uploadError('Converted image exceeds the upload size limit.');
    fs.renameSync(output, filePath);
    return { extension, mime: MIME_BY_EXTENSION.get(extension), metadataStripped: true };
  } finally { fs.rmSync(output, { force: true }); }
}

const [filePath, inspected, config] = process.argv.slice(2);
prepareImage(filePath, JSON.parse(inspected), JSON.parse(config)).then(result => {
  process.stdout.write(JSON.stringify(result));
}).catch(() => { process.exitCode = 1; });
