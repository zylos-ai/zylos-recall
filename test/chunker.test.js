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

test('keeps section chunk ids stable when unrelated sections are inserted', () => {
  const stats = { mtimeMs: Date.parse('2026-06-09T00:00:00Z') };
  const rootPath = '/tmp/zylos';
  const filePath = '/tmp/zylos/memory/reference/projects.md';
  const options = {
    targetTokens: 40,
    minTokens: 5,
    maxTokens: 80,
    overlapRatio: 0.15
  };
  const alpha = `# Alpha

Alpha project memory has durable details that should remain the same chunk.`;
  const beta = `# Beta

Beta project memory has durable details that should keep the same chunk id.`;

  const before = chunkMarkdownDocument({ filePath, rootPath, text: `${alpha}\n\n${beta}`, stats }, options);
  const after = chunkMarkdownDocument({
    filePath,
    rootPath,
    text: `# Inserted

Inserted section has durable details but should not renumber the later sections.

${alpha}

${beta}`,
    stats
  }, options);

  assert.equal(after.find(chunk => chunk.section === 'Alpha').id, before.find(chunk => chunk.section === 'Alpha').id);
  assert.equal(after.find(chunk => chunk.section === 'Beta').id, before.find(chunk => chunk.section === 'Beta').id);
});

test('distinguishes duplicate headings without global ordinal ids', () => {
  const stats = { mtimeMs: Date.parse('2026-06-09T00:00:00Z') };
  const chunks = chunkMarkdownDocument({
    filePath: '/tmp/zylos/memory/reference/decisions.md',
    rootPath: '/tmp/zylos',
    text: `# Decision

First decision memory has enough durable content for the semantic chunker.

# Decision

Second decision memory has different durable content for the semantic chunker.`,
    stats
  }, {
    targetTokens: 40,
    minTokens: 5,
    maxTokens: 80,
    overlapRatio: 0.15
  });

  assert.equal(chunks.length, 2);
  assert.notEqual(chunks[0].id, chunks[1].id);
});
