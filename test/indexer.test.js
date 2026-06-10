import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../src/lib/config.js';
import { buildIndex, queryIndex } from '../src/lib/indexer.js';
import { buildFtsMatchQuery, ChunkStore } from '../src/lib/store.js';

class FakeEmbedder {
  constructor(id = 'fake@4') {
    this.name = id;
    this.calls = [];
  }

  id() {
    return this.name;
  }

  dimension() {
    return 4;
  }

  async embed(texts, mode) {
    this.calls.push({ mode, texts });
    return texts.map(text => vectorFor(text));
  }
}

function vectorFor(text) {
  const lower = text.toLowerCase();
  if (lower.includes('alpha')) return [1, 0, 0, 0];
  if (lower.includes('beta')) return [0, 1, 0, 0];
  return [0, 0, 1, 0];
}

function makeConfig(root, indexPath) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.indexPath = indexPath;
  config.dataDir = path.dirname(indexPath);
  config.corpus.roots = [root];
  config.corpus.allow = ['memory/reference/**/*.md'];
  config.chunking.minTokens = 3;
  config.chunking.targetTokens = 25;
  config.chunking.maxTokens = 60;
  config.embedder.dimension = 4;
  return config;
}

test('builds an index, queries it, and skips unchanged embedding work', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-index-root-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-index-data-'));
  const file = path.join(root, 'memory/reference/projects.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# Alpha

Alpha project memory has durable details that should be retrievable.

# Beta

Beta project memory has separate durable details that should be retrievable.`);

  const config = makeConfig(root, path.join(data, 'index.sqlite'));
  const embedder = new FakeEmbedder();

  const first = await buildIndex(config, { embedder });
  assert.equal(first.total, 2);
  assert.equal(embedder.calls.filter(call => call.mode === 'passage').length, 1);
  assert.equal(embedder.calls[0].texts.length, 2);

  const results = await queryIndex(config, 'alpha question', { embedder, topK: 1 });
  assert.equal(results[0].section, 'Alpha');
  const firstEmbeddingIds = embeddingRows(config.indexPath);
  const firstFtsRows = ftsRows(config.indexPath);

  await buildIndex(config, { embedder });
  const passageCalls = embedder.calls.filter(call => call.mode === 'passage');
  assert.equal(passageCalls.length, 1);
  assert.deepEqual(embeddingRows(config.indexPath), firstEmbeddingIds);
  assert.deepEqual(ftsRows(config.indexPath), firstFtsRows);

  fs.writeFileSync(file, `# Alpha

Alpha project memory has changed durable details that should be retrievable.

# Beta

Beta project memory has separate durable details that should be retrievable.`);
  await buildIndex(config, { embedder });
  assert.equal(embedder.calls.filter(call => call.mode === 'passage').length, 2);
  const changedFtsRows = ftsRows(config.indexPath);
  const firstBySection = new Map(firstFtsRows.map(row => [row.section, row]));
  const changedBySection = new Map(changedFtsRows.map(row => [row.section, row]));
  assert.notEqual(changedBySection.get('Alpha').rowid, firstBySection.get('Alpha').rowid);
  assert.match(changedBySection.get('Alpha').text, /changed durable details/);
  assert.equal(changedBySection.get('Beta').rowid, firstBySection.get('Beta').rowid);
});

test('embeds changed chunks in configured batches and yields between batches', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-index-batch-root-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-index-batch-data-'));
  const file = path.join(root, 'memory/reference/projects.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# Alpha

Alpha project memory has durable details that should be retrievable.

# Beta

Beta project memory has separate durable details that should be retrievable.

# Gamma

Gamma project memory has another set of durable details for indexing.`);

  const config = makeConfig(root, path.join(data, 'index.sqlite'));
  config.embedder.batchSize = 1;
  const embedder = new FakeEmbedder();
  let yields = 0;

  const result = await buildIndex(config, {
    embedder,
    yieldAfterBatch: async () => { yields += 1; }
  });

  assert.equal(result.total, 3);
  const passageCalls = embedder.calls.filter(call => call.mode === 'passage');
  assert.equal(passageCalls.length, 3);
  assert.deepEqual(passageCalls.map(call => call.texts.length), [1, 1, 1]);
  assert.equal(yields, 2);
});

test('FTS search escapes hostile queries and returns BM25-ranked chunks', async () => {
  const { config, embedder } = await buildSampleIndex();
  const store = new ChunkStore(config.indexPath);
  try {
    store.initialize(embedder);
    const hostileQueries = [
      '"alpha"',
      '(alpha OR beta)',
      'alpha NEAR beta',
      'alpha*',
      '"unbalanced alpha',
      '😀 alpha',
      '纯中文'
    ];
    for (const query of hostileQueries) {
      assert.doesNotThrow(() => store.searchText(query, { topK: 3 }));
    }
    assert.deepEqual(store.searchText('alpha project', { topK: 1 }).map(item => item.section), ['Alpha']);
    assert.doesNotThrow(() => store.searchText('纯中文', { topK: 3 }));
    assert.equal(buildFtsMatchQuery('alpha NEAR beta * "'), '"alpha" OR "NEAR" OR "beta"');
  } finally {
    store.close();
  }
});

test('FTS backfill populates missing rows for existing chunks', async () => {
  const { config, embedder } = await buildSampleIndex();
  let db = new Database(config.indexPath);
  try {
    db.prepare('DELETE FROM fts_chunks').run();
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fts_chunks').get().count, 0);
  } finally {
    db.close();
  }

  const store = new ChunkStore(config.indexPath);
  try {
    store.initialize(embedder);
    assert.equal(store.searchText('alpha project', { topK: 3 }).length, 2);
  } finally {
    store.close();
  }
});

test('full rebuild clears FTS rows with no orphans', async () => {
  const { config, embedder } = await buildSampleIndex();
  const file = path.join(config.corpus.roots[0], 'memory/reference/projects.md');
  fs.writeFileSync(file, `# Gamma

Gamma project memory replaces the old corpus after rebuild.`);

  const changedEmbedder = new FakeEmbedder('fake@4-v2');
  await buildIndex(config, { embedder: changedEmbedder });

  const db = new Database(config.indexPath, { readonly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fts_chunks WHERE chunk_id NOT IN (SELECT id FROM chunks)').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fts_chunks').get().count, db.prepare('SELECT COUNT(*) AS count FROM chunks').get().count);
  } finally {
    db.close();
  }
});

test('FTS search fails open when MATCH execution errors', async () => {
  const { config, embedder } = await buildSampleIndex();
  const store = new ChunkStore(config.indexPath);
  try {
    store.initialize(embedder);
    store.db.prepare('DROP TABLE fts_chunks').run();
    assert.deepEqual(store.searchText('alpha project', { topK: 3 }), []);
  } finally {
    store.close();
  }
});

async function buildSampleIndex() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-index-fts-root-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-index-fts-data-'));
  const file = path.join(root, 'memory/reference/projects.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# Alpha

Alpha project memory has durable searchable details.

# Beta

Beta project memory has separate durable searchable details.`);
  const config = makeConfig(root, path.join(data, 'index.sqlite'));
  const embedder = new FakeEmbedder();
  await buildIndex(config, { embedder });
  return { config, embedder };
}

function embeddingRows(indexPath) {
  const db = new Database(indexPath, { readonly: true });
  try {
    return db.prepare('SELECT id, chunk_id, hash FROM embeddings ORDER BY chunk_id, vector_index').all();
  } finally {
    db.close();
  }
}

function ftsRows(indexPath) {
  const db = new Database(indexPath, { readonly: true });
  try {
    return db.prepare('SELECT rowid, chunk_id, section, text FROM fts_chunks ORDER BY chunk_id').all();
  } finally {
    db.close();
  }
}
