import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReranker } from '../src/lib/rerankers/index.js';
import { LocalOnnxReranker, preSlicePassageForTokenizer, scoresFromLogits } from '../src/lib/rerankers/local-onnx.js';

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

test('reranker caps tokenizer input without changing caller text', async () => {
  const original = 'one two three four five six';
  const reranker = new LocalOnnxReranker({
    provider: 'rerank',
    model: 'fake',
    dtype: 'q8',
    maxPassageTokens: 3
  });
  let tokenized = null;
  reranker.load = async () => ({
    tokenizer(texts, options) {
      tokenized = { texts, options };
      return {};
    },
    model: async () => ({
      logits: {
        tolist() {
          return [[1]];
        }
      }
    })
  });

  const scores = await reranker.rerank('query text', [original]);

  assert.equal(scores.length, 1);
  assert.deepEqual(tokenized.texts, ['query text']);
  assert.equal(tokenized.options.text_pair[0], preSlicePassageForTokenizer(original, 3));
  assert.ok(tokenized.options.text_pair[0].length < original.length);
  assert.equal(tokenized.options.max_length, 3);
  assert.equal(original, 'one two three four five six');
});
