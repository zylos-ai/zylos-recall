import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkMarkdownDocument } from '../src/lib/chunker.js';

test('chunks markdown by section with bounded open metadata', () => {
  const stats = { mtimeMs: Date.parse('2026-06-09T00:00:00Z') };
  const text = `# Decision Log

This section has enough durable memory content to become a chunk. It describes a current project decision with enough words to pass the minimum token threshold in the semantic chunker.

## Follow Up

This second section also has enough durable memory content to become a chunk. It should keep the source and section as typed fields while the metadata blob stays open and minimal for v1.`;

  const chunks = chunkMarkdownDocument({
    filePath: '/tmp/zylos/memory/reference/decisions.md',
    rootPath: '/tmp/zylos',
    text,
    stats
  }, {
    targetTokens: 40,
    minTokens: 10,
    maxTokens: 80,
    overlapRatio: 0.15
  });

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].source, 'memory/reference/decisions.md');
  assert.equal(chunks[0].section, 'Decision Log');
  assert.deepEqual(Object.keys(chunks[0].metadata).sort(), ['date', 'type']);
  assert.equal(chunks[0].metadata.type, 'memory');
});
