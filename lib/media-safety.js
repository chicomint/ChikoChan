'use strict';

const { httpError } = require('./utils');
const crypto = require('node:crypto');
const { ModerationGateway } = require('./moderation-gateway');

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

class KnownIllegalMediaHashProvider {
  constructor(name = 'none') {
    this.name = String(name || 'none');
  }

  get available() {
    return false;
  }

  status() {
    return {
      name: this.name,
      available: false,
      reason: this.name === 'none' ? 'not-configured' : 'adapter-unavailable'
    };
  }

  async check() {
    throw new Error(`Known-illegal-media provider ${this.name} is unavailable.`);
  }
}

function normalizeProviderResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.matched !== 'boolean') {
    throw new Error('The known-illegal-media provider returned an invalid result.');
  }
  return {
    matched: value.matched,
    reasonCode: String(value.reasonCode || '').replace(/[^a-z0-9:_-]/gi, '').slice(0, 80),
    providerReference: String(value.providerReference || '').replace(/\0/g, '').trim().slice(0, 200)
  };
}

class MediaSafetyService {
  constructor(config, boardService, options = {}) {
    this.config = config.mediaSafety;
    this.boardService = boardService;
    this.gateway = options.gateway || new ModerationGateway(this.config, options.fetchImpl);
    this.provider = options.provider || (this.config.knownIllegalProvider === 'gateway' ? this.gateway : new KnownIllegalMediaHashProvider(this.config.knownIllegalProvider));
    this.logger = options.logger || console;
    this.unavailableWarningEmitted = false;
  }

  status() {
    const providerStatus = typeof this.provider.status === 'function'
      ? this.provider.status()
      : { name: this.config.knownIllegalProvider, available: this.provider.available === true };
    return {
      configured: this.config.knownIllegalProvider !== 'none',
      failClosed: this.config.failClosed,
      provider: {
        name: String(providerStatus.name || this.config.knownIllegalProvider),
        available: providerStatus.available === true,
        reason: String(providerStatus.reason || '')
      }
    };
  }

  async close() { await this.gateway.close?.(); }

  hashes(candidate) {
    return [...new Set([
      candidate?.sha256,
      candidate?.contentSha256,
      candidate?._asset?.sourceSha256,
      candidate?._asset?.contentSha256
    ].map(value => String(value || '').toLowerCase()).filter(value => SHA256_PATTERN.test(value)))];
  }

  async incident(board, candidate, reason, providerReference = '') {
    await this.boardService.store.update(data => {
      data.meta.mediaIncidents ||= [];
      data.meta.mediaIncidents.push({ id: crypto.randomUUID(), boardId: board.id,
        sha256: candidate.sha256, contentSha256: candidate.contentSha256 || '',
        reason, providerReference: String(providerReference).replace(/[\u0000-\u001f]/g, '').slice(0, 200),
        createdAt: Date.now(), status: 'open', resolution: '', resolvedAt: 0 });
      data.meta.mediaIncidents = data.meta.mediaIncidents.slice(-500);
    });
  }

  async screenAdult(board, candidate, policy) {
    if (policy === 'off') return;
    if (!this.gateway.available) throw httpError(503, 'Media screening is unavailable. Please try again later.');
    let result;
    try {
      result = await this.gateway.screen({ sha256: candidate.sha256, contentSha256: candidate.contentSha256,
        mime: candidate.imageMime, bytes: candidate.imageBytes, filePath: candidate._quarantine?.filePath });
      if (!result || !['allow', 'adult', 'review'].includes(result.decision)) throw new Error('Invalid screening result.');
    } catch { throw httpError(503, 'Media screening is unavailable. Please try again later.'); }
    if (result.decision === 'allow') return;
    const reason = policy === 'review' || result.decision === 'review' ? 'adult-review' : 'adult-block';
    await this.incident(board, candidate, reason, result.providerReference);
    await this.boardService.recordMediaDecision({ sha256: candidate.sha256, contentSha256: candidate.contentSha256,
      boardId: board.id, decision: 'rejected', reasonCode: reason, provider: 'gateway', reason: 'Private screening rejected this upload; no public media was created.' });
    throw httpError(403, reason === 'adult-review' ? 'This upload requires moderator review and was not published. Contact staff with the time and board; do not resend prohibited material.' : 'This board does not allow this media under its adult-content policy.');
  }

  async evaluate(board, candidates) {
    const policy = (await this.boardService.publicCustomization()).moderation || {};
    const adultPolicy = policy.boards?.[board.id] || policy.adultPolicy || 'off';
    for (const candidate of candidates) {
      const hashes = this.hashes(candidate);
      if (!hashes.length) throw httpError(400, 'Uploaded media could not be hashed safely.');
      const banned = await this.boardService.findMediaHashBanRecord(hashes, board.id);
      if (banned) {
        await this.boardService.recordMediaDecision({
          sha256: hashes[0],
          contentSha256: hashes[1] || '',
          boardId: board.id,
          decision: 'rejected',
          reasonCode: 'hash-ban-match',
          reason: 'Matched an active media hash ban.'
        });
        if (banned.sourceSanctionId) {
          const service = this.boardService;
          const sanction = service.usesTargetedQueries
            ? await service.store.sanctionById(banned.sourceSanctionId)
            : service.getData().bans.find(entry => entry.id === banned.sourceSanctionId);
          if (sanction) throw service.banError(sanction);
        }
        throw httpError(403, 'That media cannot be posted.');
      }

      const status = this.status();
      if (!status.configured) {
        if (policy.requireKnownIllegalCheck) throw httpError(503, 'Media safety verification is unavailable.');
        await this.screenAdult(board, candidate, adultPolicy);
        continue;
      }
      if (!status.provider.available) {
        if (!this.unavailableWarningEmitted) {
          this.logger.warn(`Known-illegal-media provider ${status.provider.name} is configured but unavailable.`);
          this.unavailableWarningEmitted = true;
        }
        if (this.config.failClosed || policy.requireKnownIllegalCheck) {
          throw httpError(503, 'Media safety verification is temporarily unavailable.');
        }
        await this.screenAdult(board, candidate, adultPolicy);
        continue;
      }

      let result;
      try {
        result = normalizeProviderResult(await this.provider.check({
          sha256: hashes[0],
          contentSha256: candidate.contentSha256 || '',
          mime: candidate.imageMime,
          bytes: candidate.imageBytes,
          filePath: candidate._quarantine?.filePath
        }));
      } catch (error) {
        this.logger.error(`Known-illegal-media provider ${status.provider.name} failed.`);
        if (this.config.failClosed || policy.requireKnownIllegalCheck) {
          throw httpError(503, 'Media safety verification is temporarily unavailable.');
        }
        await this.screenAdult(board, candidate, adultPolicy);
        continue;
      }

      if (this.config.retainProviderResults || result.matched) {
        await this.boardService.recordMediaProviderResult({
          sha256: hashes[0],
          provider: status.provider.name,
          available: true,
          matched: result.matched,
          reasonCode: result.reasonCode,
          providerReference: result.providerReference
        });
      }
      if (result.matched) {
        await this.incident(board, candidate, 'suspected-illegal', result.providerReference);
        for (const hash of hashes) await this.boardService.recordAutomatedMediaRejection({
          sha256: hash,
          contentSha256: candidate.contentSha256 || '',
          boardId: board.id,
          provider: status.provider.name,
          reasonCode: result.reasonCode || 'provider-match',
          providerReference: result.providerReference
        });
        await this.boardService.quarantineMatchedMedia(hashes);
        throw httpError(403, 'That media cannot be posted.');
      }
      await this.screenAdult(board, candidate, adultPolicy);
    }
    return { approved: true };
  }
}

module.exports = {
  KnownIllegalMediaHashProvider,
  MediaSafetyService,
  normalizeProviderResult
};
