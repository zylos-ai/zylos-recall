import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  constructor(candidates, { expectedTopK = 5 } = {}) {
    this.candidates = candidates;
    this.expectedTopK = expectedTopK;
    this.initialized = false;
    this.closed = false;
  }

  initialize() {
    this.initialized = true;
  }

  search(vector, options) {
    assert.deepEqual(vector, [1, 0]);
    assert.equal(options.topK, this.expectedTopK);
    return this.candidates;
  }

  close() {
    this.closed = true;
  }
}

class FakeReranker {
  constructor(scoresByText) {
    this.scoresByText = scoresByText;
    this.calls = [];
  }

  async rerank(query, passages) {
    this.calls.push({ query, passages });
    return passages.map(passage => this.scoresByText.get(passage) ?? 0);
  }
}

class ThrowingReranker {
  async rerank() {
    throw new Error('rerank failed');
  }
}

test('retrieval pipeline gates, ranks, budgets, and assembles context', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const { root, mtimes } = makeCorpus(['old', 'new', 'duplicate', 'weak']);
  config.corpus.roots = [root];
  config.retrieval.threshold = 0.5;
  config.retrieval.recencyWeight = 0.2;
  config.retrieval.maxTotalTokens = 12;
  config.retrieval.chunkTokens = 6;
  const store = new FakeStore([
    candidate('old', {
      hash: 'old-hash',
      score: 0.52,
      mtime: mtimes.old,
      text: 'old alpha project details should still be available here'
    }),
    candidate('new', {
      hash: 'new-hash',
      score: 0.55,
      mtime: mtimes.new,
      text: 'new alpha project details should rank first because recent'
    }),
    candidate('duplicate', {
      hash: 'new-hash',
      score: 0.54,
      mtime: mtimes.duplicate,
      text: 'duplicate new alpha content should be deduplicated'
    }),
    candidate('weak', {
      hash: 'weak-hash',
      score: 0.49,
      mtime: mtimes.weak,
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
  assert.match(result.additionalContext, /actively editing any cited source file/);
  assert.match(result.additionalContext, /\[memory\/reference\/new\.md . 2026-06-09\]/);
  assert.match(result.additionalContext, /\[truncated; read source file for full chunk\]/);
  assert.match(result.additionalContext, /<\/retrieved-memory>$/);
  assert.deepEqual(result.log.map(entry => entry.stage), ['denseRetrieve', 'rerankFilter', 'freeGates', 'assemble']);
  assert.equal(result.log.find(entry => entry.stage === 'rerankFilter').enabled, false);
});

test('rerank filter gates and orders candidates before free gates', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const { root, mtimes } = makeCorpus(['high-cosine', 'best-rerank', 'low-rerank']);
  config.corpus.roots = [root];
  config.retrieval.topK = 3;
  config.retrieval.threshold = 0.1;
  config.retrieval.recencyWeight = 0;
  config.filter.provider = 'rerank';
  config.filter.threshold = 0.5;
  config.filter.keepK = 2;
  const highCosineText = 'high cosine alpha project mention without the useful answer';
  const bestText = 'best answer alpha project memory with the useful details';
  const lowText = 'low rerank alpha project mention';
  const reranker = new FakeReranker(new Map([
    [highCosineText, 0.6],
    [bestText, 0.95],
    [lowText, 0.2]
  ]));

  const result = await retrieveMemory(config, 'alpha project', {
    embedder: new FakeEmbedder(),
    reranker,
    store: new FakeStore([
      candidate('high-cosine', {
        hash: 'high-cosine-hash',
        score: 0.99,
        mtime: mtimes['high-cosine'],
        text: highCosineText
      }),
      candidate('best-rerank', {
        hash: 'best-rerank-hash',
        score: 0.6,
        mtime: mtimes['best-rerank'],
        text: bestText
      }),
      candidate('low-rerank', {
        hash: 'low-rerank-hash',
        score: 0.7,
        mtime: mtimes['low-rerank'],
        text: lowText
      })
    ], { expectedTopK: 3 })
  });

  assert.deepEqual(reranker.calls[0], {
    query: 'alpha project',
    passages: [highCosineText, bestText, lowText]
  });
  assert.deepEqual(result.selected.map(item => item.id), ['best-rerank', 'high-cosine']);
  assert.equal(result.selected[0].rerankScore, 0.95);
  assert.equal(result.selected[0].rankScore, 0.95);
  const rerankLog = result.log.find(entry => entry.stage === 'rerankFilter');
  assert.equal(rerankLog.scored, 3);
  assert.equal(rerankLog.kept, 2);
  assert.equal(rerankLog.threshold, 0.5);
  assert.equal(rerankLog.keepK, 2);
  assert.equal(typeof rerankLog.durationMs, 'number');
});

test('rerank filter fails open when reranker throws', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const { root, mtimes } = makeCorpus(['alpha']);
  config.corpus.roots = [root];
  config.retrieval.threshold = 0.1;
  config.filter.provider = 'rerank';
  config.filter.threshold = 0.9;

  const result = await retrieveMemory(config, 'alpha project', {
    embedder: new FakeEmbedder(),
    reranker: new ThrowingReranker(),
    store: new FakeStore([
      candidate('alpha', {
        hash: 'alpha-hash',
        score: 0.8,
        mtime: mtimes.alpha,
        text: 'alpha project memory survives reranker failure'
      })
    ])
  });

  assert.equal(result.selected.length, 1);
  const rerankLog = result.log.find(entry => entry.stage === 'rerankFilter');
  assert.equal(rerankLog.failOpen, true);
  assert.equal(rerankLog.reason, 'rerank failed');
});

test('retrieval returns empty context when gates reject all candidates', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const { root, mtimes } = makeCorpus(['weak']);
  config.corpus.roots = [root];
  config.retrieval.threshold = 0.95;
  const result = await retrieveMemory(config, 'alpha project', {
    embedder: new FakeEmbedder(),
    store: new FakeStore([
      candidate('weak', {
        hash: 'weak-hash',
        score: 0.4,
        mtime: mtimes.weak,
        text: 'weak alpha project match'
      })
    ])
  });

  assert.equal(result.additionalContext, '');
  assert.equal(result.selected.length, 0);
});

test('retrieval drops stale candidates whose source file changed after indexing', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const { root, mtimes } = makeCorpus(['stale']);
  config.corpus.roots = [root];
  fs.appendFileSync(path.join(root, 'memory/reference/stale.md'), '\nnewer edit');

  const result = await retrieveMemory(config, 'alpha project', {
    embedder: new FakeEmbedder(),
    store: new FakeStore([
      candidate('stale', {
        hash: 'stale-hash',
        score: 0.9,
        mtime: mtimes.stale,
        text: 'stale alpha project match'
      })
    ])
  });

  assert.equal(result.additionalContext, '');
  assert.equal(result.selected.length, 0);
});

function makeCorpus(ids) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-retriever-'));
  const dir = path.join(root, 'memory/reference');
  fs.mkdirSync(dir, { recursive: true });
  const mtimes = {};
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    const file = path.join(dir, `${id}.md`);
    fs.writeFileSync(file, `# ${id}\n\n${id} alpha project memory`);
    const time = new Date(Date.parse('2026-06-09T00:00:00Z') + index * 1000);
    fs.utimesSync(file, time, time);
    mtimes[id] = time.getTime();
  }
  return { root, mtimes };
}

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
