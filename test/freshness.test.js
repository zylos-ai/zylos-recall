import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../src/lib/config.js';
import { buildIndex } from '../src/lib/indexer.js';
import { ChunkStore } from '../src/lib/store.js';
import {
  chunkingFingerprint,
  FRESHNESS_META_KEYS,
  FreshnessManager,
  concreteWatchDirs,
  hashCorpusSignature
} from '../src/lib/freshness.js';
import { collectCorpusSignature } from '../src/lib/corpus.js';

class FakeEmbedder {
  constructor(id = 'fake@2') {
    this.name = id;
  }

  id() {
    return this.name;
  }

  dimension() {
    return 2;
  }

  async embed(texts) {
    return texts.map(text => text.toLowerCase().includes('beta') ? [0, 1] : [1, 0]);
  }
}

test('freshness manager indexes on startup and skips unchanged sweeps', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-fresh-root-'));
  const file = path.join(root, 'memory/reference/projects.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# Alpha\n\nAlpha project memory has enough durable content for indexing.');

  const config = structuredClone(DEFAULT_CONFIG);
  config.corpus.roots = [root];
  config.corpus.allow = ['memory/reference/**/*.md'];
  config.freshness.watch = false;
  config.freshness.sweep = false;
  const calls = [];
  const manager = new FreshnessManager(config, {
    embedder: {},
    store: {},
    log: () => {},
    build: async (_config, options) => {
      calls.push(options);
      return { total: 1, inserted: 1, updated: 0, unchanged: 0, removed: 0 };
    }
  });

  await manager.start();
  await manager.checkForChanges('sweep');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].embedder, manager.embedder);
  await manager.stop();
});

test('freshness manager refreshes when corpus signature changes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-fresh-change-'));
  const file = path.join(root, 'memory/reference/projects.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# Alpha\n\nAlpha project memory has enough durable content for indexing.');

  const config = structuredClone(DEFAULT_CONFIG);
  config.corpus.roots = [root];
  config.corpus.allow = ['memory/reference/**/*.md'];
  config.freshness.watch = false;
  config.freshness.sweep = false;
  let calls = 0;
  const manager = new FreshnessManager(config, {
    log: () => {},
    build: async () => {
      calls += 1;
      return { total: 1, inserted: 0, updated: 1, unchanged: 0, removed: 0 };
    }
  });

  await manager.start();
  fs.appendFileSync(file, '\nMore details.');
  await manager.checkForChanges('sweep');

  assert.equal(calls, 2);
  await manager.stop();
});

test('startup reuses existing index when corpus signature and chunking fingerprint match', async () => {
  const { config } = await buildStampedIndex();
  const store = new ChunkStore(config.indexPath);
  const logs = [];
  let builds = 0;
  const manager = new FreshnessManager(config, {
    embedder: new FakeEmbedder(),
    store,
    log: message => logs.push(message),
    build: async () => {
      builds += 1;
      return { total: 1, inserted: 0, updated: 0, unchanged: 1, removed: 0 };
    }
  });

  try {
    await manager.start();
    assert.equal(builds, 0);
    assert.equal(store.search([1, 0], { topK: 1 })[0].section, 'Alpha');
    assert.match(logs.join('\n'), /startup index reuse \(signature\+fingerprint match\): 1 chunks/);
    await manager.checkForChanges('sweep');
    assert.equal(builds, 0);
  } finally {
    await manager.stop();
    store.close();
  }
});

test('startup rebuilds when corpus signature changes', async () => {
  const { config, file } = await buildStampedIndex();
  fs.appendFileSync(file, '\nMore changed details.');
  const { builds } = await startWithBuildSpy(config);
  assert.equal(builds.count, 1);
});

test('startup rebuilds when chunker version fingerprint changes', async () => {
  const { config } = await buildStampedIndex();
  const { builds } = await startWithBuildSpy(config, { chunkerVersion: 2 });
  assert.equal(builds.count, 1);
});

test('startup rebuilds when chunking config fingerprint changes', async () => {
  const { config } = await buildStampedIndex();
  const nextConfig = structuredClone(config);
  nextConfig.chunking.targetTokens += 1;
  const { builds } = await startWithBuildSpy(nextConfig);
  assert.equal(builds.count, 1);
});

test('startup rebuilds pre-upgrade indexes without stamps and writes stamps', async () => {
  const { config } = buildFreshConfig();
  await buildIndex(config, { embedder: new FakeEmbedder() });
  const store = new ChunkStore(config.indexPath);
  const manager = new FreshnessManager(config, {
    embedder: new FakeEmbedder(),
    store,
    log: () => {},
    build: async (_config, options) => {
      return buildIndex(_config, options);
    }
  });

  try {
    assert.equal(store.getMetaValue(FRESHNESS_META_KEYS.corpusSignature), null);
    await manager.start();
    assert.equal(
      store.getMetaValue(FRESHNESS_META_KEYS.corpusSignature),
      hashCorpusSignature(collectCorpusSignature(config))
    );
    assert.equal(
      store.getMetaValue(FRESHNESS_META_KEYS.chunkingFingerprint),
      chunkingFingerprint(config)
    );
  } finally {
    await manager.stop();
    store.close();
  }
});

test('embedder mismatch wins over matching startup reuse stamps', async () => {
  const { config } = await buildStampedIndex();
  const store = new ChunkStore(config.indexPath);
  const newEmbedder = new FakeEmbedder('fake@2-v2');
  let builds = 0;
  const manager = new FreshnessManager(config, {
    embedder: newEmbedder,
    store,
    log: () => {},
    build: async (_config, options) => {
      builds += 1;
      return buildIndex(_config, options);
    }
  });

  try {
    assert.equal(store.countChunks(), 1);
    await manager.start();
    assert.equal(builds, 1);
    assert.equal(store.countChunks(), 1);
    assert.equal(store.getEmbedderMeta().id, 'fake@2-v2');
  } finally {
    await manager.stop();
    store.close();
  }
});

test('watch roots are narrowed to concrete allowlist subtrees', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-watch-root-'));
  for (const dir of [
    'memory/reference',
    'memory/sessions',
    'memory/users',
    'http/public/pages',
    '.claude/skills',
    '.claude/skills/example/references',
    '.claude/skills/example/node_modules',
    'workspace',
    'workspace/example/docs',
    'workspace/example/node_modules',
    'workspace/example/.git',
    'node_modules',
    '.git'
  ]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }

  const config = structuredClone(DEFAULT_CONFIG);
  config.corpus.roots = [root];

  const watched = concreteWatchDirs(config).map(entry => ({
    dir: path.relative(root, entry.dir).split(path.sep).join('/'),
    recursive: entry.recursive
  }));

  assert.deepEqual(watched, [
    { dir: '.claude/skills', recursive: false },
    { dir: '.claude/skills/example/references', recursive: true },
    { dir: 'http/public/pages', recursive: true },
    { dir: 'memory/reference', recursive: true },
    { dir: 'memory/sessions', recursive: false },
    { dir: 'memory/users', recursive: true },
    { dir: 'workspace', recursive: false }
  ]);
  assert.equal(watched.some(entry => entry.dir === 'node_modules'), false);
  assert.equal(watched.some(entry => entry.dir === '.claude/skills/example/node_modules'), false);
  assert.equal(watched.some(entry => entry.dir === '.git'), false);
  assert.equal(watched.some(entry => entry.dir === ''), false);
});

function buildFreshConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-fresh-reuse-root-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-fresh-reuse-data-'));
  const file = path.join(root, 'memory/reference/projects.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# Alpha\n\nAlpha project memory has enough durable content for indexing.');

  const config = structuredClone(DEFAULT_CONFIG);
  config.indexPath = path.join(dataDir, 'index.sqlite');
  config.dataDir = dataDir;
  config.corpus.roots = [root];
  config.corpus.allow = ['memory/reference/**/*.md'];
  config.chunking.minTokens = 3;
  config.chunking.targetTokens = 25;
  config.chunking.maxTokens = 60;
  config.embedder.dimension = 2;
  config.freshness.watch = false;
  config.freshness.sweep = false;
  return { config, file };
}

async function buildStampedIndex() {
  const { config, file } = buildFreshConfig();
  const store = new ChunkStore(config.indexPath);
  const manager = new FreshnessManager(config, {
    embedder: new FakeEmbedder(),
    store,
    log: () => {},
    build: async (_config, options) => buildIndex(_config, options)
  });
  try {
    await manager.start();
  } finally {
    await manager.stop();
    store.close();
  }
  return { config, file };
}

async function startWithBuildSpy(config, options = {}) {
  const store = new ChunkStore(config.indexPath);
  const builds = { count: 0 };
  const manager = new FreshnessManager(config, {
    embedder: new FakeEmbedder(),
    store,
    log: () => {},
    build: async () => {
      builds.count += 1;
      return { total: 1, inserted: 0, updated: 1, unchanged: 0, removed: 0 };
    },
    ...options
  });
  try {
    await manager.start();
  } finally {
    await manager.stop();
    store.close();
  }
  return { builds };
}
