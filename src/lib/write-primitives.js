import { shortHash } from './hash.js';
import { TOPIC_EMBED_MODE } from './topic-engine.js';

export const NODE_EMBED_MODE = TOPIC_EMBED_MODE;

export class NodeWriter {
  constructor({ store, embedder } = {}) {
    if (!store) throw new Error('NodeWriter requires a store');
    if (!embedder || typeof embedder.embed !== 'function') {
      throw new Error('NodeWriter requires an embedder with embed(texts, mode)');
    }
    this.store = store;
    this.embedder = embedder;
  }

  async writeNode({ key, value, kind = 'memory' } = {}) {
    const normalized = normalizeNodeInput({ key, value, kind });
    const [vector] = await this.embedder.embed([normalized.key], NODE_EMBED_MODE);
    assertVector(vector);
    const id = nodeId(normalized.kind, normalized.key);
    this.store.upsertMemoryNode({
      id,
      key: normalized.key,
      value: normalized.value,
      kind: normalized.kind,
      embedderId: this.embedder.id(),
      vector,
      hash: nodeHash(normalized.kind, normalized.key, normalized.value)
    });
    return { id };
  }

  async searchNeighbors({ key, k = 5, kind = 'memory' } = {}) {
    const normalizedKey = normalizeString(key, 'key');
    const normalizedKind = normalizeString(kind, 'kind');
    const topK = normalizeTopK(k);
    const [vector] = await this.embedder.embed([normalizedKey], NODE_EMBED_MODE);
    assertVector(vector);
    return this.store.searchMemoryNodes(vector, {
      kind: normalizedKind,
      topK
    }).map(node => ({
      id: node.id,
      key: node.key,
      value: node.value,
      score: node.score
    }));
  }

  async applyConsolidation(decision = {}) {
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
      throw new Error('decision must be an object');
    }
    const operation = String(decision.operation || '').trim().toUpperCase();
    if (operation === 'CREATE') {
      const result = await this.writeNode({
        key: decision.key,
        value: decision.value,
        kind: decision.kind ?? 'memory'
      });
      return { id: result.id, op: 'CREATE' };
    }
    if (operation === 'UPDATE') {
      const targetId = normalizeString(decision.target_id, 'target_id');
      const value = normalizeString(decision.value, 'value');
      const updated = this.store.updateMemoryNodeValue(targetId, value);
      if (!updated) throw new Error(`Cannot update missing memory node: ${targetId}`);
      return { id: targetId, op: 'UPDATE' };
    }
    if (operation === 'NOOP') {
      return { id: null, op: 'NOOP' };
    }
    throw new Error(`Unsupported consolidation operation: ${operation || 'missing'}`);
  }

  getNode(id) {
    return this.store.getMemoryNode(normalizeString(id, 'id'));
  }

  listNodes(options = {}) {
    return this.store.listMemoryNodes(options);
  }
}

export function createNodeWriter(options) {
  return new NodeWriter(options);
}

export function nodeId(kind, key) {
  return `memory-node:${shortHash(`${kind}\0${key}`, 20)}`;
}

function nodeHash(kind, key, value) {
  return shortHash(`${kind}\0${key}\0${value}`, 64);
}

function normalizeNodeInput({ key, value, kind }) {
  return {
    key: normalizeString(key, 'key'),
    value: normalizeString(value, 'value'),
    kind: normalizeString(kind, 'kind')
  };
}

function normalizeString(value, name) {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must be non-empty`);
  return normalized;
}

function normalizeTopK(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error('k must be a positive integer');
  }
  return number;
}

function assertVector(vector) {
  if (!Array.isArray(vector) || vector.length === 0 || vector.some(value => !Number.isFinite(Number(value)))) {
    throw new Error('Embedder returned an invalid node vector');
  }
}
