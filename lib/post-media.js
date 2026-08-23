'use strict';

const LEGACY_MEDIA_FIELDS = Object.freeze([
  'assetId', 'image', 'imageName', 'imageBytes', 'imageMime', 'mediaKind',
  'width', 'height', 'durationMs', 'frameRate', 'videoCodec', 'audioCodec',
  'thumbnail', 'thumbnailWidth', 'thumbnailHeight', 'md5', 'sha256'
]);

const ATTACHMENT_FIELDS = Object.freeze(['id', ...LEGACY_MEDIA_FIELDS, 'spoiler']);

function postAttachments(post) {
  if (!post || post.imageDeleted) return [];
  if (Array.isArray(post.attachments)) {
    return post.attachments.filter(attachment => attachment && attachment.image);
  }
  return post.image ? [post] : [];
}

function syncPrimaryAttachment(post, attachments = postAttachments(post)) {
  const normalized = Array.isArray(attachments) ? attachments.filter(Boolean) : [];
  post.attachments = normalized;
  for (const field of LEGACY_MEDIA_FIELDS) delete post[field];

  const primary = normalized[0];
  if (primary) {
    for (const field of LEGACY_MEDIA_FIELDS) {
      if (Object.hasOwn(primary, field)) post[field] = primary[field];
    }
    post.spoiler = Boolean(primary.spoiler);
    delete post.imageDeleted;
  } else {
    post.spoiler = false;
  }
  return post;
}

function removePostAttachments(post) {
  syncPrimaryAttachment(post, []);
  post.imageDeleted = true;
}

function restorePostAttachments(post, snapshot) {
  const attachments = structuredClone(postAttachments(snapshot));
  syncPrimaryAttachment(post, attachments);
  if (!attachments.length && snapshot?.imageDeleted) post.imageDeleted = true;
}

module.exports = {
  ATTACHMENT_FIELDS,
  LEGACY_MEDIA_FIELDS,
  postAttachments,
  removePostAttachments,
  restorePostAttachments,
  syncPrimaryAttachment
};
