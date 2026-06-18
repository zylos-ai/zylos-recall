import { estimateTokens } from './chunker.js';
import { assemble } from './retriever.js';

export const DEFAULT_READ_CORE_CONFIG = Object.freeze({
  kind: 'memory',
  topK: 5,
  similarityFloor: 0.35,
  lexicalFinalPick: true
});

export class ReadCore {
  constructor({ topicEngine, nodeWriter, keygenClient, config = {} } = {}) {
    if (!topicEngine || typeof topicEngine.route !== 'function' || typeof topicEngine.admit !== 'function') {
      throw new Error('ReadCore requires a topicEngine with route() and admit()');
    }
    if (!nodeWriter || typeof nodeWriter.searchNeighbors !== 'function') {
      throw new Error('ReadCore requires a nodeWriter with searchNeighbors()');
    }
    if (!keygenClient || typeof keygenClient.generateKey !== 'function') {
      throw new Error('ReadCore requires a keygenClient with generateKey(contextText)');
    }
    this.topicEngine = topicEngine;
    this.nodeWriter = nodeWriter;
    this.keygenClient = keygenClient;
    this.config = normalizeReadCoreConfig(config);
  }

  async retrieve({ text, turnIndex, contextPct = null } = {}) {
    const contextText = String(text || '').trim();
    if (!contextText) return emptyResult({ query: contextText });

    const log = [];
    try {
      const route = await this.topicEngine.route({ text: contextText, turnIndex, contextPct });
      log.push({
        stage: 'route',
        decision: route.decision,
        slotId: route.slotId ?? null,
        hasSituationKey: Boolean(route.situationKey)
      });

      const { situationKey, generated } = await this.resolveSituationKey(route, {
        contextText,
        turnIndex,
        contextPct
      });
      log.push({
        stage: 'keygen',
        generated,
        hasSituationKey: Boolean(situationKey)
      });

      if (!situationKey) return emptyResult({ query: contextText, log });

      const neighbors = await this.nodeWriter.searchNeighbors({
        key: situationKey,
        k: this.config.topK,
        kind: this.config.kind
      });
      log.push({
        stage: 'nodeSearch',
        count: neighbors.length,
        candidates: neighbors.map(nodeSnapshot)
      });

      const floored = neighbors.filter(node => Number(node.score) >= this.config.similarityFloor);
      log.push({
        stage: 'similarityFloor',
        threshold: this.config.similarityFloor,
        kept: floored.length,
        dropped: neighbors.length - floored.length
      });

      const picked = lexicalFinalPick(floored, contextText, {
        enabled: this.config.lexicalFinalPick
      });
      log.push({
        stage: 'lexicalFinalPick',
        enabled: this.config.lexicalFinalPick,
        count: picked.length,
        candidates: picked.map(nodeSnapshot)
      });

      const selected = picked.map(nodeToCandidate);
      const ctx = {
        selected,
        config: {
          retrieval: {
            chunkTokens: this.config.chunkTokens
          }
        },
        additionalContext: '',
        log
      };
      assemble(ctx);

      return {
        query: contextText,
        situationKey,
        generatedKey: generated,
        candidates: neighbors,
        selected: picked,
        additionalContext: ctx.additionalContext,
        log: ctx.log
      };
    } catch (err) {
      log.push({ stage: 'failOpen', error: err.message });
      return emptyResult({ query: contextText, log, failOpen: true });
    }
  }

  async resolveSituationKey(route, { contextText, turnIndex, contextPct }) {
    if (route.decision === 'reuse' || route.decision === 'inherit') {
      return { situationKey: route.situationKey || '', generated: false };
    }

    const generatedKey = String(await this.keygenClient.generateKey(contextText) || '').trim();
    if (!generatedKey) return { situationKey: '', generated: true };
    this.topicEngine.admit({
      situationKey: generatedKey,
      anchorVec: route.anchorVec,
      turnIndex,
      contextPct
    });
    return { situationKey: generatedKey, generated: true };
  }
}

export function createReadCore(options) {
  return new ReadCore(options);
}

export async function retrieveReadCore(options, request) {
  return new ReadCore(options).retrieve(request);
}

export function normalizeReadCoreConfig(config = {}) {
  const retrieval = config.retrieval || {};
  const read = config.read || {};
  const normalized = {
    ...DEFAULT_READ_CORE_CONFIG,
    topK: read.topK ?? retrieval.topK ?? DEFAULT_READ_CORE_CONFIG.topK,
    similarityFloor: read.similarityFloor ?? retrieval.threshold ?? DEFAULT_READ_CORE_CONFIG.similarityFloor,
    chunkTokens: read.chunkTokens ?? retrieval.chunkTokens ?? 350,
    lexicalFinalPick: read.lexicalFinalPick ?? DEFAULT_READ_CORE_CONFIG.lexicalFinalPick,
    kind: read.kind ?? DEFAULT_READ_CORE_CONFIG.kind
  };

  if (!Number.isInteger(Number(normalized.topK)) || Number(normalized.topK) <= 0) {
    throw new Error('read.topK must be a positive integer');
  }
  normalized.topK = Number(normalized.topK);

  if (
    typeof normalized.similarityFloor !== 'number' ||
    !Number.isFinite(normalized.similarityFloor) ||
    normalized.similarityFloor < 0 ||
    normalized.similarityFloor > 1
  ) {
    throw new Error('read.similarityFloor must be a finite 0..1 number');
  }

  if (!Number.isInteger(Number(normalized.chunkTokens)) || Number(normalized.chunkTokens) <= 0) {
    throw new Error('read.chunkTokens must be a positive integer');
  }
  normalized.chunkTokens = Number(normalized.chunkTokens);
  normalized.kind = String(normalized.kind || DEFAULT_READ_CORE_CONFIG.kind).trim();
  normalized.lexicalFinalPick = Boolean(normalized.lexicalFinalPick);
  return normalized;
}

export function lexicalFinalPick(candidates, contextText, { enabled = true } = {}) {
  if (!enabled || candidates.length <= 1) return candidates;
  const queryTerms = contentTerms(contextText);
  if (queryTerms.size === 0) return candidates;

  const scored = candidates.map((candidate, index) => ({
    candidate,
    index,
    overlap: lexicalOverlap(queryTerms, `${candidate.key || ''} ${candidate.value || ''}`)
  }));
  if (!scored.some(item => item.overlap > 0)) return candidates;

  return scored
    .sort((a, b) =>
      b.overlap - a.overlap ||
      Number(b.candidate.score || 0) - Number(a.candidate.score || 0) ||
      a.index - b.index
    )
    .map(item => item.candidate);
}

function nodeToCandidate(node) {
  const timestamp = Number(node.updatedAt || node.createdAt || Date.now());
  const date = new Date(timestamp).toISOString().slice(0, 10);
  return {
    id: node.id,
    source: `recall:nodes/${node.kind || 'memory'}/${node.key}`,
    section: node.kind || 'memory',
    text: node.value || '',
    mtime: timestamp,
    tokenCount: estimateTokens(node.value || ''),
    score: node.score,
    metadata: {
      type: 'memory-node',
      date,
      key: node.key,
      kind: node.kind || 'memory'
    }
  };
}

function nodeSnapshot(node) {
  return {
    id: node.id,
    key: node.key,
    score: roundScore(node.score)
  };
}

function emptyResult({ query = '', log = [], failOpen = false } = {}) {
  return {
    query,
    situationKey: '',
    generatedKey: false,
    candidates: [],
    selected: [],
    additionalContext: '',
    log,
    failOpen
  };
}

function contentTerms(text) {
  const stop = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'you', 'your', 'are', 'was', 'were', 'what', 'when', 'where', 'why', 'how']);
  const terms = new Set();
  for (const term of String(text || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []) {
    if (!stop.has(term)) terms.add(term);
  }
  return terms;
}

function lexicalOverlap(queryTerms, text) {
  const terms = contentTerms(text);
  let count = 0;
  for (const term of queryTerms) {
    if (terms.has(term)) count += 1;
  }
  return count;
}

function roundScore(value) {
  return Number.isFinite(value) ? Math.round(value * 10000) / 10000 : null;
}
