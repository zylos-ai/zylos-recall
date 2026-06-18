import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ChunkStore } from '../src/lib/store.js';
import { NodeWriter } from '../src/lib/write-primitives.js';
import {
  CONSOLIDATION_PROMPT,
  EXTRACTION_PROMPT,
  distillSession
} from '../src/lib/write-orchestrator.js';

class StubEmbedder {
  constructor() {
    this.calls = [];
  }

  id() {
    return 'stub@3';
  }

  dimension() {
    return 3;
  }

  async embed(texts, mode) {
    this.calls.push({ texts, mode });
    return texts.map(vectorFor);
  }
}

class StubTopicEngine {
  constructor(segments) {
    this.segments = segments;
    this.calls = [];
  }

  async segment(messages) {
    this.calls.push(messages);
    return this.segments;
  }
}

class ReplayLlmClient {
  constructor({ extract = [], consolidate = [] } = {}) {
    this.extractQueue = [...extract];
    this.consolidateQueue = [...consolidate];
    this.extractCalls = [];
    this.consolidateCalls = [];
    this.modelCalls = 0;
  }

  async extract(segmentText) {
    this.extractCalls.push(segmentText);
    if (!this.extractQueue.length) throw new Error('Unexpected extract call');
    return this.extractQueue.shift();
  }

  async consolidate(item, neighbors) {
    this.consolidateCalls.push({ item, neighbors });
    if (!this.consolidateQueue.length) throw new Error('Unexpected consolidate call');
    return this.consolidateQueue.shift();
  }
}

test('exports W2b prompt constants for runtime reuse', () => {
  assert.match(EXTRACTION_PROMPT, /Conversation slice:\n\{segment\}/);
  assert.match(CONSOLIDATION_PROMPT, /New item .+ \{new_value\}/s);
  assert.match(CONSOLIDATION_PROMPT, /\{neighbors\}/);
});

test('happy path segments a session and creates memory nodes', async () => {
  const { store, writer } = setupWriter();
  try {
    const topicEngine = new StubTopicEngine([[0, 1], [2]]);
    const llmClient = new ReplayLlmClient({
      extract: [
        { memories: [{ key: 'alpha deployment owner', value: 'Felix owns alpha deployment.' }] },
        { memories: [{ key: 'beta launch date', value: 'Beta launch is Friday.' }] }
      ],
      consolidate: [
        { operation: 'CREATE', target_id: null, value: 'Felix owns alpha deployment.', reason: 'new fact' },
        { operation: 'CREATE', target_id: null, value: 'Beta launch is Friday.', reason: 'new fact' }
      ]
    });

    const summary = await distillSession({
      messages: [
        { text: 'Alpha deployment needs Felix.' },
        { text: 'Felix owns the rollout.' },
        { text: 'Beta launches Friday.' }
      ],
      llmClient,
      topicEngine,
      nodeWriter: writer
    });

    assert.deepEqual(summary, { segments: 2, created: 2, updated: 0, noop: 0, skipped: 0 });
    assert.deepEqual(writer.listNodes().map(node => [node.key, node.value]), [
      ['alpha deployment owner', 'Felix owns alpha deployment.'],
      ['beta launch date', 'Beta launch is Friday.']
    ]);
    assert.equal(llmClient.extractCalls[0], 'Alpha deployment needs Felix.\n\nFelix owns the rollout.');
    assert.equal(llmClient.consolidateCalls.length, 2);
    assert.equal(llmClient.modelCalls, 0);
  } finally {
    store.close();
  }
});

test('updates existing neighbor and preserves id/key', async () => {
  const { store, writer } = setupWriter();
  try {
    const existing = await writer.writeNode({
      key: 'alpha status',
      value: 'Alpha is pending.'
    });
    const llmClient = new ReplayLlmClient({
      extract: [{ memories: [{ key: 'alpha status update', value: 'Alpha shipped today.' }] }],
      consolidate: [{
        operation: 'UPDATE',
        target_id: existing.id,
        value: 'Alpha shipped today.',
        reason: 'same subject'
      }]
    });

    const summary = await distillSession({
      messages: ['Alpha shipped today.'],
      llmClient,
      topicEngine: new StubTopicEngine([[0]]),
      nodeWriter: writer
    });

    assert.deepEqual(summary, { segments: 1, created: 0, updated: 1, noop: 0, skipped: 0 });
    assert.equal(writer.getNode(existing.id).key, 'alpha status');
    assert.equal(writer.getNode(existing.id).value, 'Alpha shipped today.');
  } finally {
    store.close();
  }
});

test('noops without changing an existing node', async () => {
  const { store, writer } = setupWriter();
  try {
    const existing = await writer.writeNode({
      key: 'gamma owner',
      value: 'Gamma is owned by Coco.'
    });
    const llmClient = new ReplayLlmClient({
      extract: [{ memories: [{ key: 'gamma owner', value: 'Gamma is owned by Coco.' }] }],
      consolidate: [{ operation: 'NOOP', target_id: null, value: null, reason: 'already represented' }]
    });

    const summary = await distillSession({
      messages: ['Gamma is still owned by Coco.'],
      llmClient,
      topicEngine: new StubTopicEngine([[0]]),
      nodeWriter: writer
    });

    assert.deepEqual(summary, { segments: 1, created: 0, updated: 0, noop: 1, skipped: 0 });
    assert.equal(writer.getNode(existing.id).value, 'Gamma is owned by Coco.');
  } finally {
    store.close();
  }
});

test('exact-key backstop routes CREATE to UPDATE instead of overwriting by create', async () => {
  const { store, writer } = setupWriter();
  try {
    const existing = await writer.writeNode({
      key: 'alpha decision',
      value: 'Alpha uses option A.'
    });
    const llmClient = new ReplayLlmClient({
      extract: [{ memories: [{ key: 'alpha decision', value: 'Alpha now uses option B.' }] }],
      consolidate: [{
        operation: 'CREATE',
        target_id: null,
        value: 'Alpha now uses option B.',
        reason: 'stub tried create'
      }]
    });

    const summary = await distillSession({
      messages: ['Alpha changed from option A to option B.'],
      llmClient,
      topicEngine: new StubTopicEngine([[0]]),
      nodeWriter: writer
    });

    assert.deepEqual(summary, { segments: 1, created: 0, updated: 1, noop: 0, skipped: 0 });
    assert.equal(writer.listNodes().length, 1);
    assert.equal(writer.getNode(existing.id).key, 'alpha decision');
    assert.equal(writer.getNode(existing.id).value, 'Alpha now uses option B.');
    assert.equal(llmClient.consolidateCalls[0].neighbors[0].id, existing.id);
  } finally {
    store.close();
  }
});

test('repairs malformed extraction and consolidation responses without sinking the batch', async () => {
  const { store, writer } = setupWriter();
  try {
    const existing = await writer.writeNode({
      key: 'beta config',
      value: 'Beta timeout is 10s.'
    });
    const llmClient = new ReplayLlmClient({
      extract: [
        'not json',
        {
          memories: [
            { key: 'beta timeout setting', value: 'Beta timeout is 20s.' },
            { key: '', value: 'skip me' }
          ]
        }
      ],
      consolidate: [
        { operation: 'UPDATE', target_id: 'invented', value: 'Beta timeout is 20s.', reason: 'bad id' },
        { operation: 'UPDATE', target_id: existing.id, value: 'Beta timeout is 20s.', reason: 'same config' }
      ]
    });

    const summary = await distillSession({
      messages: ['Beta timeout changed to 20s.'],
      llmClient,
      topicEngine: new StubTopicEngine([[0]]),
      nodeWriter: writer,
      maxRepairs: 2
    });

    assert.deepEqual(summary, { segments: 1, created: 0, updated: 1, noop: 0, skipped: 1 });
    assert.equal(writer.getNode(existing.id).value, 'Beta timeout is 20s.');
    assert.equal(llmClient.extractCalls.length, 2);
    assert.equal(llmClient.consolidateCalls.length, 2);
  } finally {
    store.close();
  }
});

test('persistently bad extraction is skipped while later segments continue', async () => {
  const { store, writer } = setupWriter();
  try {
    const llmClient = new ReplayLlmClient({
      extract: [
        { memories: [{ key: '', value: 'bad' }] },
        { memories: [{ value: 'still bad' }] },
        { memories: [{ key: 'delta fact', value: 'Delta is active.' }] }
      ],
      consolidate: [
        { operation: 'CREATE', target_id: null, value: 'Delta is active.', reason: 'new fact' }
      ]
    });

    const summary = await distillSession({
      messages: ['Bad segment.', 'Delta is active.'],
      llmClient,
      topicEngine: new StubTopicEngine([[0], [1]]),
      nodeWriter: writer,
      maxRepairs: 1
    });

    assert.deepEqual(summary, { segments: 2, created: 1, updated: 0, noop: 0, skipped: 1 });
    assert.deepEqual(writer.listNodes().map(node => node.key), ['delta fact']);
  } finally {
    store.close();
  }
});

test('persistently bad consolidation is skipped without counting as noop', async () => {
  const { store, writer } = setupWriter();
  try {
    const llmClient = new ReplayLlmClient({
      extract: [{ memories: [{ key: 'alpha invalid decision', value: 'Alpha has a fact.' }] }],
      consolidate: [
        { operation: 'UPDATE', target_id: 'missing', value: 'Alpha has a fact.', reason: 'bad target' },
        { operation: 'DELETE', target_id: null, value: null, reason: 'bad op' }
      ]
    });

    const summary = await distillSession({
      messages: ['Alpha has a fact.'],
      llmClient,
      topicEngine: new StubTopicEngine([[0]]),
      nodeWriter: writer,
      maxRepairs: 1
    });

    assert.deepEqual(summary, { segments: 1, created: 0, updated: 0, noop: 0, skipped: 1 });
    assert.deepEqual(writer.listNodes(), []);
    assert.equal(llmClient.consolidateCalls.length, 2);
  } finally {
    store.close();
  }
});

function setupWriter() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-write-orchestrator-'));
  const store = new ChunkStore(path.join(data, 'index.sqlite'));
  const embedder = new StubEmbedder();
  store.initialize(embedder);
  return {
    store,
    writer: new NodeWriter({ store, embedder })
  };
}

function vectorFor(text) {
  const lower = String(text).toLowerCase();
  if (lower.includes('alpha')) return [1, 0, 0];
  if (lower.includes('beta')) return [0, 1, 0];
  if (lower.includes('gamma')) return [0, 0, 1];
  if (lower.includes('delta')) return [0.7, 0.1, 0.1];
  return [0.1, 0.1, 0.1];
}
