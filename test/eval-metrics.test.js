import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mrr, ndcgAtK, precisionAtK, recallAtK } from '../eval/metrics.js';

test('precision, recall, and MRR handle hits and misses', () => {
  const ranked = ['a', 'b', 'c', 'd'];
  const relevant = new Set(['b', 'd']);

  assert.equal(precisionAtK(ranked, relevant, 2), 0.5);
  assert.equal(recallAtK(ranked, relevant, 2), 0.5);
  assert.equal(mrr(ranked, relevant), 0.5);
  assert.equal(mrr(ranked, new Set(['z'])), 0);
  assert.equal(precisionAtK(ranked, relevant, 0), 0);
});

test('nDCG uses graded gains and returns zero for all-miss cases', () => {
  const gradeMap = new Map([
    ['a', 3],
    ['b', 2],
    ['c', 1]
  ]);

  assert.equal(ndcgAtK(['a', 'b', 'c'], gradeMap, 3), 1);
  const reversed = ndcgAtK(['c', 'b', 'a'], gradeMap, 3);
  assert.ok(reversed > 0);
  assert.ok(reversed < 1);
  assert.equal(ndcgAtK(['x', 'y'], gradeMap, 2), 0);
  assert.equal(ndcgAtK(['x', 'y'], new Map(), 2), 0);
});
