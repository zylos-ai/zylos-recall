import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../src/lib/config.js';
import { buildIndex, queryIndex } from '../src/lib/indexer.js';

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

  await buildIndex(config, { embedder });
  const passageCalls = embedder.calls.filter(call => call.mode === 'passage');
  assert.equal(passageCalls.length, 1);
  assert.deepEqual(embeddingRows(config.indexPath), firstEmbeddingIds);

  fs.writeFileSync(file, `# Alpha

Alpha project memory has changed durable details that should be retrievable.

# Beta

Beta project memory has separate durable details that should be retrievable.`);
  await buildIndex(config, { embedder });
  assert.equal(embedder.calls.filter(call => call.mode === 'passage').length, 2);
});

function embeddingRows(indexPath) {
  const db = new Database(indexPath, { readonly: true });
  try {
    return db.prepare('SELECT id, chunk_id, hash FROM embeddings ORDER BY chunk_id, vector_index').all();
  } finally {
    db.close();
  }
}
