import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prefixForMode } from '../src/lib/embedders/local-onnx.js';

test('e5 prefixes are mode-specific', () => {
  assert.equal(prefixForMode('query'), 'query: ');
  assert.equal(prefixForMode('passage'), 'passage: ');
  assert.throws(() => prefixForMode('document'), /Unsupported embedding mode/);
});
