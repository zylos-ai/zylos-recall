import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../src/lib/config.js';
import { ReadCore } from '../src/lib/read-core.js';
import { ChunkStore } from '../src/lib/store.js';
import { TopicEngine } from '../src/lib/topic-engine.js';
import { NodeWriter } from '../src/lib/write-primitives.js';

class StubEmbedder {
  id() {
    return 'read-core-stub@3';
  }

  dimension() {
    return 3;
  }

  async embed(texts, mode) {
    assert.equal(mode, 'query');
    return texts.map(vectorFor);
  }
}

class StubKeygen {
  constructor(keys = []) {
    this.keys = [...keys];
    this.calls = [];
  }

  async generateKey(contextText) {
    this.calls.push(contextText);
    return this.keys.shift() || '';
  }
}

test('reuse path uses cached situation key and retrieves without keygen', async () => {
  const setup = setupReadCore({ keygen: new StubKeygen(['alpha situation']) });
  const { readCore, writer, keygen, store } = setup;
  try {
    await writer.writeNode({
      key: 'alpha situation',
      value: 'Alpha dashboard credential setup lives in the dashboard component.'
    });

    const first = await readCore.retrieve({
      text: 'alpha planning details',
      turnIndex: 0,
      contextPct: 1
    });
    const second = await readCore.retrieve({
      text: 'alpha follow up details',
      turnIndex: 1,
      contextPct: 2
    });

    assert.equal(first.generatedKey, true);
    assert.equal(second.generatedKey, false);
    assert.deepEqual(keygen.calls, ['alpha planning details']);
    assert.equal(second.situationKey, 'alpha situation');
    assert.match(second.additionalContext, /^<retrieved-memory note=/);
    assert.match(second.additionalContext, /\[recall:nodes\/memory\/alpha situation . \d{4}-\d{2}-\d{2}\]/);
    assert.match(second.additionalContext, /Alpha dashboard credential setup/);
    assert.equal(second.log.some(entry => entry.stage === 'rerankFilter'), false);
  } finally {
    store.close();
  }
});

test('new topic generates one key, admits it, and retrieves nodes', async () => {
  const keygen = new StubKeygen(['beta deployment situation']);
  const setup = setupReadCore({ keygen });
  const { readCore, writer, topicEngine, store } = setup;
  try {
    await writer.writeNode({
      key: 'beta deployment situation',
      value: 'Beta deployment uses the manual read pipeline validation path.'
    });

    const result = await readCore.retrieve({
      text: 'beta deployment details',
      turnIndex: 4,
      contextPct: 8
    });

    assert.deepEqual(keygen.calls, ['beta deployment details']);
    assert.equal(result.generatedKey, true);
    assert.equal(result.situationKey, 'beta deployment situation');
    assert.equal(topicEngine.slots()[0].situationKey, 'beta deployment situation');
    assert.equal(result.selected[0].value, 'Beta deployment uses the manual read pipeline validation path.');
    assert.match(result.additionalContext, /Beta deployment uses/);
  } finally {
    store.close();
  }
});

test('similarity floor drops weak neighbors to an empty block', async () => {
  const setup = setupReadCore({
    keygen: new StubKeygen(['alpha situation']),
    config: { read: { similarityFloor: 0.99 } }
  });
  const { readCore, writer, store } = setup;
  try {
    await writer.writeNode({
      key: 'beta situation',
      value: 'Alpha value should be dropped by the high floor.'
    });

    const result = await readCore.retrieve({
      text: 'alpha planning details',
      turnIndex: 0
    });

    assert.equal(result.selected.length, 0);
    assert.equal(result.additionalContext, '');
    assert.deepEqual(
      result.log.find(entry => entry.stage === 'similarityFloor'),
      { stage: 'similarityFloor', threshold: 0.99, kept: 0, dropped: 1 }
    );
  } finally {
    store.close();
  }
});

test('fail-open returns empty on dependency errors', async () => {
  const topicEngine = {
    async route() {
      throw new Error('route failed');
    },
    admit() {}
  };
  const readCore = new ReadCore({
    topicEngine,
    nodeWriter: { async searchNeighbors() { return []; } },
    keygenClient: new StubKeygen(['alpha'])
  });

  const result = await readCore.retrieve({ text: 'alpha planning details', turnIndex: 0 });

  assert.equal(result.failOpen, true);
  assert.equal(result.additionalContext, '');
  assert.deepEqual(result.selected, []);
  assert.equal(result.log.at(-1).stage, 'failOpen');
});

test('lexical final pick reorders floored candidates without dropping them', async () => {
  const setup = setupReadCore({ keygen: new StubKeygen(['alpha situation']) });
  const { readCore, writer, store } = setup;
  try {
    await writer.writeNode({
      key: 'alpha weak',
      value: 'General alpha notes.'
    });
    await writer.writeNode({
      key: 'alpha dashboard',
      value: 'Dashboard API key belongs with VM fleet onboarding.'
    });

    const result = await readCore.retrieve({
      text: 'alpha dashboard api key setup',
      turnIndex: 0
    });

    assert.deepEqual(result.selected.map(node => node.key), ['alpha dashboard', 'alpha weak']);
    assert.match(result.additionalContext, /Dashboard API key belongs/);
  } finally {
    store.close();
  }
});

function setupReadCore({ keygen, config = {} } = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-read-core-'));
  const indexPath = path.join(data, 'index.sqlite');
  const embedder = new StubEmbedder();
  const store = new ChunkStore(indexPath);
  store.initialize(embedder);
  const writer = new NodeWriter({ store, embedder });
  const mergedConfig = structuredClone(DEFAULT_CONFIG);
  Object.assign(mergedConfig.read || (mergedConfig.read = {}), config.read || {});
  Object.assign(mergedConfig.retrieval, config.retrieval || {});
  const topicEngine = new TopicEngine({
    embedder,
    config: {
      ...mergedConfig.topicEngine,
      sameTopicThreshold: 0.8
    }
  });
  const readCore = new ReadCore({
    topicEngine,
    nodeWriter: writer,
    keygenClient: keygen || new StubKeygen(),
    config: mergedConfig
  });
  return { readCore, writer, keygen: readCore.keygenClient, topicEngine, store };
}

function vectorFor(text) {
  const lower = String(text).toLowerCase();
  if (lower.includes('alpha')) return [1, 0, 0];
  if (lower.includes('beta')) return [0, 1, 0];
  if (lower.includes('gamma')) return [0, 0, 1];
  return [0.1, 0.1, 0.1];
}
