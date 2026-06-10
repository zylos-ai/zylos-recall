import fs from 'node:fs';
import path from 'node:path';
import { collectCorpusSignature } from './corpus.js';
import { buildIndex } from './indexer.js';
import { CHUNKER_VERSION } from './chunker.js';
import { sha256 } from './hash.js';

export const FRESHNESS_META_KEYS = Object.freeze({
  corpusSignature: 'corpus_signature',
  chunkingFingerprint: 'chunking_fingerprint'
});

export class FreshnessManager {
  constructor(config, { embedder, store, build = buildIndex, log = console.log, chunkerVersion = CHUNKER_VERSION } = {}) {
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
    this.chunkerVersion = chunkerVersion;
  }

  async start() {
    if (!this.enabled) return;
    const started = Date.now();
    const signature = collectCorpusSignature(this.config);
    const signatureHash = hashCorpusSignature(signature);
    const fingerprint = chunkingFingerprint(this.config, { chunkerVersion: this.chunkerVersion });
    const chunkCount = this.reusableChunkCount(signatureHash, fingerprint);
    if (chunkCount > 0) {
      this.signature = signature;
      this.log(`[recall] startup index reuse (signature+fingerprint match): ${chunkCount} chunks, ${Date.now() - started}ms`);
    } else {
      await this.refreshNow('startup', signature);
    }
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
      this.writeFreshnessStamps(this.signature);
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

  reusableChunkCount(signatureHash, fingerprint) {
    if (
      typeof this.store?.getMetaValue !== 'function' ||
      typeof this.store?.countChunks !== 'function'
    ) {
      return 0;
    }
    if (typeof this.store?.getEmbedderMeta === 'function' && this.embedder) {
      const current = this.store.getEmbedderMeta();
      if (!current || current.id !== this.embedder.id() || current.dimension !== this.embedder.dimension()) {
        return 0;
      }
    }
    if (this.store.getMetaValue(FRESHNESS_META_KEYS.corpusSignature) !== signatureHash) return 0;
    if (this.store.getMetaValue(FRESHNESS_META_KEYS.chunkingFingerprint) !== fingerprint) return 0;
    return this.store.countChunks();
  }

  writeFreshnessStamps(signature) {
    if (typeof this.store?.setMetaValues !== 'function') return;
    this.store.setMetaValues({
      [FRESHNESS_META_KEYS.corpusSignature]: hashCorpusSignature(signature),
      [FRESHNESS_META_KEYS.chunkingFingerprint]: chunkingFingerprint(this.config, {
        chunkerVersion: this.chunkerVersion
      })
    });
  }
}

export function hashCorpusSignature(signature) {
  return sha256(signature);
}

export function chunkingFingerprint(config, { chunkerVersion = CHUNKER_VERSION } = {}) {
  return sha256(JSON.stringify({
    chunkerVersion,
    chunking: {
      targetTokens: config.chunking?.targetTokens,
      minTokens: config.chunking?.minTokens,
      maxTokens: config.chunking?.maxTokens,
      overlapRatio: config.chunking?.overlapRatio
    }
  }));
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
