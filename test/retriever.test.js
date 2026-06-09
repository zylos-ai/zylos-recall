import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../src/lib/config.js';
import { retrieveMemory } from '../src/lib/retriever.js';

class FakeEmbedder {
  id() {
    return 'fake@2';
  }

  dimension() {
    return 2;
  }

  async embed(texts, mode) {
    assert.equal(mode, 'query');
    assert.deepEqual(texts, ['alpha project']);
    return [[1, 0]];
  }
}

class FakeStore {
  constructor(candidates) {
    this.candidates = candidates;
    this.initialized = false;
    this.closed = false;
  }

  initialize() {
    this.initialized = true;
  }

  search(vector, options) {
    assert.deepEqual(vector, [1, 0]);
    assert.equal(options.topK, 5);
    return this.candidates;
  }

  close() {
    this.closed = true;
  }
}

test('retrieval pipeline gates, ranks, budgets, and assembles context', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.retrieval.threshold = 0.5;
  config.retrieval.recencyWeight = 0.2;
  config.retrieval.maxTotalTokens = 12;
  config.retrieval.chunkTokens = 6;
  const now = Date.now();
  const store = new FakeStore([
    candidate('old', {
      hash: 'old-hash',
      score: 0.6,
      mtime: now - 60 * 86_400_000,
      text: 'old alpha project details should still be available here'
    }),
    candidate('new', {
      hash: 'new-hash',
      score: 0.55,
      mtime: now,
      text: 'new alpha project details should rank first because recent'
    }),
    candidate('duplicate', {
      hash: 'new-hash',
      score: 0.54,
      mtime: now,
      text: 'duplicate new alpha content should be deduplicated'
    }),
    candidate('weak', {
      hash: 'weak-hash',
      score: 0.49,
      mtime: now,
      text: 'weak match should not pass threshold'
    })
  ]);

  const result = await retrieveMemory(config, 'alpha project', {
    embedder: new FakeEmbedder(),
    store
  });

  assert.equal(store.initialized, true);
  assert.deepEqual(result.selected.map(item => item.id), ['new', 'old']);
  assert.match(result.additionalContext, /^<retrieved-memory note=/);
  assert.match(result.additionalContext, /\[memory\/reference\/new\.md . 2026-06-09\]/);
  assert.match(result.additionalContext, /\[truncated; read source file for full chunk\]/);
  assert.match(result.additionalContext, /<\/retrieved-memory>$/);
  assert.deepEqual(result.log.map(entry => entry.stage), ['denseRetrieve', 'freeGates', 'assemble']);
});

test('retrieval returns empty context when gates reject all candidates', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.retrieval.threshold = 0.95;
  const result = await retrieveMemory(config, 'alpha project', {
    embedder: new FakeEmbedder(),
    store: new FakeStore([
      candidate('weak', {
        hash: 'weak-hash',
        score: 0.4,
        mtime: Date.now(),
        text: 'weak alpha project match'
      })
    ])
  });

  assert.equal(result.additionalContext, '');
  assert.equal(result.selected.length, 0);
});

function candidate(id, overrides) {
  return {
    id,
    source: `memory/reference/${id}.md`,
    section: id,
    tokenCount: 6,
    metadata: { date: '2026-06-09', type: 'memory' },
    ...overrides
  };
}
