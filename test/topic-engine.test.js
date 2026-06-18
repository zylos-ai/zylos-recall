import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TopicEngine,
  cosineSimilarity,
  isSubstantiveTopicText,
  normalizeTopicText,
  normalizeTopicEngineConfig
} from '../src/lib/topic-engine.js';

const VECTORS = Object.freeze({
  alpha: [1, 0, 0],
  alpha2: [0.97, 0.24, 0],
  beta: [0, 1, 0],
  beta2: [0.15, 0.98, 0],
  gamma: [0, 0, 1],
  gamma2: [0.1, 0, 0.99],
  delta: [-1, 0, 0]
});

const TEXT_VECTORS = Object.freeze({
  'alpha planning details': VECTORS.alpha,
  'alpha follow up details': VECTORS.alpha2,
  'beta deployment details': VECTORS.beta,
  'beta follow up details': VECTORS.beta2,
  'gamma billing details': VECTORS.gamma,
  'gamma follow up details': VECTORS.gamma2,
  'delta unrelated details': VECTORS.delta
});

test('route returns new on cold start, reuses same topic, and starts new on topic shift', async () => {
  const embedder = new StubEmbedder(TEXT_VECTORS);
  const engine = new TopicEngine({ embedder, config: testConfig() });

  const cold = await engine.route({ text: 'alpha planning details', turnIndex: 0, contextPct: 1 });
  assert.equal(cold.decision, 'new');
  assert.equal(cold.slotId, null);
  assert.deepEqual(cold.anchorVec, VECTORS.alpha);

  const alphaId = engine.admit({
    situationKey: 'How should alpha planning details be handled?',
    anchorVec: cold.anchorVec,
    turnIndex: 0,
    contextPct: 1
  });

  const same = await engine.route({ text: 'alpha follow up details', turnIndex: 1, contextPct: 2 });
  assert.equal(same.decision, 'reuse');
  assert.equal(same.slotId, alphaId);
  assert.equal(same.situationKey, 'How should alpha planning details be handled?');

  const shifted = await engine.route({ text: 'beta deployment details', turnIndex: 2, contextPct: 3 });
  assert.equal(shifted.decision, 'new');
  assert.equal(shifted.slotId, alphaId);
  assert.equal(shifted.situationKey, null);
});

test('route reuses an earlier topic after a detour, proving the working set is K>1', async () => {
  const engine = new TopicEngine({
    embedder: new StubEmbedder(TEXT_VECTORS),
    config: testConfig({ K: 7 })
  });

  const alpha = await engine.route({ text: 'alpha planning details', turnIndex: 0 });
  const alphaId = engine.admit({
    situationKey: 'alpha key',
    anchorVec: alpha.anchorVec,
    turnIndex: 0
  });

  const beta = await engine.route({ text: 'beta deployment details', turnIndex: 1 });
  const betaId = engine.admit({
    situationKey: 'beta key',
    anchorVec: beta.anchorVec,
    turnIndex: 1
  });

  const returned = await engine.route({ text: 'alpha follow up details', turnIndex: 2 });
  assert.equal(returned.decision, 'reuse');
  assert.equal(returned.slotId, alphaId);
  assert.equal(returned.situationKey, 'alpha key');
  assert.deepEqual(engine.slots().map(slot => slot.id), [alphaId, betaId]);
});

test('admit evicts the least recently used topic at capacity', async () => {
  const engine = new TopicEngine({
    embedder: new StubEmbedder(TEXT_VECTORS),
    config: testConfig({ K: 2 })
  });

  const alphaId = engine.admit({ situationKey: 'alpha key', anchorVec: VECTORS.alpha, turnIndex: 0 });
  const betaId = engine.admit({ situationKey: 'beta key', anchorVec: VECTORS.beta, turnIndex: 1 });

  const alphaReuse = await engine.route({ text: 'alpha follow up details', turnIndex: 2 });
  assert.equal(alphaReuse.decision, 'reuse');
  assert.equal(alphaReuse.slotId, alphaId);

  const gammaId = engine.admit({ situationKey: 'gamma key', anchorVec: VECTORS.gamma, turnIndex: 3 });
  const remaining = engine.slots().map(slot => slot.id);
  assert.deepEqual(remaining, [alphaId, gammaId]);
  assert.equal(remaining.includes(betaId), false);
});

test('short messages inherit the most recently used topic without embedding', async () => {
  const embedder = new StubEmbedder(TEXT_VECTORS);
  const engine = new TopicEngine({ embedder, config: testConfig() });
  const alphaId = engine.admit({ situationKey: 'alpha key', anchorVec: VECTORS.alpha, turnIndex: 0 });
  engine.admit({ situationKey: 'beta key', anchorVec: VECTORS.beta, turnIndex: 1 });
  engine.touch(alphaId, 2);

  const result = await engine.route({ text: 'yes', turnIndex: 3 });
  assert.equal(result.decision, 'inherit');
  assert.equal(result.slotId, alphaId);
  assert.equal(result.situationKey, 'alpha key');
  assert.deepEqual(embedder.calls, []);
});

test('staleness floor forces new despite high similarity', async () => {
  const engine = new TopicEngine({
    embedder: new StubEmbedder(TEXT_VECTORS),
    config: testConfig({ stalenessFloorTurns: 3 })
  });
  const alphaId = engine.admit({
    situationKey: 'alpha key',
    anchorVec: VECTORS.alpha,
    turnIndex: 0,
    contextPct: 5
  });

  const byTurn = await engine.route({ text: 'alpha follow up details', turnIndex: 3, contextPct: 6 });
  assert.equal(byTurn.decision, 'new');
  assert.equal(byTurn.slotId, alphaId);
  assert.equal(byTurn.stale, true);
  assert.deepEqual(engine.slots(), []);

  const freshEngine = new TopicEngine({
    embedder: new StubEmbedder(TEXT_VECTORS),
    config: testConfig({ stalenessFloorTurns: 100, stalenessFloorContextPct: 10 })
  });
  freshEngine.admit({
    situationKey: 'alpha key',
    anchorVec: VECTORS.alpha,
    turnIndex: 0,
    contextPct: 5
  });
  const byContext = await freshEngine.route({ text: 'alpha follow up details', turnIndex: 1, contextPct: 16 });
  assert.equal(byContext.decision, 'new');
  assert.equal(byContext.stale, true);
  assert.deepEqual(freshEngine.slots(), []);
});

test('staleness regeneration does not grow duplicate slots', async () => {
  const engine = new TopicEngine({
    embedder: new StubEmbedder(TEXT_VECTORS),
    config: testConfig({ stalenessFloorTurns: 2 })
  });

  let route = await engine.route({ text: 'alpha planning details', turnIndex: 0 });
  engine.admit({ situationKey: 'alpha key 1', anchorVec: route.anchorVec, turnIndex: 0 });
  assert.equal(engine.slots().length, 1);

  route = await engine.route({ text: 'alpha follow up details', turnIndex: 2 });
  assert.equal(route.decision, 'new');
  assert.equal(route.stale, true);
  assert.equal(engine.slots().length, 0);

  engine.admit({ situationKey: 'alpha key 2', anchorVec: route.anchorVec, turnIndex: 2 });
  assert.equal(engine.slots().length, 1);
  assert.equal(engine.slots()[0].situationKey, 'alpha key 2');

  route = await engine.route({ text: 'alpha follow up details', turnIndex: 4 });
  assert.equal(route.decision, 'new');
  assert.equal(route.stale, true);
  engine.admit({ situationKey: 'alpha key 3', anchorVec: route.anchorVec, turnIndex: 4 });
  assert.equal(engine.slots().length, 1);
  assert.equal(engine.slots()[0].situationKey, 'alpha key 3');
});

test('segment builds deterministic topic boundaries and attaches short messages', async () => {
  const engine = new TopicEngine({
    embedder: new StubEmbedder(TEXT_VECTORS),
    config: testConfig({ segmentThreshold: 0.76 })
  });

  const messages = [
    { text: 'alpha planning details' },
    { text: 'alpha follow up details' },
    { text: 'ok' },
    { text: 'beta deployment details' },
    { text: 'beta follow up details' },
    { text: 'alpha planning details' }
  ];

  const groups = await engine.segment(messages);
  assert.deepEqual(groups, [[0, 1, 2], [3, 4], [5]]);
});

test('route decisions are deterministic with fixed embeddings', async () => {
  async function decisions() {
    const engine = new TopicEngine({
      embedder: new StubEmbedder(TEXT_VECTORS),
      config: testConfig()
    });
    const first = await engine.route({ text: 'alpha planning details', turnIndex: 0 });
    engine.admit({ situationKey: 'alpha key', anchorVec: first.anchorVec, turnIndex: 0 });
    const second = await engine.route({ text: 'alpha follow up details', turnIndex: 1 });
    const third = await engine.route({ text: 'gamma billing details', turnIndex: 2 });
    return [first.decision, second.decision, third.decision];
  }

  assert.deepEqual(await decisions(), await decisions());
});

test('topic utility validation covers vectors and substantive checks', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([0, 0], [1, 0]), 0);
  assert.equal(isSubstantiveTopicText('Heartbeat check', testConfig()), false);
  assert.equal(isSubstantiveTopicText('yes', testConfig()), false);
  assert.equal(isSubstantiveTopicText(
    '[DISCORD DM] felix said: <current-message>yes</current-message> ---- reply via: node x',
    testConfig()
  ), false);
  assert.equal(isSubstantiveTopicText('please continue the recall implementation', testConfig()), true);
  assert.equal(normalizeTopicText('[HXA:coco DM] bot said: actual request ---- reply via: node x'), 'actual request');
  assert.throws(() => normalizeTopicEngineConfig({ K: 0 }), /topicEngine\.K/);
  assert.throws(() => cosineSimilarity([1, 0], [1]), /Vector dimension mismatch/);
});

function testConfig(overrides = {}) {
  return {
    K: 7,
    sameTopicThreshold: 0.8,
    segmentThreshold: 0.7,
    stalenessFloorTurns: 20,
    stalenessFloorContextPct: 25,
    topicTtlTurns: 100,
    minSubstantiveChars: 12,
    minSubstantiveTokens: 3,
    ...overrides
  };
}

class StubEmbedder {
  constructor(vectors) {
    this.vectors = vectors;
    this.calls = [];
  }

  async embed(texts, mode) {
    this.calls.push({ texts: [...texts], mode });
    return texts.map(text => {
      const vector = this.vectors[text];
      if (!vector) throw new Error(`Missing stub vector for: ${text}`);
      return [...vector];
    });
  }
}
