'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { allPosts, SCHEMA_VERSION } = require('./store');
const { postAttachments } = require('./post-media');

const PRIVATE_NETWORK_FIELDS = new Set([
  'ip', 'ipAddress', 'rawIp', 'remoteAddress', 'ipAddresses', 'posterIp'
]);

function issue(list, severity, code, message, details = {}) {
  if (list.length >= 200) return;
  list.push({ severity, code, message, ...details });
}

function findPrivateNetworkFields(value, location, findings, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findPrivateNetworkFields(entry, `${location}[${index}]`, findings, seen));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (PRIVATE_NETWORK_FIELDS.has(key)) findings.push(`${location}.${key}`);
    else findPrivateNetworkFields(entry, `${location}.${key}`, findings, seen);
  }
}

async function diagnose(config, store, uploads) {
  await store.ready;
  const data = store.read();
  const issues = [];
  const posts = allPosts(data);
  const expectedReferences = new Map();
  const knownPaths = new Set();
  let attachmentCount = 0;

  for (const { post } of posts) {
    for (const attachment of postAttachments(post)) {
      attachmentCount += 1;
      if (!attachment.assetId) {
        issue(issues, 'error', 'attachment-missing-asset-id', 'An attachment has no media asset ID.', {
          postId: post.id,
          attachmentId: attachment.id
        });
        continue;
      }
      expectedReferences.set(attachment.assetId, (expectedReferences.get(attachment.assetId) || 0) + 1);
    }
  }
  for (const entry of data.trash) {
    const retainedPosts = entry.kind === 'thread'
      ? [entry.post, ...(entry.post.replies || [])]
      : [entry.post];
    for (const post of retainedPosts) {
      for (const attachment of postAttachments(post)) {
        attachmentCount += 1;
        if (attachment.assetId) {
          expectedReferences.set(attachment.assetId, (expectedReferences.get(attachment.assetId) || 0) + 1);
        }
      }
    }
  }

  const assets = new Map(data.media.map(asset => [asset.id, asset]));
  for (const [assetId, count] of expectedReferences) {
    if (!assets.has(assetId)) {
      issue(issues, 'error', 'attachment-asset-missing', 'An attachment references a missing media record.', {
        assetId,
        expectedReferences: count
      });
    }
  }
  for (const asset of data.media) {
    const expected = expectedReferences.get(asset.id) || 0;
    if (Number(asset.refCount) !== expected) {
      issue(issues, 'error', 'media-reference-mismatch', 'A media reference count does not match stored attachments.', {
        assetId: asset.id,
        expectedReferences: expected,
        storedReferences: Number(asset.refCount) || 0
      });
    }
    for (const [kind, relativePath] of [['original', asset.path], ['thumbnail', asset.thumbnail]]) {
      if (!relativePath) continue;
      knownPaths.add(relativePath);
      const filePath = uploads.pathForRelative(relativePath);
      if (!filePath || !fs.existsSync(filePath)) {
        issue(issues, 'error', 'media-file-missing', `A media ${kind} is missing from storage.`, {
          assetId: asset.id,
          path: String(relativePath)
        });
        continue;
      }
      if (!uploads.inspectServedFile(path.basename(relativePath))) {
        issue(issues, 'error', 'media-file-invalid', `A media ${kind} no longer passes signature validation.`, {
          assetId: asset.id,
          path: String(relativePath)
        });
      }
    }
  }

  try {
    for (const entry of fs.readdirSync(config.uploadDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const relativePath = `src/${entry.name}`;
      if (!knownPaths.has(relativePath)) {
        issue(issues, 'warning', 'untracked-upload-file', 'An upload file is not referenced by the media database and was not deleted.', {
          path: relativePath
        });
      }
    }
  } catch (error) {
    issue(issues, 'error', 'upload-directory-unreadable', 'The upload directory could not be read.', {
      reason: error.code || 'read-error'
    });
  }

  try {
    fs.accessSync(config.dataDir, fs.constants.R_OK | fs.constants.W_OK);
    fs.accessSync(config.uploadDir, fs.constants.R_OK | fs.constants.W_OK);
  } catch (error) {
    issue(issues, 'error', 'storage-not-writable', 'Data or upload storage is not readable and writable.', {
      reason: error.code || 'access-error'
    });
  }

  const privateFields = [];
  findPrivateNetworkFields(data, 'state', privateFields);
  for (const location of privateFields.slice(0, 20)) {
    issue(issues, 'error', 'raw-network-field', 'A forbidden raw network identity field exists in stored state.', {
      location
    });
  }

  const now = Date.now();
  const errors = issues.filter(entry => entry.severity === 'error').length;
  const warnings = issues.filter(entry => entry.severity === 'warning').length;
  return {
    ok: errors === 0,
    generatedAt: now,
    storage: config.storage,
    schema: { current: SCHEMA_VERSION, stored: Number(data.version) || 0 },
    counts: {
      boards: data.boards.length,
      threads: data.threads.length,
      posts: posts.length,
      attachments: attachmentCount,
      media: data.media.length,
      reports: data.reports.length,
      sanctions: data.bans.length,
      trash: data.trash.length
    },
    maintenance: {
      expiredTrash: data.trash.filter(entry => Number(entry.purgeAt) <= now).length,
      expiredActiveSanctions: data.bans.filter(entry => entry.active !== false
        && entry.expiresAt && Number(entry.expiresAt) <= now).length
    },
    processors: {
      thumbnails: Boolean(uploads.ffmpegAvailable),
      video: Boolean(uploads.videoAvailable)
    },
    summary: { errors, warnings },
    issues
  };
}

module.exports = { diagnose };
