import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../src/lib/config.js';
import { appendClientRetrievalLog, appendRetrievalLog, redactQuery } from '../src/lib/retrieval-log.js';
import { sha256 } from '../src/lib/hash.js';

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
    stages: [{ stage: 'rerankFilter', scored: 2, kept: 1, maxPassageTokens: 128, durationMs: 42 }],
    selected: [{
      id: 'alpha',
      source: 'memory/reference/projects.md',
      score: 0.91234567,
      rerankScore: 0.81234567,
      rankScore: 0.81234567,
      finalScore: 0.93456789,
      text: 'chunk text must not be logged'
    }]
  });

  const logPath = path.join(dir, 'logs', 'retrieval.jsonl');
  const line = fs.readFileSync(logPath, 'utf8').trim();
  const parsed = JSON.parse(line);
  assert.equal(parsed.kind, 'service');
  assert.equal(parsed.queryHash, sha256('alpha project details'));
  assert.equal(parsed.queryPreview, 'alpha project details');
  assert.equal(parsed.selected[0].score, 0.912346);
  assert.equal(parsed.selected[0].rerankScore, 0.812346);
  assert.equal(parsed.selected[0].rankScore, 0.812346);
  assert.equal(parsed.selected[0].finalScore, 0.934568);
  assert.deepEqual(parsed.stages, [{ stage: 'rerankFilter', scored: 2, kept: 1, maxPassageTokens: 128, durationMs: 42 }]);
  assert.equal(line.includes('chunk text must not be logged'), false);
  assert.equal(record.injected, true);
  assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(logPath)).mode & 0o777, 0o700);
});

test('appends compact client outcome lines joinable by queryHash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-client-log-'));
  const config = structuredClone(DEFAULT_CONFIG);
  config.dataDir = dir;
  const record = appendClientRetrievalLog(config, {
    query: 'alpha project details',
    outcome: 'timeout',
    durationMs: 1001
  });

  const line = fs.readFileSync(path.join(dir, 'logs', 'retrieval.jsonl'), 'utf8').trim();
  const parsed = JSON.parse(line);
  assert.deepEqual(Object.keys(parsed).sort(), ['durationMs', 'kind', 'outcome', 'queryHash', 'ts']);
  assert.equal(parsed.kind, 'client');
  assert.equal(parsed.queryHash, sha256('alpha project details'));
  assert.equal(parsed.outcome, 'timeout');
  assert.equal(parsed.durationMs, 1001);
  assert.equal(record.kind, 'client');
});
