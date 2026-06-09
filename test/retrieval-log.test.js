import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../src/lib/config.js';
import { appendRetrievalLog, redactQuery } from '../src/lib/retrieval-log.js';

test('redacts likely secrets from query previews', () => {
  assert.equal(redactQuery('use sk-ant-api123SECRET for setup'), 'use [redacted] for setup');
  assert.equal(redactQuery('token=abc123 should not be exposed'), '[redacted] should not be exposed');
});

test('appends retrieval metadata without chunk text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-log-'));
  const config = structuredClone(DEFAULT_CONFIG);
  config.dataDir = dir;
  const record = appendRetrievalLog(config, {
    query: 'alpha project details',
    durationMs: 12,
    injected: true,
    selected: [{
      id: 'alpha',
      source: 'memory/reference/projects.md',
      score: 0.91234567,
      finalScore: 0.93456789,
      text: 'chunk text must not be logged'
    }]
  });

  const logPath = path.join(dir, 'logs', 'retrieval.jsonl');
  const line = fs.readFileSync(logPath, 'utf8').trim();
  const parsed = JSON.parse(line);
  assert.equal(parsed.queryPreview, 'alpha project details');
  assert.equal(parsed.selected[0].score, 0.912346);
  assert.equal(parsed.selected[0].finalScore, 0.934568);
  assert.equal(line.includes('chunk text must not be logged'), false);
  assert.equal(record.injected, true);
});
