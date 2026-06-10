import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_CONFIG, loadConfig, saveConfig, stopWatching, validateConfig, watchConfig } from '../src/lib/config.js';

test('loads defaults when config file is absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-config-'));
  const config = loadConfig(path.join(dir, 'missing.json'));
  assert.equal(config.enabled, true);
  assert.equal(config.embedder.provider, 'local-onnx');
  assert.equal(config.freshness.enabled, true);
  assert.equal(config.freshness.sweepIntervalMs, 300000);
  assert.equal(config.corpus.allow.includes('.claude/skills/*/references/**/*.md'), true);
  assert.equal(config.corpus.allow.includes('memory/sessions/current.md'), true);
  assert.equal(config.corpus.allow.includes('workspace/**/docs/*.md'), true);
  assert.equal(config.corpus.allow.includes('workspace/**/CLAUDE.md'), true);
  assert.equal(config.corpus.allow.includes('workspace/**/docs/**/*.md'), false);
  assert.equal(config.corpus.deny.includes('memory/sessions/**'), false);
  assert.equal(config.filter.provider, 'none');
  assert.equal(config.filter.model, 'Xenova/bge-reranker-base');
  assert.equal(config.filter.dtype, 'q8');
  assert.equal(config.filter.maxPassageTokens, 128);
  assert.deepEqual(config.retrieval.pipeline, ['denseRetrieve', 'bm25Retrieve', 'rrfFuse', 'freeGates', 'assemble']);
  assert.equal(config.retrieval.bm25TopK, 10);
  assert.equal(config.retrieval.rrfK, 60);
  assert.equal(config.retrieval.bm25AdmitTopN, 2);
  assert.deepEqual(config.retrieval.tierPenalties, { session: 0.05 });
});

test('rejects unsupported v1 providers', () => {
  assert.throws(() => validateConfig({
    enabled: true,
    corpus: { roots: ['/tmp'], allow: [], deny: [], maxFileBytes: 1 },
    chunking: { targetTokens: 10, minTokens: 1, maxTokens: 20, overlapRatio: 0.1 },
    embedder: { provider: 'api', dimension: 384 },
    retrieval: { pipeline: [] },
    service: { host: '127.0.0.1', port: 37537, timeoutMs: 1000 },
    filter: { provider: 'none' }
  }), /embedder\.provider/);
});

test('accepts rerank filter config and rejects invalid rerank values', () => {
  const valid = validateConfig({
    enabled: true,
    corpus: { roots: ['/tmp'], allow: [], deny: [], maxFileBytes: 1 },
    chunking: { targetTokens: 10, minTokens: 1, maxTokens: 20, overlapRatio: 0.1 },
    embedder: { provider: 'local-onnx', dimension: 384 },
    retrieval: {
      pipeline: ['denseRetrieve', 'rerankFilter', 'freeGates', 'assemble'],
      topK: 5,
      bm25TopK: 10,
      rrfK: 60,
      bm25AdmitTopN: 2,
      tierPenalties: { session: 0.05 }
    },
    service: { host: '127.0.0.1', port: 37537, timeoutMs: 1000 },
    freshness: { enabled: true, debounceMs: 0, sweepIntervalMs: 0 },
    filter: {
      provider: 'rerank',
      model: 'Xenova/bge-reranker-base',
      dtype: 'q8',
      threshold: 0.5,
      keepK: 5,
      maxPassageTokens: 128,
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

  assert.throws(() => validateConfig({
    ...valid,
    filter: { ...valid.filter, maxPassageTokens: 63 }
  }), /filter\.maxPassageTokens/);

  assert.throws(() => validateConfig({
    ...valid,
    filter: { ...valid.filter, maxPassageTokens: 257 }
  }), /filter\.maxPassageTokens/);
});

test('validates rerank passage cap even when filter is disabled', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.filter.provider = 'none';
  config.filter.maxPassageTokens = 512;

  assert.throws(() => validateConfig(config), /filter\.maxPassageTokens/);
});

test('validates tier penalties when present', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.retrieval.tierPenalties = { session: 0.05, memory: 0 };
  assert.equal(validateConfig(config).retrieval.tierPenalties.session, 0.05);

  assert.throws(() => validateConfig({
    ...config,
    retrieval: { ...config.retrieval, tierPenalties: [] }
  }), /retrieval\.tierPenalties must be an object/);

  assert.throws(() => validateConfig({
    ...config,
    retrieval: { ...config.retrieval, tierPenalties: { session: -0.1 } }
  }), /retrieval\.tierPenalties\.session/);

  assert.throws(() => validateConfig({
    ...config,
    retrieval: { ...config.retrieval, tierPenalties: { session: Infinity } }
  }), /retrieval\.tierPenalties\.session/);
});

test('saves config atomically with normalized paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-save-'));
  const configPath = path.join(dir, 'config.json');
  const config = saveConfig({ dataDir: dir, indexPath: path.join(dir, 'index.sqlite') }, configPath);
  assert.equal(config.dataDir, dir);
  const stat = fs.statSync(configPath);
  assert.equal(stat.mode & 0o777, 0o600);
});

test('config watcher debounces duplicate atomic-save events and re-arms after rename', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-watch-'));
  const configPath = path.join(dir, 'config.json');
  saveConfig({ dataDir: dir, indexPath: path.join(dir, 'index.sqlite'), retrieval: { topK: 5 } }, configPath);
  const seen = [];

  try {
    watchConfig(next => {
      seen.push(next.retrieval.topK);
    }, configPath);
    await delay(25);

    saveConfig({ dataDir: dir, indexPath: path.join(dir, 'index.sqlite'), retrieval: { topK: 6 } }, configPath);
    await waitFor(() => seen.length === 1);
    await delay(100);
    assert.deepEqual(seen, [6]);

    saveConfig({ dataDir: dir, indexPath: path.join(dir, 'index.sqlite'), retrieval: { topK: 7 } }, configPath);
    await waitFor(() => seen.length === 2);
    await delay(100);
    assert.deepEqual(seen, [6, 7]);
  } finally {
    stopWatching();
  }
});

test('config watcher attaches when config file does not exist yet', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-watch-missing-'));
  const configPath = path.join(dir, 'config.json');
  const seen = [];

  try {
    watchConfig(next => {
      seen.push(next.retrieval.topK);
    }, configPath);
    await delay(25);

    saveConfig({ dataDir: dir, indexPath: path.join(dir, 'index.sqlite'), retrieval: { topK: 8 } }, configPath);
    await waitFor(() => seen.length === 1);
    assert.deepEqual(seen, [8]);
  } finally {
    stopWatching();
  }
});

async function waitFor(predicate) {
  for (let i = 0; i < 30; i += 1) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error('condition not met');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
