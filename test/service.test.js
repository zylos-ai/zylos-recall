import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../src/lib/config.js';
import { startRuntime, stopRuntime } from '../src/index.js';

class FakeEmbedder {
  constructor({ blockWarm = false } = {}) {
    this.calls = [];
    this.blockWarm = blockWarm;
    this.releaseWarm = null;
  }

  id() {
    return 'fake@2';
  }

  dimension() {
    return 2;
  }

  async embed(texts, mode) {
    this.calls.push({ texts, mode });
    if (this.blockWarm && texts[0] === 'warmup') {
      await new Promise(resolve => { this.releaseWarm = resolve; });
    }
    return [[1, 0]];
  }
}

class FakeStore {
  initialize() {}

  search() {
    return [{
      id: 'alpha',
      text: 'alpha project memory should be returned by the service',
      source: 'memory/reference/projects.md',
      section: 'Alpha',
      hash: 'alpha-hash',
      mtime: Date.now() + 1000,
      tokenCount: 8,
      metadata: { date: '2026-06-09', type: 'memory' },
      score: 0.9
    }];
  }

  searchText() {
    return [];
  }

  close() {}
}

class ThrowingStore extends FakeStore {
  search() {
    throw new Error('search failed');
  }
}

class ThrowingReranker {
  async warmup() {
    throw new Error('reranker warm failed');
  }
}

class BlockingFreshness {
  constructor() {
    this.releaseStart = null;
  }

  async start() {
    await new Promise(resolve => { this.releaseStart = resolve; });
  }

  async stop() {}
}

test('service exposes health and retrieve endpoints', async () => {
  const config = testConfig();
  const embedder = new FakeEmbedder();
  const server = await startRuntime(config, {
    embedder,
    store: new FakeStore()
  });
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const health = await fetch(`${baseUrl}/health`);
    const healthPayload = await health.json();
    assert.equal(healthPayload.ok, true);
    assert.equal(healthPayload.service, 'zylos-recall');
    assert.deepEqual(embedder.calls[0], { texts: ['warmup'], mode: 'query' });
    await waitFor(async () => {
      const response = await fetch(`${baseUrl}/health`);
      return (await response.json()).ready === true;
    });

    const retrieve = await fetch(`${baseUrl}/retrieve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'alpha project details' })
    });
    const payload = await retrieve.json();
    assert.equal(payload.ok, true);
    assert.match(payload.additionalContext, /<retrieved-memory/);
    assert.equal(payload.selected[0].source, 'memory/reference/projects.md');
  } finally {
    await stopRuntime();
  }
});

test('service listens before warmup completes and fails open until ready', async () => {
  const config = testConfig();
  const embedder = new FakeEmbedder({ blockWarm: true });
  const server = await startRuntime(config, {
    embedder,
    store: new FakeStore()
  });
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const health = await fetch(`${baseUrl}/health`);
    const healthPayload = await health.json();
    assert.equal(healthPayload.ok, true);
    assert.equal(healthPayload.ready, false);
    assert.equal(healthPayload.warming, true);

    const early = await fetch(`${baseUrl}/retrieve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'alpha project details' })
    });
    assert.deepEqual(await early.json(), { ok: true, additionalContext: '' });

    embedder.releaseWarm();
    await waitFor(async () => {
      const response = await fetch(`${baseUrl}/health`);
      return (await response.json()).ready === true;
    });
  } finally {
    await stopRuntime();
  }
});

test('service stays not ready until initial freshness startup completes', async () => {
  const config = testConfig();
  config.freshness.enabled = true;
  const freshness = new BlockingFreshness();
  const server = await startRuntime(config, {
    embedder: new FakeEmbedder(),
    store: new FakeStore(),
    freshness
  });
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    await waitFor(async () => {
      const response = await fetch(`${baseUrl}/health`);
      const payload = await response.json();
      return payload.warming === false && payload.ready === false && payload.freshnessStarted === false;
    });

    const early = await fetch(`${baseUrl}/retrieve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'alpha project details' })
    });
    assert.deepEqual(await early.json(), { ok: true, additionalContext: '' });

    freshness.releaseStart();
    await waitFor(async () => {
      const response = await fetch(`${baseUrl}/health`);
      const payload = await response.json();
      return payload.ready === true && payload.freshnessStarted === true;
    });
  } finally {
    await stopRuntime();
  }
});

test('service records reranker warm failures and continues fail-open', async () => {
  const config = testConfig();
  config.filter.provider = 'rerank';
  const server = await startRuntime(config, {
    embedder: new FakeEmbedder(),
    reranker: new ThrowingReranker(),
    store: new FakeStore()
  });
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    await waitFor(async () => {
      const response = await fetch(`${baseUrl}/health`);
      const payload = await response.json();
      return payload.ready === true && payload.rerankWarmError === 'reranker warm failed';
    });

    const retrieve = await fetch(`${baseUrl}/retrieve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'alpha project details' })
    });
    const payload = await retrieve.json();
    assert.equal(payload.ok, true);
    assert.match(payload.additionalContext, /<retrieved-memory/);
  } finally {
    await stopRuntime();
  }
});

test('service fails open with empty context when retrieval throws', async () => {
  const config = testConfig();
  const server = await startRuntime(config, {
    embedder: new FakeEmbedder(),
    store: new ThrowingStore()
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/retrieve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'alpha project details' })
    });
    assert.deepEqual(await response.json(), { ok: true, additionalContext: '' });
  } finally {
    await stopRuntime();
  }
});

function testConfig() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-service-'));
  const config = structuredClone(DEFAULT_CONFIG);
  config.dataDir = dataDir;
  config.indexPath = path.join(dataDir, 'index.sqlite');
  config.corpus.roots = [dataDir];
  const sourceFile = path.join(dataDir, 'memory/reference/projects.md');
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, '# Alpha\n\nAlpha project memory should be returned by the service.');
  config.service.host = '127.0.0.1';
  config.service.port = 0;
  config.retrieval.threshold = 0.1;
  config.retrieval.recencyWeight = 0;
  config.freshness.enabled = false;
  return config;
}

async function waitFor(predicate) {
  for (let i = 0; i < 20; i += 1) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('condition not met');
}
