import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../src/lib/config.js';
import { createReadCore } from '../src/lib/read-core.js';
import { TopicEngine } from '../src/lib/topic-engine.js';
import { ChunkStore } from '../src/lib/store.js';
import { NodeWriter } from '../src/lib/write-primitives.js';

class StubEmbedder {
  constructor(id = 'stub@3') {
    this.name = id;
    this.calls = [];
  }

  id() {
    return this.name;
  }

  dimension() {
    return 3;
  }

  async embed(texts, mode) {
    this.calls.push({ texts, mode });
    return texts.map(vectorFor);
  }
}

class StubKeygen {
  constructor(key = 'alpha generated key') {
    this.key = key;
    this.calls = [];
  }

  async generateKey(contextText) {
    this.calls.push(contextText);
    return this.key;
  }
}

test('W3 read core reuses cached situation key and assembles v0.1 memory block', async () => {
  const setup = setupReadCore();
  const { store, writer, topicEngine, keygen, readCore } = setup;
  try {
    await writer.writeNode({
      key: 'alpha cached key',
      value: 'Alpha cached memory value.'
    });
    topicEngine.admit({
      situationKey: 'alpha cached key',
      anchorVec: [1, 0, 0],
      turnIndex: 0
    });

    const result = await readCore.retrieve({
      text: 'alpha follow up context',
      turnIndex: 1,
      contextPct: 4
    });

    assert.equal(keygen.calls.length, 0);
    assert.equal(result.generatedKey, false);
    assert.equal(result.situationKey, 'alpha cached key');
    assert.deepEqual(result.selected.map(node => node.key), ['alpha cached key']);
    assert.match(result.additionalContext, /^<retrieved-memory note=/);
    assert.match(result.additionalContext, /\[recall:nodes\/memory\/alpha cached key · \d{4}-\d{2}-\d{2}\] Alpha cached memory value\./);
    assert.match(result.additionalContext, /<\/retrieved-memory>$/);
  } finally {
    store.close();
  }
});

test('W3 read core generates one key for new topic, admits it, and retrieves', async () => {
  const setup = setupReadCore();
  const { store, writer, topicEngine, keygen, readCore } = setup;
  try {
    await writer.writeNode({
      key: 'alpha generated key',
      value: 'Alpha generated memory value.'
    });

    const result = await readCore.retrieve({
      text: 'alpha first topic context',
      turnIndex: 3,
      contextPct: 6
    });

    assert.deepEqual(keygen.calls, ['alpha first topic context']);
    assert.equal(result.generatedKey, true);
    assert.equal(result.situationKey, 'alpha generated key');
    assert.equal(topicEngine.slots().length, 1);
    assert.equal(topicEngine.slots()[0].situationKey, 'alpha generated key');
    assert.deepEqual(result.selected.map(node => node.value), ['Alpha generated memory value.']);
    assert.equal(result.log.some(entry => entry.stage === 'rerankFilter'), false);
  } finally {
    store.close();
  }
});

test('W3 read core similarity floor drops weak neighbors to empty block', async () => {
  const setup = setupReadCore({
    read: {
      similarityFloor: 0.9,
      topK: 1
    }
  }, 'alpha generated key');
  const { store, writer, readCore } = setup;
  try {
    await writer.writeNode({
      key: 'beta generated key',
      value: 'Beta memory value.'
    });

    const result = await readCore.retrieve({
      text: 'alpha first topic context',
      turnIndex: 1
    });

    assert.equal(result.additionalContext, '');
    assert.deepEqual(result.selected, []);
    assert.equal(result.log.at(-1).injected, false);
    assert.equal(result.log.some(entry => entry.stage === 'rerankFilter'), false);
  } finally {
    store.close();
  }
});

test('W3 read core fail-opens to empty on keygen or search errors', async () => {
  const setup = setupReadCore();
  const { store, readCore, keygen } = setup;
  try {
    keygen.generateKey = async () => {
      keygen.calls.push('called');
      throw new Error('model unavailable');
    };

    const result = await readCore.retrieve({
      text: 'alpha first topic context',
      turnIndex: 1
    });

    assert.equal(result.failOpen, true);
    assert.equal(result.additionalContext, '');
    assert.deepEqual(result.selected, []);
    assert.match(result.log.at(-1).error, /model unavailable/);
  } finally {
    store.close();
  }
});

test('W3 read core lexical final-pick is local only and does not call keygen more than once', async () => {
  const setup = setupReadCore({
    read: {
      topK: 2,
      similarityFloor: 0
    }
  }, 'alpha generated key');
  const { store, writer, keygen, readCore } = setup;
  try {
    await writer.writeNode({
      key: 'alpha generated key',
      value: 'General alpha value.'
    });
    await writer.writeNode({
      key: 'alpha billing key',
      value: 'Alpha billing invoice value.'
    });

    const result = await readCore.retrieve({
      text: 'alpha billing question',
      turnIndex: 1
    });

    assert.equal(keygen.calls.length, 1);
    assert.equal(result.log.some(entry => entry.stage === 'rerankFilter'), false);
    assert.equal(result.log.some(entry => entry.stage === 'lexicalFinalPick'), true);
    assert.equal(result.selected[0].key, 'alpha billing key');
  } finally {
    store.close();
  }
});

function setupReadCore(readConfig = {}, key = 'alpha generated key') {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-read-core-'));
  const store = new ChunkStore(path.join(data, 'index.sqlite'));
  const embedder = new StubEmbedder();
  store.initialize(embedder);
  const writer = new NodeWriter({ store, embedder });
  const topicEngine = new TopicEngine({ embedder });
  const keygen = new StubKeygen(key);
  const config = structuredClone(DEFAULT_CONFIG);
  config.embedder.dimension = 3;
  Object.assign(config, readConfig);
  const readCore = createReadCore({
    topicEngine,
    nodeWriter: writer,
    keygenClient: keygen,
    config
  });
  return {
    store,
    embedder,
    writer,
    topicEngine,
    keygen,
    readCore
  };
}

function vectorFor(text) {
  const lower = String(text).toLowerCase();
  if (lower.includes('billing')) return [0.9, 0.1, 0];
  if (lower.includes('alpha')) return [1, 0, 0];
  if (lower.includes('beta')) return [0, 1, 0];
  if (lower.includes('gamma')) return [0, 0, 1];
  return [0.1, 0.1, 0.1];
}
