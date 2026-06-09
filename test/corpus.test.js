import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../src/lib/config.js';
import { collectCorpusChunks, walkCorpusFiles } from '../src/lib/corpus.js';

test('walks allowlisted markdown and applies hard deny rules', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-corpus-'));
  fs.mkdirSync(path.join(root, 'memory/reference'), { recursive: true });
  fs.mkdirSync(path.join(root, 'memory/sessions'), { recursive: true });
  fs.writeFileSync(path.join(root, 'memory/reference/decisions.md'), '# Decisions\n\nEnough words for an indexed durable decision chunk that should be included by the allowlist.');
  fs.writeFileSync(path.join(root, 'memory/reference/API-TOKEN.md'), '# Token\n\nThis convenience-denied token-like markdown file should not be indexed.');
  fs.writeFileSync(path.join(root, 'memory/sessions/current.md'), '# Session\n\nThis chronological session should not be indexed.');
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=secret');

  const config = structuredClone(DEFAULT_CONFIG);
  config.corpus.roots = [root];
  config.chunking.minTokens = 3;

  const files = [...walkCorpusFiles(config)].map(entry => path.relative(root, entry.filePath));
  assert.deepEqual(files, ['memory/reference/decisions.md']);

  const { chunks } = collectCorpusChunks(config);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].metadata.type, 'memory');
});
