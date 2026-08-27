'use strict';

const crypto = require('node:crypto');
const { extractReferences } = require('./store');
const { postAttachments, removePostAttachments, syncPrimaryAttachment } = require('./post-media');
const { httpError, verifyPassword } = require('./utils');

const DUMMY_PASSWORD_HASH = 'scrypt$BwcHBwcHBwcHBwcHBwcHBw$GKYWtQJHPAUWMYDDM64Z3uAtYBUxFuquueA16wVbm9M';

function withoutId(document) {
  if (!document) return null;
  const { _id, ...value } = document;
  return value;
}

function resultDocument(result) {
  return result?.value || result || null;
}

function formBoolean(value) {
  if (Array.isArray(value)) return formBoolean(value.at(-1));
  return value === true || value === 1 || ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function uploadList(value) {
  return (Array.isArray(value) ? value : [value]).filter(Boolean);
}

function uploadHashes(uploads) {
  return [...new Set(uploadList(uploads).flatMap(upload => [
    upload.sha256,
    upload.contentSha256,
    upload._asset?.sourceSha256,
    upload._asset?.contentSha256
  ]).map(value => String(value || '').toLowerCase()).filter(value => /^[a-f0-9]{64}$/.test(value)))];
}

function attachmentFromAsset(asset, upload, spoiler) {
  return {
    id: crypto.randomUUID(),
    assetId: asset.id,
    image: asset.path,
    imageName: upload.imageName,
    imageBytes: Number(asset.bytes) || 0,
    imageMime: asset.mime,
    mediaKind: asset.kind,
    width: Number(asset.width) || 0,
    height: Number(asset.height) || 0,
    ...(asset.durationMs ? { durationMs: Number(asset.durationMs) } : {}),
    ...(asset.frameRate ? { frameRate: Number(asset.frameRate) } : {}),
    ...(asset.videoCodec ? { videoCodec: asset.videoCodec } : {}),
    ...(asset.audioCodec ? { audioCodec: asset.audioCodec } : {}),
    ...(asset.thumbnail ? {
      thumbnail: asset.thumbnail,
      thumbnailWidth: Number(asset.thumbnailWidth) || 0,
      thumbnailHeight: Number(asset.thumbnailHeight) || 0
    } : {}),
    md5: asset.md5,
    sha256: asset.sha256,
    contentSha256: asset.contentSha256 || asset.sha256,
    metadataStripped: asset.metadataStripped === true,
    spoiler: Boolean(spoiler)
  };
}

class MongoPostRepository {
  constructor(config, store, service) {
    this.config = config;
    this.store = store;
    this.service = service;
  }

  get available() {
    return this.store.supportsTransactions === true;
  }

  async nextPostId(session) {
    const result = await this.store.db.collection('metadata').findOneAndUpdate(
      { _id: 'state' },
      { $inc: { lastId: 1 } },
      { session, returnDocument: 'after' }
    );
    const state = resultDocument(result);
    const id = Number(state?.lastId);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('MongoDB could not allocate a safe post ID.');
    return id;
  }

  async context(boardId, uploads, requestContext, session) {
    const state = await this.store.db.collection('metadata').findOne({ _id: 'state' }, { session });
    const board = await this.store.db.collection('boards').findOne(
      { _id: String(boardId || ''), enabled: { $ne: false } },
      { session }
    );
    if (!state?.meta?.siteSecret) throw new Error('MongoDB site metadata is unavailable.');
    if (!board) throw httpError(404, 'Board not found.');
    const cleanBoard = withoutId(board);
    const posterKey = this.service.fingerprint(requestContext.clientKey, { meta: state.meta });
    const hashes = uploadHashes(uploads);
    const scope = { $or: [{ scope: 'global' }, { scope: 'board', boardId: cleanBoard.id }] };
    const sanctionTargets = [{ target: 'poster', posterKey }];
    if (hashes.length) sanctionTargets.push({ target: 'file', fileHash: { $in: hashes } });
    const bans = await this.store.db.collection('bans').find({
      active: { $ne: false },
      ...scope,
      $and: [{ $or: sanctionTargets }]
    }, { session }).toArray();
    const mediaHashBans = hashes.length
      ? await this.store.db.collection('mediaHashBans').find({
        active: { $ne: false },
        sha256: { $in: hashes },
        ...scope
      }, { session }).toArray()
      : [];
    const actor = requestContext.actor && !requestContext.actor.legacy
      ? await this.store.db.collection('staff').findOne({ _id: requestContext.actor.id }, { session })
      : null;
    return {
      board: cleanBoard,
      posterKey,
      data: {
        meta: state.meta,
        boards: [cleanBoard],
        bans: bans.map(withoutId),
        mediaHashBans: mediaHashBans.map(withoutId),
        staff: actor ? [withoutId(actor)] : [],
        media: [],
        mediaDecisions: [],
        moderationLog: []
      }
    };
  }

  async consumeWarning(warning, session) {
    const now = Date.now();
    const result = await this.store.db.collection('bans').updateOne(
      { _id: warning.id, active: { $ne: false } },
      { $set: { active: false, deliveredAt: now, updatedAt: now } },
      { session }
    );
    if (result.modifiedCount !== 1) throw httpError(409, 'Posting restriction changed. Retry the request.');
    return {
      warning: true,
      message: warning.reasonVisible && warning.reason
        ? `Staff warning: ${warning.reason} Retry your post after reviewing this warning.`
        : 'Staff issued a warning for this posting identity. Retry your post after reviewing it.'
    };
  }

  async assertUniqueMedia(board, uploads, session) {
    const reject = this.service.boardSetting(
      board,
      'rejectDuplicateImages',
      this.config.features.rejectDuplicateImages
    );
    if (!reject || !uploads.length) return;
    const hashes = uploads.map(upload => String(upload.sha256 || '')).filter(Boolean);
    if (new Set(hashes).size !== hashes.length) throw httpError(409, 'That file has already been posted.');
    const duplicate = await this.store.db.collection('media').findOne({
      state: 'approved',
      refCount: { $gt: 0 },
      sha256: { $in: hashes }
    }, { projection: { _id: 1 }, session });
    if (duplicate) throw httpError(409, 'That file has already been posted.');
  }

  async registerMedia(uploads, boardId, context, session) {
    const attachments = [];
    const decisions = [];
    const spoiler = formBoolean(context.spoiler);
    for (const upload of uploads) {
      if (!upload?._asset || upload._asset.state !== 'approved' || !upload._asset.path) {
        throw httpError(409, 'Media processing has not reached the approved state.');
      }
      const candidate = { ...upload._asset };
      delete candidate.refCount;
      const result = await this.store.db.collection('media').findOneAndUpdate(
        { _id: candidate.id },
        { $setOnInsert: { _id: candidate.id, ...candidate }, $inc: { refCount: 1 } },
        { upsert: true, returnDocument: 'after', session }
      );
      const asset = withoutId(resultDocument(result));
      if (!asset || asset.state !== 'approved' || !asset.path) {
        throw httpError(409, 'Matching media is not approved for publication.');
      }
      if (asset.path !== candidate.path) upload._deduplicated = true;
      attachments.push(attachmentFromAsset(asset, upload, spoiler));
      const decisionId = crypto.randomUUID();
      decisions.push({
        _id: decisionId,
        id: decisionId,
        sha256: String(upload.sha256 || candidate.sourceSha256 || '').toLowerCase(),
        contentSha256: String(upload.contentSha256 || candidate.contentSha256 || '').toLowerCase(),
        boardId: String(boardId || ''),
        decision: 'approved',
        reasonCode: 'pipeline-approved',
        reason: 'Media passed the configured validation and moderation pipeline.',
        provider: '',
        providerReference: '',
        actorId: String(context.actor?.id || 'system'),
        actorName: String(context.actor?.username || context.actor?.displayName || 'media-pipeline'),
        createdAt: Date.now()
      });
    }
    if (decisions.length) await this.store.db.collection('mediaDecisions').insertMany(decisions, { session });
    return attachments;
  }

  async addBacklinks(post, threadId, session) {
    if (!post.references?.length) return;
    const backlink = { id: post.id, threadId };
    for (const referencedId of post.references) {
      await this.store.db.collection('posts').updateOne(
        { _id: referencedId },
        { $addToSet: { backlinks: backlink } },
        { session }
      );
      await this.store.db.collection('threads').updateOne(
        { _id: referencedId },
        { $addToSet: { backlinks: backlink } },
        { session }
      );
    }
  }

  async moderationLog(action, detail, context, boardId, session) {
    if (!context.actor) return;
    const id = crypto.randomUUID();
    const entry = {
      _id: id,
      id,
      action,
      detail,
      actorId: String(context.actor.id || ''),
      actorName: String(context.actor.username || context.actor.displayName || ''),
      boardId: String(boardId || ''),
      createdAt: Date.now()
    };
    await this.store.db.collection('moderationLog').insertOne(entry, { session });
  }

  async archiveOverflow(board, session) {
    const maximum = this.service.boardSetting(board, 'maxThreads', this.config.limits.maxThreads);
    const match = { boardId: board.id, archived: { $ne: true } };
    const count = await this.store.db.collection('threads').countDocuments(match, { session });
    const overflow = Math.max(0, count - maximum);
    if (!overflow) return;
    const candidates = await this.store.db.collection('threads').find(
      { ...match, sticky: { $ne: true } },
      { projection: { _id: 1 }, session }
    ).sort({ bumpedAt: 1, id: 1 }).limit(overflow).toArray();
    if (candidates.length) {
      await this.store.db.collection('threads').updateMany(
        { _id: { $in: candidates.map(candidate => candidate._id) } },
        { $set: { archived: true, archivedAt: Date.now() } },
        { session }
      );
    }
  }

  async createThread(input, media, requestContext) {
    const uploads = uploadList(media);
    let outcome;
    await this.store.withTransaction(async session => {
      outcome = undefined;
      for (const upload of uploads) delete upload._deduplicated;
      const scope = await this.context(requestContext.boardId, uploads, requestContext, session);
      const fields = this.service.validateText(input, uploads, true, scope.board);
      this.service.assertBoardMediaPolicy(scope.board, uploads, input);
      this.service.assertBoardFilters(scope.board, fields);
      const restriction = this.service.postingRestriction(
        scope.data,
        scope.posterKey,
        scope.board.id,
        uploads
      );
      if (restriction?.kind === 'ban') throw this.service.banError(restriction);
      if (restriction?.kind === 'warning') {
        outcome = await this.consumeWarning(restriction, session);
        return;
      }
      await this.assertUniqueMedia(scope.board, uploads, session);
      const id = await this.nextPostId(session);
      const now = Date.now();
      const identity = this.service.postIdentity(
        fields.rawName,
        input.password || input.pwd,
        scope.posterKey,
        id,
        scope.data,
        scope.board
      );
      const capcode = this.service.capcodeFor(requestContext, scope.board.id, scope.data);
      const attachments = await this.registerMedia(uploads, scope.board.id, {
        ...requestContext,
        spoiler: input.spoiler
      }, session);
      const thread = {
        id,
        boardId: scope.board.id,
        ...identity,
        ...(capcode ? { capcode } : {}),
        title: fields.title,
        comment: fields.comment,
        ...(fields.fortune ? { fortune: fields.fortune } : {}),
        createdAt: now,
        bumpedAt: now,
        sticky: false,
        locked: false,
        cyclic: false,
        archived: false,
        archivedAt: 0,
        replyCount: 0,
        references: extractReferences(fields.comment, this.config.limits.maxCites),
        backlinks: [],
        attachments,
        replies: []
      };
      syncPrimaryAttachment(thread, attachments);
      const { replies, ...opening } = thread;
      await this.store.db.collection('threads').insertOne({ _id: id, ...opening }, { session });
      await this.store.db.collection('posts').insertOne({
        _id: id,
        ...opening,
        threadId: id,
        isThread: true
      }, { session });
      await this.addBacklinks(opening, id, session);
      await this.moderationLog(
        'staff-post',
        `Posted thread No.${id}${capcode ? ` with ${capcode} capcode` : ''}`,
        requestContext,
        scope.board.id,
        session
      );
      await this.archiveOverflow(scope.board, session);
      outcome = { id, threadId: id };
    });
    if (outcome?.warning) throw httpError(403, outcome.message);
    this.store.markCacheDirty();
    await Promise.all(uploads.filter(upload => upload._deduplicated)
      .map(upload => this.service.uploads.removeCandidate(upload)));
    return outcome;
  }

  async releasePostMedia(post, session, releasedAssets) {
    for (const attachment of postAttachments(post)) {
      if (!attachment.assetId) continue;
      const result = await this.store.db.collection('media').findOneAndUpdate(
        { _id: attachment.assetId, refCount: { $gt: 0 } },
        { $inc: { refCount: -1 } },
        { returnDocument: 'after', session }
      );
      const asset = withoutId(resultDocument(result));
      if (asset && Number(asset.refCount) === 0) {
        await this.store.db.collection('media').deleteOne({ _id: attachment.assetId, refCount: 0 }, { session });
        releasedAssets.push(asset);
      }
    }
  }

  async removeReplyForCycle(reply, session, releasedAssets) {
    await this.releasePostMedia(reply, session, releasedAssets);
    await this.store.db.collection('posts').deleteOne({ _id: reply.id, isThread: false }, { session });
    await this.store.db.collection('reports').updateMany(
      { postId: reply.id, status: { $ne: 'closed' } },
      {
        $set: {
          status: 'closed',
          updatedAt: Date.now(),
          closedAt: Date.now(),
          resolution: 'post-deleted',
          moderatorNote: 'The target expired from a cyclic thread.'
        },
        $push: {
          history: {
            $each: [{
              action: 'target-deleted',
              resolution: 'post-deleted',
              note: 'The target expired from a cyclic thread.',
              actorId: 'system',
              actorName: 'cyclic-thread',
              createdAt: Date.now()
            }],
            $slice: -50
          }
        },
        $unset: { openDedupeKey: '' }
      },
      { session }
    );
    for (const referencedId of reply.references || []) {
      await this.store.db.collection('posts').updateOne(
        { _id: referencedId },
        { $pull: { backlinks: { id: reply.id } } },
        { session }
      );
      await this.store.db.collection('threads').updateOne(
        { _id: referencedId },
        { $pull: { backlinks: { id: reply.id } } },
        { session }
      );
    }
  }

  async createReply(threadId, input, media, requestContext) {
    const uploads = uploadList(media);
    const releasedAssets = [];
    let outcome;
    await this.store.withTransaction(async session => {
      outcome = undefined;
      releasedAssets.length = 0;
      for (const upload of uploads) delete upload._deduplicated;
      const threadDocument = await this.store.db.collection('threads').findOne(
        { _id: Number(threadId) },
        { session }
      );
      if (!threadDocument) throw httpError(404, 'Thread not found.');
      const thread = withoutId(threadDocument);
      if (thread.locked) throw httpError(403, 'This thread is locked.');
      if (thread.archived) throw httpError(403, 'This thread is archived and read-only.');
      const scope = await this.context(thread.boardId, uploads, requestContext, session);
      if (requestContext.boardUri && requestContext.boardUri !== scope.board.uri) {
        throw httpError(404, 'Thread not found.');
      }
      const fields = this.service.validateText(input, uploads, false, scope.board);
      this.service.assertBoardMediaPolicy(scope.board, uploads, input);
      this.service.assertBoardFilters(scope.board, fields);
      const restriction = this.service.postingRestriction(
        scope.data,
        scope.posterKey,
        scope.board.id,
        uploads
      );
      if (restriction?.kind === 'ban') throw this.service.banError(restriction);
      if (restriction?.kind === 'warning') {
        outcome = await this.consumeWarning(restriction, session);
        return;
      }
      await this.assertUniqueMedia(scope.board, uploads, session);

      const recent = await this.store.db.collection('posts').find(
        { threadId: thread.id, isThread: false },
        { projection: { comment: 1 }, session }
      ).sort({ id: -1 }).limit(20).toArray();
      const normalized = String(fields.comment || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (normalized.length >= 8 && recent.filter(reply =>
        String(reply.comment || '').toLowerCase().replace(/\s+/g, ' ').trim() === normalized
      ).length >= 2) throw httpError(409, 'Duplicate reply detected.');

      let replyCount = await this.store.db.collection('posts').countDocuments(
        { threadId: thread.id, isThread: false },
        { session }
      );
      const replyLimit = this.service.boardSetting(scope.board, 'replyLimit', this.config.limits.replyLimit);
      if (replyCount >= replyLimit) {
        if (!thread.cyclic) throw httpError(409, 'This thread has reached the reply limit.');
        const oldest = await this.store.db.collection('posts').findOne(
          { threadId: thread.id, isThread: false },
          { sort: { id: 1 }, session }
        );
        if (oldest) {
          await this.removeReplyForCycle(withoutId(oldest), session, releasedAssets);
          replyCount -= 1;
        }
      }

      const id = await this.nextPostId(session);
      const now = Date.now();
      const option = String(input.option || input.email || '').trim().toLowerCase();
      const sage = option === 'sage';
      if (sage && !this.service.boardSetting(scope.board, 'allowSage', true)) {
        throw httpError(403, 'Sage is disabled on this board.');
      }
      const bumpLimit = this.service.boardSetting(scope.board, 'bumpLimit', this.config.limits.bumpLimit);
      const bumped = !sage && replyCount + 1 <= bumpLimit;
      const identity = this.service.postIdentity(
        fields.rawName,
        input.password || input.pwd,
        scope.posterKey,
        thread.id,
        scope.data,
        scope.board
      );
      const capcode = this.service.capcodeFor(requestContext, thread.boardId, scope.data);
      const attachments = await this.registerMedia(uploads, scope.board.id, {
        ...requestContext,
        spoiler: input.spoiler
      }, session);
      const reply = {
        id,
        ...identity,
        ...(capcode ? { capcode } : {}),
        comment: fields.comment,
        ...(fields.fortune ? { fortune: fields.fortune } : {}),
        createdAt: now,
        sage,
        bumped,
        email: sage ? 'sage' : '',
        references: extractReferences(fields.comment, this.config.limits.maxCites),
        backlinks: [],
        attachments
      };
      syncPrimaryAttachment(reply, attachments);
      await this.store.db.collection('posts').insertOne({
        _id: id,
        ...reply,
        boardId: thread.boardId,
        threadId: thread.id,
        isThread: false
      }, { session });
      const threadUpdate = await this.store.db.collection('threads').updateOne(
        { _id: thread.id, archived: { $ne: true }, locked: { $ne: true } },
        {
          $set: {
            replyCount: replyCount + 1,
            ...(bumped ? { bumpedAt: now } : {})
          }
        },
        { session }
      );
      if (threadUpdate.modifiedCount !== 1) throw httpError(409, 'Thread state changed. Retry the post.');
      await this.addBacklinks(reply, thread.id, session);
      await this.moderationLog(
        'staff-post',
        `Posted reply No.${id}${capcode ? ` with ${capcode} capcode` : ''}`,
        requestContext,
        thread.boardId,
        session
      );
      outcome = { id, threadId: thread.id };
    });
    if (outcome?.warning) throw httpError(403, outcome.message);
    this.store.markCacheDirty();
    await Promise.all([
      ...uploads.filter(upload => upload._deduplicated)
        .map(upload => this.service.uploads.removeCandidate(upload)),
      ...releasedAssets.map(asset => this.service.uploads.removeAsset(asset))
    ]);
    return outcome;
  }

  async closeReports(postIds, session) {
    const now = Date.now();
    await this.store.db.collection('reports').updateMany(
      { postId: { $in: postIds }, status: { $ne: 'closed' } },
      {
        $set: {
          status: 'closed',
          updatedAt: now,
          closedAt: now,
          resolution: 'post-deleted',
          moderatorNote: 'The reported post was deleted.'
        },
        $push: {
          history: {
            $each: [{
              action: 'target-deleted',
              resolution: 'post-deleted',
              note: 'The reported post was deleted.',
              actorId: '',
              actorName: '',
              createdAt: now
            }],
            $slice: -50
          }
        },
        $unset: { openDedupeKey: '' }
      },
      { session }
    );
  }

  async removeBacklinks(postIds, session) {
    if (!postIds.length) return;
    await this.store.db.collection('posts').updateMany(
      {},
      { $pull: { backlinks: { id: { $in: postIds } } } },
      { session }
    );
    await this.store.db.collection('threads').updateMany(
      {},
      { $pull: { backlinks: { id: { $in: postIds } } } },
      { session }
    );
  }

  async refreshThreadSummary(threadId, session) {
    const replies = await this.store.db.collection('posts').find(
      { threadId, isThread: false },
      { projection: { createdAt: 1, sage: 1, bumped: 1 }, session }
    ).sort({ createdAt: -1, id: -1 }).toArray();
    const thread = await this.store.db.collection('threads').findOne(
      { _id: threadId },
      { projection: { createdAt: 1 }, session }
    );
    if (!thread) return;
    const bumpedAt = replies.find(reply => reply.bumped === true
      || (reply.bumped === undefined && !reply.sage))?.createdAt || thread.createdAt;
    await this.store.db.collection('threads').updateOne(
      { _id: threadId },
      { $set: { replyCount: replies.length, bumpedAt: Number(bumpedAt) || Number(thread.createdAt) } },
      { session }
    );
  }

  async deleteByPassword(ids, password, fileOnly = false) {
    const releasedAssets = [];
    let outcome;
    await this.store.withTransaction(async session => {
      releasedAssets.length = 0;
      outcome = undefined;
      const documents = await this.store.db.collection('posts').find(
        { _id: { $in: ids } },
        { session }
      ).toArray();
      const byId = new Map(documents.map(document => [Number(document.id), document]));
      const authorized = ids.map(id => verifyPassword(
        password,
        byId.get(id)?.passwordHash || DUMMY_PASSWORD_HASH
      ));
      if (documents.length !== ids.length || authorized.some(value => !value)) {
        throw httpError(403, 'Deletion could not be authorized.');
      }
      for (const document of documents) {
        const age = Date.now() - Number(document.createdAt);
        if (age < this.config.limits.deleteDelaySeconds * 1000) {
          throw httpError(409, 'That post is too new to delete.');
        }
      }

      if (fileOnly) {
        for (const document of documents) {
          if (!postAttachments(document).length) continue;
          await this.releasePostMedia(document, session, releasedAssets);
          removePostAttachments(document);
          await this.store.db.collection('posts').replaceOne({ _id: document._id }, document, { session });
          if (document.isThread) {
            const { threadId, isThread, ...threadDocument } = document;
            await this.store.db.collection('threads').replaceOne(
              { _id: document._id },
              threadDocument,
              { session }
            );
          }
        }
        outcome = { deleted: ids, fileOnly: true };
        return;
      }

      const deletedIds = new Set();
      const affectedThreads = new Set();
      const selectedThreads = new Set(documents.filter(document => document.isThread).map(document => document.id));
      for (const selectedThreadId of selectedThreads) {
        const threadPosts = await this.store.db.collection('posts')
          .find({ threadId: selectedThreadId }, { session })
          .toArray();
        for (const post of threadPosts) {
          await this.releasePostMedia(post, session, releasedAssets);
          deletedIds.add(Number(post.id));
        }
        await this.store.db.collection('posts').deleteMany({ threadId: selectedThreadId }, { session });
        await this.store.db.collection('threads').deleteOne({ _id: selectedThreadId }, { session });
      }
      for (const document of documents) {
        if (document.isThread || selectedThreads.has(document.threadId) || deletedIds.has(document.id)) continue;
        await this.releasePostMedia(document, session, releasedAssets);
        await this.store.db.collection('posts').deleteOne(
          { _id: document._id, isThread: false },
          { session }
        );
        deletedIds.add(Number(document.id));
        affectedThreads.add(Number(document.threadId));
      }
      const deleted = [...deletedIds];
      await this.closeReports(deleted, session);
      await this.removeBacklinks(deleted, session);
      for (const affectedThreadId of affectedThreads) {
        await this.refreshThreadSummary(affectedThreadId, session);
      }
      outcome = { deleted, fileOnly: false };
    });
    this.store.markCacheDirty();
    await Promise.all(releasedAssets.map(asset => this.service.uploads.removeAsset(asset)));
    return outcome;
  }
}

module.exports = { MongoPostRepository, attachmentFromAsset, uploadHashes };
