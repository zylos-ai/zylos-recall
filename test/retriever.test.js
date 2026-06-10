import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../src/lib/config.js';
import { retrieveMemory } from '../src/lib/retriever.js';

const LEGACY_PIPELINE = ['denseRetrieve', 'rerankFilter', 'freeGates', 'assemble'];

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
  constructor(candidates, { expectedTopK = 5, textCandidates = [] } = {}) {
    this.candidates = candidates;
    this.textCandidates = textCandidates;
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

  searchText(query, options) {
    assert.equal(query, 'alpha project');
    assert.equal(options.topK, 10);
    return this.textCandidates;
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
  config.retrieval.pipeline = LEGACY_PIPELINE;
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
  const denseLog = result.log.find(entry => entry.stage === 'denseRetrieve');
  assert.deepEqual(denseLog.candidates.map(item => item.id), ['old', 'new', 'duplicate', 'weak']);
  assert.equal(denseLog.candidates[0].score, 0.52);
  assert.equal(JSON.stringify(denseLog).includes('old alpha project details'), false);
  const freeLog = result.log.find(entry => entry.stage === 'freeGates');
  assert.deepEqual(freeLog.survivors, ['new', 'old']);
  assert.equal(freeLog.drops.belowThreshold, 1);
  assert.equal(freeLog.drops.dup, 1);
  assert.deepEqual(freeLog.candidates, [
    { id: 'old', kept: true },
    { id: 'new', kept: true },
    { id: 'duplicate', dropReason: 'dup' },
    { id: 'weak', dropReason: 'belowThreshold' }
  ]);
});

test('rerank filter gates and orders candidates before free gates', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.retrieval.pipeline = LEGACY_PIPELINE;
  const { root, mtimes } = makeCorpus(['high-cosine', 'best-rerank', 'low-rerank']);
  config.corpus.roots = [root];
  config.retrieval.topK = 3;
  config.retrieval.threshold = 0.1;
  config.retrieval.recencyWeight = 0;
  config.filter.provider = 'rerank';
  config.filter.threshold = 0.5;
  config.filter.keepK = 2;
  config.filter.maxPassageTokens = 128;
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
  assert.equal(rerankLog.maxPassageTokens, 128);
  assert.deepEqual(rerankLog.candidates, [
    { id: 'high-cosine', rerankScore: 0.6, kept: true },
    { id: 'best-rerank', rerankScore: 0.95, kept: true },
    { id: 'low-rerank', rerankScore: 0.2, kept: false }
  ]);
  assert.equal(typeof rerankLog.durationMs, 'number');
  assert.match(result.additionalContext, /best answer alpha project memory with the useful details/);
});

test('rerank filter fails open when reranker throws', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.retrieval.pipeline = LEGACY_PIPELINE;
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
  config.retrieval.pipeline = LEGACY_PIPELINE;
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

test('free gates log budget drops', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.retrieval.pipeline = LEGACY_PIPELINE;
  const { root, mtimes } = makeCorpus(['first', 'second']);
  config.corpus.roots = [root];
  config.retrieval.threshold = 0.1;
  config.retrieval.maxTotalTokens = 6;
  config.retrieval.chunkTokens = 6;

  const result = await retrieveMemory(config, 'alpha project', {
    embedder: new FakeEmbedder(),
    store: new FakeStore([
      candidate('first', {
        hash: 'first-hash',
        score: 0.9,
        mtime: mtimes.first,
        tokenCount: 6,
        text: 'first alpha project match'
      }),
      candidate('second', {
        hash: 'second-hash',
        score: 0.8,
        mtime: mtimes.second,
        tokenCount: 6,
        text: 'second alpha project match'
      })
    ])
  });

  assert.deepEqual(result.selected.map(item => item.id), ['first']);
  const freeLog = result.log.find(entry => entry.stage === 'freeGates');
  assert.equal(freeLog.drops.budget, 1);
  assert.deepEqual(freeLog.candidates, [
    { id: 'first', kept: true },
    { id: 'second', dropReason: 'budget' }
  ]);
});

test('retrieval drops stale candidates whose source file changed after indexing', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.retrieval.pipeline = LEGACY_PIPELINE;
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

test('default hybrid pipeline fuses dense and BM25 ranks before gates', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const { root, mtimes } = makeCorpus(['dense-only', 'consensus', 'bm25-only', 'bm25-weak']);
  config.corpus.roots = [root];
  config.retrieval.threshold = 0.5;
  config.retrieval.recencyWeight = 0;
  config.retrieval.maxTotalTokens = 100;
  const store = new FakeStore([
    candidate('dense-only', {
      hash: 'dense-only-hash',
      score: 0.9,
      mtime: mtimes['dense-only'],
      text: 'dense only alpha project memory'
    }),
    candidate('consensus', {
      hash: 'consensus-hash',
      score: 0.8,
      mtime: mtimes.consensus,
      text: 'consensus alpha project memory'
    })
  ], {
    textCandidates: [
      candidate('consensus', {
        hash: 'consensus-hash',
        bm25Score: 12,
        mtime: mtimes.consensus,
        text: 'consensus alpha project memory'
      }),
      candidate('bm25-only', {
        hash: 'bm25-only-hash',
        bm25Score: 10,
        mtime: mtimes['bm25-only'],
        text: 'bm25 only alpha project memory'
      }),
      candidate('bm25-weak', {
        hash: 'bm25-weak-hash',
        bm25Score: 8,
        mtime: mtimes['bm25-weak'],
        text: 'weak bm25 alpha project memory'
      })
    ]
  });

  const result = await retrieveMemory(config, 'alpha project', {
    embedder: new FakeEmbedder(),
    store
  });

  assert.deepEqual(result.log.map(entry => entry.stage), ['denseRetrieve', 'bm25Retrieve', 'rrfFuse', 'freeGates', 'assemble']);
  assert.deepEqual(result.selected.map(item => item.id), ['consensus', 'dense-only', 'bm25-only']);
  const consensus = result.selected.find(item => item.id === 'consensus');
  assert.equal(consensus.denseRank, 2);
  assert.equal(consensus.bm25Rank, 1);
  assert.ok(consensus.normalizedFused > result.selected.find(item => item.id === 'dense-only').normalizedFused);
  const rrfLog = result.log.find(entry => entry.stage === 'rrfFuse');
  assert.deepEqual(rrfLog.candidates.find(item => item.id === 'consensus'), {
    id: 'consensus',
    denseRank: 2,
    bm25Rank: 1,
    fusedScore: 0.032522
  });
  const freeLog = result.log.find(entry => entry.stage === 'freeGates');
  assert.equal(freeLog.drops.bm25WeakNoDense, 1);
  assert.deepEqual(freeLog.candidates.find(item => item.id === 'bm25-weak'), {
    id: 'bm25-weak',
    dropReason: 'bm25WeakNoDense'
  });
  assert.equal(JSON.stringify(result.log).includes('consensus alpha project memory'), false);
});

test('legacy pipeline does not call BM25 and preserves old stage shape', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const { root, mtimes } = makeCorpus(['alpha']);
  config.corpus.roots = [root];
  config.retrieval.pipeline = ['denseRetrieve', 'freeGates', 'assemble'];
  config.retrieval.threshold = 0.1;
  const store = new FakeStore([
    candidate('alpha', {
      hash: 'alpha-hash',
      score: 0.9,
      mtime: mtimes.alpha,
      text: 'alpha project memory'
    })
  ]);
  store.searchText = () => {
    throw new Error('legacy pipeline should not call searchText');
  };

  const result = await retrieveMemory(config, 'alpha project', {
    embedder: new FakeEmbedder(),
    store
  });

  assert.deepEqual(result.log.map(entry => entry.stage), ['denseRetrieve', 'freeGates', 'assemble']);
  assert.equal(result.selected[0].id, 'alpha');
  assert.equal(result.selected[0].rankScore, 0.9);
});

test('BM25 retrieval fails open when text search throws', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const { root, mtimes } = makeCorpus(['alpha']);
  config.corpus.roots = [root];
  config.retrieval.threshold = 0.1;
  const store = new FakeStore([
    candidate('alpha', {
      hash: 'alpha-hash',
      score: 0.9,
      mtime: mtimes.alpha,
      text: 'alpha project memory'
    })
  ]);
  store.searchText = () => {
    throw new Error('fts unavailable');
  };

  const result = await retrieveMemory(config, 'alpha project', {
    embedder: new FakeEmbedder(),
    store
  });

  assert.equal(result.selected[0].id, 'alpha');
  const bm25Log = result.log.find(entry => entry.stage === 'bm25Retrieve');
  assert.equal(bm25Log.failOpen, true);
  assert.equal(bm25Log.reason, 'fts unavailable');
});

test('session tier penalty nudges ordering without vetoing strong matches', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const { root, mtimes } = makeCorpus(['curated', 'session', 'weaker']);
  writeSessionFile(root, mtimes.session);
  config.corpus.roots = [root];
  config.retrieval.pipeline = ['denseRetrieve', 'freeGates', 'assemble'];
  config.retrieval.threshold = 0.1;
  config.retrieval.recencyWeight = 0;
  config.retrieval.maxTotalTokens = 100;

  const result = await retrieveMemory(config, 'alpha project', {
    embedder: new FakeEmbedder(),
    store: new FakeStore([
      candidate('session', {
        source: 'memory/sessions/current.md',
        hash: 'session-hash',
        score: 0.9,
        mtime: mtimes.session,
        metadata: { date: '2026-06-09', type: 'session' },
        text: 'session alpha project memory'
      }),
      candidate('curated', {
        hash: 'curated-hash',
        score: 0.9,
        mtime: mtimes.curated,
        text: 'curated alpha project memory'
      }),
      candidate('weaker', {
        hash: 'weaker-hash',
        score: 0.82,
        mtime: mtimes.weaker,
        text: 'weaker curated alpha project memory'
      })
    ])
  });

  assert.deepEqual(result.selected.map(item => item.id), ['curated', 'session', 'weaker']);
  assert.equal(result.selected.find(item => item.id === 'session').finalScore, 0.85);
  assert.match(result.additionalContext, /\[memory\/sessions\/current\.md . 2026-06-09 . session log — may be superseded\]/);
  assert.doesNotMatch(result.additionalContext, /\[memory\/reference\/curated\.md . 2026-06-09 . session log/);
});

test('missing tier penalties preserve legacy score ordering', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const { root, mtimes } = makeCorpus(['session']);
  writeSessionFile(root, mtimes.session);
  config.corpus.roots = [root];
  config.retrieval.pipeline = ['denseRetrieve', 'freeGates', 'assemble'];
  config.retrieval.threshold = 0.1;
  config.retrieval.recencyWeight = 0;
  delete config.retrieval.tierPenalties;

  const result = await retrieveMemory(config, 'alpha project', {
    embedder: new FakeEmbedder(),
    store: new FakeStore([
      candidate('session', {
        source: 'memory/sessions/current.md',
        hash: 'session-hash',
        score: 0.9,
        mtime: mtimes.session,
        metadata: { date: '2026-06-09', type: 'session' },
        text: 'session alpha project memory'
      })
    ])
  });

  assert.equal(result.selected[0].rankScore, 0.9);
  assert.equal(result.selected[0].finalScore, 0.9);
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

function writeSessionFile(root, mtime) {
  const file = path.join(root, 'memory/sessions/current.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# Session\n\nsession alpha project memory');
  const time = new Date(mtime);
  fs.utimesSync(file, time, time);
}
