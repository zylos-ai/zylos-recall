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
    for (const entry of concreteWatchDirs(this.config)) {
      try {
        const watcher = fs.watch(entry.dir, { recursive: entry.recursive }, (_event, fileName) => {
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
  const entries = new Map();
  const recursiveSeen = new Set();
  const globStart = /[*?[{]/;

  for (const root of config.corpus.roots) {
    for (const pattern of config.corpus.allow) {
      if (pattern.startsWith('/') || pattern.includes('..')) continue;
      for (const candidate of watchCandidates(root, pattern, globStart)) {
        const { watchDir, recursive } = candidate;
        if (!fs.existsSync(watchDir)) continue;
        if (entries.has(watchDir) || recursiveSeen.has(watchDir)) continue;
        entries.set(watchDir, { dir: watchDir, recursive });
        if (recursive) recursiveSeen.add(watchDir);
      }
    }
  }

  const values = [...entries.values()].sort((a, b) => a.dir.localeCompare(b.dir));
  return values.filter((entry, index) => {
    if (!entry.recursive) return true;
    return !values.some((other, otherIndex) =>
      otherIndex !== index &&
      other.recursive &&
      entry.dir.startsWith(`${other.dir}${path.sep}`)
    );
  });
}

function watchCandidates(root, pattern, globStart) {
  const normalized = pattern.replace(/\\/g, '/');
  const matchIndex = normalized.search(globStart);
  if (matchIndex < 0) {
    const relativeDir = path.posix.dirname(normalized);
    return relativeDir && relativeDir !== '.'
      ? [{ watchDir: path.join(root, relativeDir), recursive: false }]
      : [];
  }

  const segments = normalized.split('/');
  const firstGlobIndex = segments.findIndex(segment => globStart.test(segment));
  const concretePrefix = segments.slice(0, firstGlobIndex).join('/');
  const baseDir = path.join(root, concretePrefix);
  const expanded = expandOneWildcardWatchDirs(baseDir, segments.slice(firstGlobIndex));
  if (expanded.length) return expanded;

  const relativeDir = concretePrefix.replace(/\/+$/, '');
  if (!relativeDir) return [];
  return [{
    watchDir: path.join(root, relativeDir),
    recursive: normalized.slice(relativeDir.length).includes('**')
  }];
}

function expandOneWildcardWatchDirs(baseDir, globSegments) {
  if (globSegments[0] !== '*' || !fs.existsSync(baseDir)) return [];
  const literalTail = [];
  for (const segment of globSegments.slice(1)) {
    if (/[*?[{]/.test(segment)) break;
    literalTail.push(segment);
  }
  if (!literalTail.length) return [];

  const remaining = globSegments.slice(1 + literalTail.length);
  const recursive = remaining.join('/').includes('**');
  const candidates = [];
  for (const entry of fs.readdirSync(baseDir)) {
    const watchDir = path.join(baseDir, entry, ...literalTail);
    if (!fs.existsSync(watchDir)) continue;
    candidates.push({ watchDir, recursive });
  }
  return candidates;
}

function isMarkdownLike(fileName) {
  return /\.(md|markdown|mdown)$/i.test(fileName);
}
