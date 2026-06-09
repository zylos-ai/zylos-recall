import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyFixtureDates, buildEvalIndex } from '../eval/build-index.js';
import { createEvalConfig } from '../eval/config.js';
import { runEval, scoreCase } from '../eval/run.js';

class FakeEmbedder {
  id() {
    return 'fake-eval@2';
  }

  dimension() {
    return 2;
  }

  async embed(texts) {
    return texts.map(text => {
      const lower = text.toLowerCase();
      if (lower.includes('alpha')) return [1, 0];
      if (lower.includes('beta')) return [0, 1];
      return [0.1, 0.1];
    });
  }
}

test('eval runner builds a tiny index and scores deterministic cases', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-eval-root-'));
  const corpus = path.join(root, 'corpus');
  fs.mkdirSync(corpus, { recursive: true });
  fs.writeFileSync(path.join(corpus, 'alpha.md'), '# Alpha\n\nAlpha project memory contains durable recall details.');
  fs.writeFileSync(path.join(corpus, 'beta.md'), '# Beta\n\nBeta scheduler memory contains durable task details.');
  fs.writeFileSync(path.join(corpus, 'noise.md'), '# Noise\n\nGarden soil and weather notes are not project memory.');

  const config = createEvalConfig({
    roots: [corpus],
    indexPath: path.join(root, 'index.sqlite'),
    minTokens: 3,
    threshold: 0.9,
    topK: 2,
    recencyWeight: 0
  });
  await buildEvalIndex({ config, embedder: new FakeEmbedder() });

  const result = await runEval({
    config,
    embedder: new FakeEmbedder(),
    cases: [
      {
        id: 'alpha',
        query: 'alpha details',
        expect: [{ source: 'corpus/alpha.md', grade: 3 }],
        forbid: ['corpus/noise.md']
      },
      {
        id: 'beta',
        query: 'beta task',
        expect: [{ source: 'corpus/beta.md', grade: 3 }],
        forbid: ['corpus/noise.md']
      }
    ],
    baseline: { meanNdcgAtK: 0.5, maxForbidViolations: 0 },
    print: false
  });

  assert.equal(result.passed, true);
  assert.equal(result.summary.cases, 2);
  assert.equal(result.summary.forbidViolations, 0);
  assert.ok(result.summary.meanNdcgAtK > 0.5);
});

test('sweep mode re-gates a precomputed candidate pool', async () => {
  const config = createEvalConfig({ threshold: 0.3, topK: 2, recencyWeight: 0 });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-eval-sweep-'));
  config.corpus.roots = [root];
  const cases = [{
    id: 'alpha',
    query: 'alpha details',
    expect: [{ source: 'corpus/alpha.md', grade: 3 }],
    forbid: ['corpus/noise.md']
  }];
  const candidatePools = new Map([[
    'alpha',
    [
      candidate(root, 'alpha.md', 0.95),
      candidate(root, 'noise.md', 0.4)
    ]
  ]]);

  const sweep = await runEval({
    config,
    cases,
    candidatePools,
    sweep: { threshold: [0.3, 0.9], recencyWeight: [0], topK: [2] },
    print: false
  });

  assert.equal(sweep.rows.length, 2);
  assert.equal(sweep.rows.find(row => row.threshold === 0.3).forbidViolations, 1);
  assert.equal(sweep.rows.find(row => row.threshold === 0.9).forbidViolations, 0);
  assert.equal(sweep.best.threshold, 0.9);
});

test('file-level metrics dedupe multiple chunks from the same source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-eval-dedupe-'));
  const result = scoreCase(
    {
      id: 'multi-chunk',
      query: 'alpha details',
      expect: [{ source: 'corpus/alpha.md', grade: 3 }],
      forbid: []
    },
    [
      candidate(root, 'alpha.md', 0.95, { id: 'alpha-1' }),
      candidate(root, 'alpha.md', 0.94, { id: 'alpha-2' })
    ],
    createEvalConfig({ threshold: 0.1, topK: 5, recencyWeight: 0 }),
    { k: 5 }
  );

  assert.deepEqual(result.ranked, ['corpus/alpha.md']);
  assert.equal(result.recallAtK, 1);
  assert.equal(result.ndcgAtK, 1);
});

test('build-index applies explicit and default fixture dates to mtimes before indexing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-eval-date-'));
  const dated = path.join(root, 'dated.md');
  const undated = path.join(root, 'undated.md');
  fs.writeFileSync(dated, '# Dated\n\ndate: 2026-05-20\n\nOld recall design.');
  fs.writeFileSync(undated, '# Undated\n\nStable but undated fixture.');

  applyFixtureDates([root]);

  assert.equal(new Date(fs.statSync(dated).mtimeMs).toISOString().slice(0, 10), '2026-05-20');
  assert.equal(new Date(fs.statSync(undated).mtimeMs).toISOString().slice(0, 10), '2026-01-01');
});

function candidate(root, source, score, overrides = {}) {
  const filePath = path.join(root, source);
  fs.writeFileSync(filePath, 'fixture');
  const mtime = Math.floor(fs.statSync(filePath).mtimeMs);
  return {
    id: source,
    source,
    section: source,
    text: source,
    hash: source,
    mtime,
    tokenCount: 2,
    metadata: { date: '2026-06-09', type: 'doc' },
    score,
    ...overrides
  };
}
