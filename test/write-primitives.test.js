import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../src/lib/config.js';
import { buildIndex } from '../src/lib/indexer.js';
import { TOPIC_EMBED_MODE } from '../src/lib/topic-engine.js';
import { ChunkStore } from '../src/lib/store.js';
import { NODE_EMBED_MODE, NodeWriter } from '../src/lib/write-primitives.js';

class StubEmbedder {
  constructor(id = 'stub@3') {
    this.name = id;
    this.calls = [];
  }

  id() {
    return this.name;
  }

  dimension() {
    return 3;
  }

  async embed(texts, mode) {
    this.calls.push({ texts, mode });
    return texts.map(vectorFor);
  }
}

test('writeNode persists a stable memory node and round-trips value intact', async () => {
  const { store, embedder, writer } = setupWriter();
  try {
    const first = await writer.writeNode({
      key: 'alpha project owner',
      value: 'Felix owns alpha planning.'
    });
    const second = await writer.writeNode({
      key: 'alpha project owner',
      value: 'Felix owns alpha planning.'
    });

    assert.equal(first.id, second.id);
    assert.deepEqual(writer.getNode(first.id), {
      id: first.id,
      key: 'alpha project owner',
      value: 'Felix owns alpha planning.',
      kind: 'memory',
      metadata: {
        kind: 'memory',
        key: 'alpha project owner',
        value: 'Felix owns alpha planning.'
      },
      createdAt: writer.getNode(first.id).createdAt,
      updatedAt: writer.getNode(first.id).updatedAt
    });
    assert.deepEqual(embedder.calls.map(call => call.mode), [NODE_EMBED_MODE, NODE_EMBED_MODE]);
  } finally {
    store.close();
  }
});

test('searchNeighbors ranks memory keys, returns values, and excludes dormant chunks', async () => {
  const { store, embedder, writer } = setupWriter();
  try {
    await writer.writeNode({ key: 'alpha roadmap', value: 'Alpha value' });
    await writer.writeNode({ key: 'beta rollout', value: 'Beta value' });
    await insertDormantChunk(store);

    const results = await writer.searchNeighbors({ key: 'alpha question', k: 2 });

    assert.deepEqual(results.map(result => result.key), ['alpha roadmap', 'beta rollout']);
    assert.deepEqual(results.map(result => result.value), ['Alpha value', 'Beta value']);
    assert.equal(results.some(result => result.id === 'legacy-alpha-chunk'), false);
    assert.equal(embedder.calls.at(-1).mode, NODE_EMBED_MODE);
  } finally {
    store.close();
  }
});

test('applyConsolidation creates, replaces on update, no-ops, and throws for missing targets', async () => {
  const { store, embedder, writer } = setupWriter();
  try {
    const created = await writer.applyConsolidation({
      operation: 'CREATE',
      key: 'alpha status',
      value: 'Initial value.'
    });
    assert.equal(created.op, 'CREATE');

    const updated = await writer.applyConsolidation({
      operation: 'UPDATE',
      target_id: created.id,
      value: 'Merged replacement value.'
    });
    assert.deepEqual(updated, { id: created.id, op: 'UPDATE' });
    assert.equal(writer.getNode(created.id).value, 'Merged replacement value.');
    assert.equal(writer.getNode(created.id).key, 'alpha status');
    assert.equal(embedder.calls.length, 1);

    assert.deepEqual(await writer.applyConsolidation({ operation: 'NOOP' }), { id: null, op: 'NOOP' });
    assert.equal(writer.listNodes().length, 1);
    assert.rejects(
      () => writer.applyConsolidation({
        operation: 'UPDATE',
        target_id: 'memory-node:missing',
        value: 'replacement'
      }),
      /Cannot update missing memory node/
    );
  } finally {
    store.close();
  }
});

test('node embedding mode stays symmetric with W4 topic/read mode', () => {
  assert.equal(NODE_EMBED_MODE, TOPIC_EMBED_MODE);
  assert.equal(NODE_EMBED_MODE, 'query');
});

test('buildIndex preserves memory nodes while replacing dormant corpus chunks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-node-root-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-node-data-'));
  const file = path.join(root, 'memory/reference/projects.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# Alpha

Alpha project durable detail.`);

  const config = makeConfig(root, path.join(data, 'index.sqlite'));
  const embedder = new StubEmbedder();
  await buildIndex(config, { embedder });

  let store = new ChunkStore(config.indexPath);
  try {
    store.initialize(embedder);
    const writer = new NodeWriter({ store, embedder });
    const node = await writer.writeNode({ key: 'beta memory node', value: 'Beta node value.' });
    const lesson = await writer.writeNode({
      key: 'lesson node',
      value: 'Lesson node value.',
      kind: 'lesson'
    });
    fs.writeFileSync(file, `# Gamma

Gamma project replaces the old file corpus.`);
    await buildIndex(config, { embedder });

    assert.equal(writer.getNode(node.id).value, 'Beta node value.');
    assert.equal(writer.getNode(lesson.id).value, 'Lesson node value.');
    assert.equal(ftsHasChunk(config.indexPath, node.id), false);
    assert.equal(ftsHasChunk(config.indexPath, lesson.id), false);
    assert.deepEqual(store.listTocRows().map(row => row.section), ['Gamma']);
    assert.equal(store.countChunks(), 1);
  } finally {
    store.close();
  }
});

test('fullReindex preserves all node kinds and clears stale node embeddings', async () => {
  const { store, embedder, writer } = setupWriter();
  try {
    const memory = await writer.writeNode({ key: 'alpha memory', value: 'Alpha value.' });
    const lesson = await writer.writeNode({
      key: 'beta lesson',
      value: 'Beta lesson value.',
      kind: 'lesson'
    });
    await insertDormantChunk(store);

    assert.equal(store.countChunks(), 1);
    assert.equal(await writer.searchNeighbors({ key: 'alpha question', k: 1 }).then(rows => rows.length), 1);

    store.initialize(new StubEmbedder('stub-v2@3'));

    assert.equal(writer.getNode(memory.id).value, 'Alpha value.');
    assert.equal(writer.getNode(lesson.id).value, 'Beta lesson value.');
    assert.equal(store.countChunks(), 0);
    assert.deepEqual(await writer.searchNeighbors({ key: 'alpha question', k: 1 }), []);
    assert.equal(embeddingCount(store), 0);
  } finally {
    store.close();
  }
});

function setupWriter() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-node-writer-'));
  const store = new ChunkStore(path.join(data, 'index.sqlite'));
  const embedder = new StubEmbedder();
  store.initialize(embedder);
  return {
    store,
    embedder,
    writer: new NodeWriter({ store, embedder })
  };
}

async function insertDormantChunk(store) {
  store.replaceCorpus([
    {
      id: 'legacy-alpha-chunk',
      text: 'alpha roadmap',
      source: '/tmp/legacy.md',
      section: 'Alpha',
      hash: 'legacy-alpha-hash',
      mtime: Date.now(),
      tokenCount: 2,
      metadata: { type: 'memory' }
    }
  ], 'stub@3', [[vectorFor('alpha roadmap')]]);
}

function makeConfig(root, indexPath) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.indexPath = indexPath;
  config.dataDir = path.dirname(indexPath);
  config.corpus.roots = [root];
  config.corpus.allow = ['memory/reference/**/*.md'];
  config.chunking.minTokens = 1;
  config.chunking.targetTokens = 20;
  config.chunking.maxTokens = 60;
  config.embedder.dimension = 3;
  return config;
}

function vectorFor(text) {
  const lower = String(text).toLowerCase();
  if (lower.includes('alpha')) return [1, 0, 0];
  if (lower.includes('beta')) return [0, 1, 0];
  if (lower.includes('gamma')) return [0, 0, 1];
  return [0.1, 0.1, 0.1];
}

function ftsHasChunk(indexPath, id) {
  const db = new Database(indexPath, { readonly: true });
  try {
    return Boolean(db.prepare('SELECT 1 FROM fts_chunks WHERE chunk_id = ?').get(id));
  } finally {
    db.close();
  }
}

function embeddingCount(store) {
  return store.db.prepare('SELECT COUNT(*) AS count FROM embeddings').get().count;
}
