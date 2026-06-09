import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig, saveConfig, validateConfig } from '../src/lib/config.js';

test('loads defaults when config file is absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-config-'));
  const config = loadConfig(path.join(dir, 'missing.json'));
  assert.equal(config.enabled, true);
  assert.equal(config.embedder.provider, 'local-onnx');
  assert.equal(config.freshness.enabled, true);
  assert.equal(config.freshness.sweepIntervalMs, 300000);
  assert.equal(config.corpus.allow.includes('.claude/skills/*/references/**/*.md'), false);
  assert.equal(config.corpus.allow.includes('workspace/**/docs/**/*.md'), false);
  assert.equal(config.filter.provider, 'none');
  assert.equal(config.filter.model, 'Xenova/bge-reranker-base');
  assert.equal(config.filter.dtype, 'q8');
});

test('rejects unsupported v1 providers', () => {
  assert.throws(() => validateConfig({
    enabled: true,
    corpus: { roots: ['/tmp'], allow: [], deny: [], maxFileBytes: 1 },
    chunking: { targetTokens: 10, minTokens: 1, maxTokens: 20, overlapRatio: 0.1 },
    embedder: { provider: 'api', dimension: 384 },
    retrieval: { pipeline: [] },
    service: { host: '127.0.0.1', port: 37537, timeoutMs: 800 },
    filter: { provider: 'none' }
  }), /embedder\.provider/);
});

test('accepts rerank filter config and rejects invalid rerank values', () => {
  const valid = validateConfig({
    enabled: true,
    corpus: { roots: ['/tmp'], allow: [], deny: [], maxFileBytes: 1 },
    chunking: { targetTokens: 10, minTokens: 1, maxTokens: 20, overlapRatio: 0.1 },
    embedder: { provider: 'local-onnx', dimension: 384 },
    retrieval: { pipeline: ['denseRetrieve', 'rerankFilter', 'freeGates', 'assemble'], topK: 5 },
    service: { host: '127.0.0.1', port: 37537, timeoutMs: 800 },
    freshness: { enabled: true, debounceMs: 0, sweepIntervalMs: 0 },
    filter: {
      provider: 'rerank',
      model: 'Xenova/bge-reranker-base',
      dtype: 'q8',
      threshold: 0.5,
      keepK: 5,
      cacheDir: '/tmp/models'
    }
  });

  assert.equal(valid.filter.provider, 'rerank');

  assert.throws(() => validateConfig({
    ...valid,
    filter: { ...valid.filter, dtype: 'fp32' }
  }), /filter\.dtype/);

  assert.throws(() => validateConfig({
    ...valid,
    retrieval: { ...valid.retrieval, topK: 3 },
    filter: { ...valid.filter, keepK: 4 }
  }), /filter\.keepK must be <= retrieval\.topK/);
});

test('saves config atomically with normalized paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-save-'));
  const configPath = path.join(dir, 'config.json');
  const config = saveConfig({ dataDir: dir, indexPath: path.join(dir, 'index.sqlite') }, configPath);
  assert.equal(config.dataDir, dir);
  const stat = fs.statSync(configPath);
  assert.equal(stat.mode & 0o777, 0o600);
});
