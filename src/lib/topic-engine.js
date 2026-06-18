import { estimateTokens } from './tokens.js';

export const DEFAULT_TOPIC_ENGINE_CONFIG = Object.freeze({
  K: 7,
  sameTopicThreshold: 0.82,
  segmentThreshold: 0.72,
  stalenessFloorTurns: 40,
  stalenessFloorContextPct: 25,
  topicTtlTurns: 120,
  minSubstantiveChars: 12,
  minSubstantiveTokens: 3
});

export class TopicEngine {
  constructor({ embedder, config = {} } = {}) {
    if (!embedder || typeof embedder.embed !== 'function') {
      throw new Error('TopicEngine requires an embedder with embed(texts, mode)');
    }
    this.embedder = embedder;
    this.config = normalizeTopicEngineConfig(config);
    this.activeTopics = [];
    this.nextSlotNumber = 1;
  }

  /**
   * Routes one read-time message.
   *
   * For `decision: 'new'`, `slotId` is null on cold start, the nearest slot id
   * on below-threshold drift, and the stale slot id after that slot was evicted
   * on staleness-forced regeneration.
   */
  async route({ text, turnIndex, contextPct = null } = {}) {
    const normalizedText = normalizeText(text);
    const normalizedTurn = normalizeTurnIndex(turnIndex);

    if (!isSubstantiveTopicText(normalizedText, this.config)) {
      const slot = this.mostRecentlyUsedSlot();
      return {
        decision: 'inherit',
        slotId: slot?.id ?? null,
        situationKey: slot?.situationKey ?? null
      };
    }

    const anchorVec = await this.embedOne(normalizedText);
    const best = this.bestSlot(anchorVec);
    if (!best) {
      return {
        decision: 'new',
        slotId: null,
        situationKey: null,
        anchorVec,
        score: null
      };
    }

    if (
      best.score >= this.config.sameTopicThreshold &&
      isStale(best.slot, normalizedTurn, contextPct, this.config)
    ) {
      const staleSlotId = best.slot.id;
      this.evictSlot(staleSlotId);
      return {
        decision: 'new',
        slotId: staleSlotId,
        situationKey: null,
        anchorVec,
        score: best.score,
        stale: true
      };
    }

    if (best.score >= this.config.sameTopicThreshold) {
      this.touch(best.slot.id, normalizedTurn);
      return {
        decision: 'reuse',
        slotId: best.slot.id,
        situationKey: best.slot.situationKey,
        score: best.score
      };
    }

    return {
      decision: 'new',
      slotId: best.slot.id,
      situationKey: null,
      anchorVec,
      score: best.score
    };
  }

  admit({ situationKey, anchorVec, turnIndex, contextPct = null } = {}) {
    const key = String(situationKey || '').trim();
    if (!key) throw new Error('admit requires a non-empty situationKey');
    const vector = normalizeVector(anchorVec);
    const normalizedTurn = normalizeTurnIndex(turnIndex);

    if (this.activeTopics.length >= this.config.K) {
      this.evictOne(normalizedTurn);
    }

    const slot = {
      id: `topic-${this.nextSlotNumber}`,
      anchorVec: vector,
      situationKey: key,
      mintedTurn: normalizedTurn,
      mintedContextPct: normalizeOptionalPercent(contextPct),
      lastUsedTurn: normalizedTurn
    };
    this.nextSlotNumber += 1;
    this.activeTopics.push(slot);
    return slot.id;
  }

  touch(slotId, turnIndex) {
    const slot = this.activeTopics.find(candidate => candidate.id === slotId);
    if (!slot) return false;
    slot.lastUsedTurn = normalizeTurnIndex(turnIndex);
    return true;
  }

  async segment(messages = []) {
    if (!Array.isArray(messages) || messages.length === 0) return [];

    const groups = [];
    let current = [];
    let currentAnchor = null;

    for (let index = 0; index < messages.length; index += 1) {
      const text = messageText(messages[index]);
      if (!current.length) current.push(index);

      if (!isSubstantiveTopicText(text, this.config)) {
        if (!current.includes(index)) current.push(index);
        continue;
      }

      const vector = await this.embedOne(text);
      if (!currentAnchor) {
        currentAnchor = vector;
        if (!current.includes(index)) current.push(index);
        continue;
      }

      const score = cosineSimilarity(vector, currentAnchor);
      if (score < this.config.segmentThreshold) {
        groups.push(current);
        current = [index];
        currentAnchor = vector;
      } else if (!current.includes(index)) {
        current.push(index);
      }
    }

    if (current.length) groups.push(current);
    return groups;
  }

  slots() {
    return this.activeTopics.map(slot => ({
      ...slot,
      anchorVec: [...slot.anchorVec]
    }));
  }

  mostRecentlyUsedSlot() {
    if (!this.activeTopics.length) return null;
    return [...this.activeTopics].sort((a, b) =>
      b.lastUsedTurn - a.lastUsedTurn ||
      b.mintedTurn - a.mintedTurn ||
      slotNumber(b.id) - slotNumber(a.id)
    )[0];
  }

  bestSlot(vector) {
    let best = null;
    for (const slot of this.activeTopics) {
      const score = cosineSimilarity(vector, slot.anchorVec);
      if (!best || score > best.score) best = { slot, score };
    }
    return best;
  }

  evictOne(turnIndex) {
    const ttl = this.config.topicTtlTurns;
    const expired = Number.isFinite(ttl)
      ? this.activeTopics.filter(slot => turnIndex - slot.lastUsedTurn > ttl)
      : [];
    const candidates = expired.length ? expired : this.activeTopics;
    const evict = [...candidates].sort((a, b) =>
      a.lastUsedTurn - b.lastUsedTurn ||
      a.mintedTurn - b.mintedTurn ||
      slotNumber(a.id) - slotNumber(b.id)
    )[0];
    this.activeTopics = this.activeTopics.filter(slot => slot.id !== evict.id);
  }

  evictSlot(slotId) {
    const before = this.activeTopics.length;
    this.activeTopics = this.activeTopics.filter(slot => slot.id !== slotId);
    return this.activeTopics.length !== before;
  }

  async embedOne(text) {
    const vectors = await this.embedder.embed([text], 'query');
    if (!Array.isArray(vectors) || vectors.length !== 1) {
      throw new Error('Embedder returned an invalid topic vector batch');
    }
    return normalizeVector(vectors[0]);
  }
}

export function normalizeTopicEngineConfig(config = {}) {
  const normalized = {
    ...DEFAULT_TOPIC_ENGINE_CONFIG,
    ...config
  };
  if (!Number.isInteger(normalized.K) || normalized.K <= 0) {
    throw new Error('topicEngine.K must be a positive integer');
  }
  for (const key of [
    'sameTopicThreshold',
    'segmentThreshold',
    'stalenessFloorContextPct'
  ]) {
    const max = key === 'stalenessFloorContextPct' ? 100 : 1;
    if (
      typeof normalized[key] !== 'number' ||
      !Number.isFinite(normalized[key]) ||
      normalized[key] < 0 ||
      normalized[key] > max
    ) {
      const range = key === 'stalenessFloorContextPct' ? '0..100' : '0..1';
      throw new Error(`topicEngine.${key} must be a finite ${range} number`);
    }
  }
  for (const key of ['stalenessFloorTurns', 'topicTtlTurns', 'minSubstantiveChars', 'minSubstantiveTokens']) {
    if (!Number.isInteger(normalized[key]) || normalized[key] < 0) {
      throw new Error(`topicEngine.${key} must be a non-negative integer`);
    }
  }
  return normalized;
}

export function isSubstantiveTopicText(text, config = DEFAULT_TOPIC_ENGINE_CONFIG) {
  const trimmed = normalizeTopicText(text);
  if (!trimmed) return false;
  if (/heartbeat check/i.test(trimmed)) return false;
  if (/^\s*(meanwhile,\s*)?context usage at/i.test(trimmed)) return false;
  if (/^\s*\[?scheduled task/i.test(trimmed)) return false;
  if (trimmed.length < config.minSubstantiveChars && estimateTokens(trimmed) < config.minSubstantiveTokens) {
    return false;
  }
  return true;
}

// W4 owns the canonical topic/read envelope normalization for W3. The legacy
// retrieve-hook skip rule is expected to be removed with the v0.1 chunk policy.
export function normalizeTopicText(input) {
  let text = String(input || '').trim();
  const currentMessage = text.match(/<current-message>\s*([\s\S]*?)\s*<\/current-message>/i);
  if (currentMessage) return currentMessage[1].trim();

  text = text.replace(/\s*----\s*reply via:\s*node\s+[\s\S]*$/i, '').trim();
  text = text.replace(/<replying-to>[\s\S]*?<\/replying-to>/gi, '').trim();
  text = text.replace(/^\s*\[[^\]]+\]\s+[\s\S]*?\bsaid:\s*/i, '').trim();
  return text;
}

export function cosineSimilarity(a, b) {
  const left = normalizeVector(a);
  const right = normalizeVector(b);
  if (left.length !== right.length) {
    throw new Error(`Vector dimension mismatch: ${left.length} !== ${right.length}`);
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function isStale(slot, turnIndex, contextPct, config) {
  if (config.stalenessFloorTurns > 0 && turnIndex - slot.mintedTurn >= config.stalenessFloorTurns) {
    return true;
  }
  const currentContextPct = normalizeOptionalPercent(contextPct);
  if (
    currentContextPct !== null &&
    slot.mintedContextPct !== null &&
    config.stalenessFloorContextPct > 0 &&
    Math.abs(currentContextPct - slot.mintedContextPct) >= config.stalenessFloorContextPct
  ) {
    return true;
  }
  return false;
}

function normalizeVector(vector) {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('Expected a non-empty numeric vector');
  }
  return vector.map(value => {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error('Expected a finite numeric vector');
    return number;
  });
}

function normalizeTurnIndex(turnIndex) {
  if (!Number.isInteger(turnIndex) || turnIndex < 0) {
    throw new Error('turnIndex must be a non-negative integer');
  }
  return turnIndex;
}

function normalizeOptionalPercent(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(100, Math.max(0, number));
}

function normalizeText(text) {
  return normalizeTopicText(text);
}

function messageText(message) {
  if (typeof message === 'string') return normalizeText(message);
  if (message && typeof message === 'object') {
    return normalizeText(message.text ?? message.content ?? message.message ?? '');
  }
  return '';
}

function slotNumber(slotId) {
  const match = String(slotId || '').match(/(\d+)$/);
  return match ? Number(match[1]) : 0;
}
