import fs from 'node:fs';
import path from 'node:path';
import { collectCorpusSignature } from './corpus.js';
import { buildIndex } from './indexer.js';

export class FreshnessManager {
  constructor(config, { embedder, store, build = buildIndex, log = console.log } = {}) {
    this.config = config;
    this.embedder = embedder;
    this.store = store;
    this.build = build;
    this.log = log;
    this.enabled = config.freshness?.enabled !== false;
    this.debounceMs = config.freshness?.debounceMs || 1000;
    this.sweepIntervalMs = config.freshness?.sweepIntervalMs || 300000;
    this.watchers = [];
    this.sweepTimer = null;
    this.debounceTimer = null;
    this.running = false;
    this.pendingReason = null;
    this.signature = null;
  }

  async start() {
    if (!this.enabled) return;
    await this.refreshNow('startup');
    this.startWatchers();
    this.startSweep();
  }

  async stop() {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.sweepTimer = null;
    this.debounceTimer = null;
  }

  startWatchers() {
    if (this.config.freshness?.watch === false) return;
    for (const root of concreteWatchDirs(this.config)) {
      try {
        const watcher = fs.watch(root, { recursive: true }, (_event, fileName) => {
          if (!fileName || !isMarkdownLike(String(fileName))) return;
          this.scheduleRefresh('fs-watch');
        });
        watcher.on('error', () => {});
        this.watchers.push(watcher);
      } catch {
        // Linux may not support recursive fs.watch. The sweep timer is the fallback.
      }
    }
  }

  startSweep() {
    if (this.config.freshness?.sweep === false || this.sweepIntervalMs <= 0) return;
    this.sweepTimer = setInterval(() => {
      this.checkForChanges('sweep').catch(() => {});
    }, this.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  scheduleRefresh(reason) {
    this.pendingReason = reason;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.checkForChanges(this.pendingReason || reason).catch(() => {});
      this.pendingReason = null;
    }, this.debounceMs);
    this.debounceTimer.unref?.();
  }

  async checkForChanges(reason) {
    const nextSignature = collectCorpusSignature(this.config);
    if (nextSignature === this.signature) return null;
    return this.refreshNow(reason, nextSignature);
  }

  async refreshNow(reason, knownSignature = null) {
    if (this.running) {
      this.pendingReason = reason;
      return null;
    }

    this.running = true;
    try {
      const started = Date.now();
      const result = await this.build(this.config, { embedder: this.embedder, store: this.store });
      this.signature = knownSignature || collectCorpusSignature(this.config);
      this.log(`[recall] Index refreshed (${reason}): ${result.total} chunks, ${result.inserted} inserted, ${result.updated} updated, ${result.unchanged} unchanged, ${result.removed} removed in ${Date.now() - started}ms`);
      return result;
    } finally {
      this.running = false;
      if (this.pendingReason) {
        const nextReason = this.pendingReason;
        this.pendingReason = null;
        this.scheduleRefresh(nextReason);
      }
    }
  }
}

export function concreteWatchDirs(config) {
  const dirs = new Set();
  const globStart = /[*?[{]/;

  for (const root of config.corpus.roots) {
    for (const pattern of config.corpus.allow) {
      if (pattern.startsWith('/') || pattern.includes('..')) continue;
      const matchIndex = pattern.search(globStart);
      const concretePrefix = matchIndex >= 0 ? pattern.slice(0, matchIndex) : path.posix.dirname(pattern);
      const relativeDir = concretePrefix.replace(/\\/g, '/').replace(/\/+$/, '');
      if (!relativeDir) continue;
      const watchDir = path.join(root, relativeDir);
      if (fs.existsSync(watchDir)) dirs.add(watchDir);
    }
  }

  return [...dirs].sort();
}

function isMarkdownLike(fileName) {
  return /\.(md|markdown|mdown)$/i.test(fileName);
}
