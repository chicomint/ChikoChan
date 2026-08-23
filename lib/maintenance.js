'use strict';

const crypto = require('node:crypto');

class MaintenanceRunner {
  constructor(config, store, service, options = {}) {
    this.config = config.maintenance;
    this.store = store;
    this.service = service;
    this.logger = options.logger || console;
    this.ownerId = options.ownerId || crypto.randomUUID();
    this.timer = null;
    this.running = null;
    this.stopped = true;
    this.lastResult = null;
  }

  schedule(delayMs) {
    if (this.stopped || !this.config.enabled) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      try {
        await this.runOnce();
      } catch (error) {
        this.logger.error(`Maintenance cycle failed: ${error.message}`);
      } finally {
        this.schedule(this.config.intervalMs);
      }
    }, delayMs);
    this.timer.unref?.();
  }

  start() {
    if (!this.config.enabled || !this.stopped) return false;
    this.stopped = false;
    this.schedule(this.config.startupDelayMs);
    return true;
  }

  async runOnce(options = {}) {
    if (!this.config.enabled && !options.force) return { status: 'disabled' };
    if (this.running) return this.running;
    this.running = this.executeCycle();
    try {
      return await this.running;
    } finally {
      this.running = null;
    }
  }

  async executeCycle(now = Date.now()) {
    const acquired = await this.store.acquireLease(
      'maintenance:core',
      this.ownerId,
      this.config.leaseMs,
      now
    );
    if (!acquired) {
      const result = { status: 'skipped', reason: 'lease-held', startedAt: now, finishedAt: Date.now() };
      this.lastResult = result;
      return result;
    }

    try {
      const state = await this.service.performMaintenance(now);
      const trash = await this.service.purgeExpiredTrash({ system: true }, now);
      const result = {
        status: 'completed',
        startedAt: now,
        finishedAt: Date.now(),
        expiredSanctions: state.expiredSanctions.length,
        archivedThreads: state.archivedThreads.length,
        orphanAssets: state.orphanAssets.length,
        purgedTrash: trash.purged.length
      };
      this.lastResult = result;
      return result;
    } finally {
      await this.store.releaseLease('maintenance:core', this.ownerId).catch(error => {
        this.logger.error(`Could not release maintenance lease: ${error.message}`);
      });
    }
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.running) await this.running;
  }
}

module.exports = { MaintenanceRunner };
