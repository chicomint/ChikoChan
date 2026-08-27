'use strict';

const { httpError } = require('./utils');

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
    this.provider = options.provider || new KnownIllegalMediaHashProvider(this.config.knownIllegalProvider);
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

  hashes(candidate) {
    return [...new Set([
      candidate?.sha256,
      candidate?.contentSha256,
      candidate?._asset?.sourceSha256,
      candidate?._asset?.contentSha256
    ].map(value => String(value || '').toLowerCase()).filter(value => SHA256_PATTERN.test(value)))];
  }

  async evaluate(board, candidates) {
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
        throw httpError(403, 'That media cannot be posted.');
      }

      const status = this.status();
      if (!status.configured) continue;
      if (!status.provider.available) {
        if (!this.unavailableWarningEmitted) {
          this.logger.warn(`Known-illegal-media provider ${status.provider.name} is configured but unavailable.`);
          this.unavailableWarningEmitted = true;
        }
        if (this.config.failClosed) {
          throw httpError(503, 'Media safety verification is temporarily unavailable.');
        }
        continue;
      }

      let result;
      try {
        result = normalizeProviderResult(await this.provider.check({
          sha256: hashes[0],
          contentSha256: candidate.contentSha256 || '',
          mime: candidate.imageMime,
          bytes: candidate.imageBytes
        }));
      } catch (error) {
        this.logger.error(`Known-illegal-media provider ${status.provider.name} failed: ${error.message}`);
        if (this.config.failClosed) {
          throw httpError(503, 'Media safety verification is temporarily unavailable.');
        }
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
        await this.boardService.recordAutomatedMediaRejection({
          sha256: hashes[0],
          contentSha256: candidate.contentSha256 || '',
          boardId: board.id,
          provider: status.provider.name,
          reasonCode: result.reasonCode || 'provider-match',
          providerReference: result.providerReference
        });
        throw httpError(403, 'That media cannot be posted.');
      }
    }
    return { approved: true };
  }
}

module.exports = {
  KnownIllegalMediaHashProvider,
  MediaSafetyService,
  normalizeProviderResult
};
