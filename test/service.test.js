import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../src/lib/config.js';
import { startRuntime, stopRuntime } from '../src/index.js';

class FakeEmbedder {
  constructor() {
    this.calls = [];
  }

  id() {
    return 'fake@2';
  }

  dimension() {
    return 2;
  }

  async embed(texts, mode) {
    this.calls.push({ texts, mode });
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
      mtime: Date.parse('2026-06-09T00:00:00Z'),
      tokenCount: 8,
      metadata: { date: '2026-06-09', type: 'memory' },
      score: 0.9
    }];
  }

  close() {}
}

class ThrowingStore extends FakeStore {
  search() {
    throw new Error('search failed');
  }
}

test('service exposes health and retrieve endpoints', async () => {
  const config = testConfig();
  const embedder = new FakeEmbedder();
  const server = await startRuntime(config, {
    embedder,
    store: new FakeStore()
  });
  try {
    assert.deepEqual(embedder.calls[0], { texts: ['warmup'], mode: 'query' });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const health = await fetch(`${baseUrl}/health`);
    assert.deepEqual(await health.json(), { ok: true, service: 'zylos-recall' });

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
  const config = structuredClone(DEFAULT_CONFIG);
  config.service.host = '127.0.0.1';
  config.service.port = 0;
  config.retrieval.threshold = 0.1;
  config.retrieval.recencyWeight = 0;
  return config;
}
