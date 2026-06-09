import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReranker } from '../src/lib/rerankers/index.js';
import { scoresFromLogits } from '../src/lib/rerankers/local-onnx.js';

test('reranker factory returns null for disabled provider', () => {
  assert.equal(createReranker({ provider: 'none' }), null);
});

test('reranker scores use sigmoid of final logit', () => {
  const scores = scoresFromLogits({
    tolist() {
      return [[-1], [0], [2]];
    }
  });

  assert.ok(scores[0] < scores[1]);
  assert.ok(scores[1] < scores[2]);
  assert.equal(Number(scores[1].toFixed(3)), 0.5);
});
