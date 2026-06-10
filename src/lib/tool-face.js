import { createEmbedder } from './embedders/index.js';
import { retrieveMemory } from './retriever.js';
import { ChunkStore } from './store.js';

export const TOOL_RETRIEVAL_DEFAULTS = Object.freeze({
  topK: 10,
  bm25TopK: 15,
  maxTotalTokens: 3000
});

const RETRIEVAL_LIMITS = Object.freeze({
  topK: { min: 1, max: 25 },
  bm25TopK: { min: 1, max: 25 },
  maxTotalTokens: { min: 1, max: 6000 }
});

export function normalizeRetrievalOverrides(input = {}, { defaults = {} } = {}) {
  const normalized = {};
  for (const key of Object.keys(RETRIEVAL_LIMITS)) {
    let value = Number(input[key]);
    if (!Number.isFinite(value)) value = Number(defaults[key]);
    if (!Number.isFinite(value)) continue;
    const integer = Math.floor(value);
    const limits = RETRIEVAL_LIMITS[key];
    normalized[key] = Math.min(limits.max, Math.max(limits.min, integer));
  }
  return normalized;
}

export function configWithRetrievalOverrides(config, overrides = {}) {
  const normalized = normalizeRetrievalOverrides(overrides);
  if (!Object.keys(normalized).length) return config;
  const next = structuredClone(config);
  next.retrieval = { ...next.retrieval, ...normalized };
  return next;
}

export async function runRecallTool(config, query, options = {}) {
  const overrides = normalizeRetrievalOverrides(options.overrides, { defaults: TOOL_RETRIEVAL_DEFAULTS });
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const stderr = options.stderr || process.stderr;
  const timeoutSignal = options.timeoutSignal || (ms => AbortSignal.timeout(ms));
  const directRetrieve = options.directRetrieve || retrieveDirectly;

  try {
    const response = await fetchImpl(`http://${config.service.host}:${config.service.port}/retrieve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, ...overrides }),
      signal: timeoutSignal(config.service.timeoutMs)
    });
    if (!response.ok) throw new Error(`service returned HTTP ${response.status}`);
    const payload = await response.json();
    return Array.isArray(payload?.selected) ? payload.selected : [];
  } catch {
    stderr.write('[recall] service unavailable; loading local index directly (slow path)\n');
    const result = await directRetrieve(configWithRetrievalOverrides(config, overrides), query);
    return result.selected || [];
  }
}

async function retrieveDirectly(config, query) {
  const embedder = createEmbedder(config.embedder);
  const store = new ChunkStore(config.indexPath);
  try {
    store.initialize(embedder);
    return await retrieveMemory(config, query, { embedder, store, storeInitialized: true });
  } finally {
    store.close();
  }
}

export function candidatePayload(candidate) {
  return {
    id: candidate.id,
    text: candidate.text,
    source: candidate.source,
    section: candidate.section,
    mtime: candidate.mtime,
    tokenCount: candidate.tokenCount,
    metadata: candidate.metadata,
    score: candidate.score,
    bm25Score: candidate.bm25Score,
    fusedScore: candidate.fusedScore,
    normalizedFused: candidate.normalizedFused,
    rerankScore: candidate.rerankScore,
    finalScore: candidate.finalScore
  };
}

export function runTocTool(config, options = {}) {
  const store = options.store || new ChunkStore(config.indexPath);
  const closeStore = !options.store;
  try {
    return buildToc(store.listTocRows(), { tier: options.tier });
  } finally {
    if (closeStore) store.close();
  }
}

export function recallItems(candidates = []) {
  return candidates.map(candidate => ({
    source: candidate.source,
    section: candidate.section,
    date: candidate.metadata?.date || new Date(candidate.mtime).toISOString().slice(0, 10),
    scores: {
      cosine: roundScore(candidate.score),
      bm25: roundScore(candidate.bm25Score),
      fused: roundScore(candidate.normalizedFused ?? candidate.fusedScore)
    },
    text: candidate.text
  }));
}

export function formatRecallText(candidates = []) {
  const blocks = recallItems(candidates).map(item => {
    const scores = Object.entries(item.scores)
      .filter(([, value]) => value !== null)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    const header = `${item.source} · ${item.date}${scores ? ` · ${scores}` : ''}`;
    return `${header}\n${item.text}`;
  });
  return blocks.join('\n\n');
}

export function buildToc(rows = [], { tier = null } = {}) {
  const tiers = new Map();
  for (const row of rows) {
    if (tier && row.type !== tier) continue;
    if (!tiers.has(row.type)) tiers.set(row.type, new Map());
    const files = tiers.get(row.type);
    if (!files.has(row.source)) {
      files.set(row.source, {
        source: row.source,
        date: row.date,
        chunks: 0,
        sections: []
      });
    }
    const file = files.get(row.source);
    file.chunks += 1;
    if (row.date > file.date) file.date = row.date;
    if (row.section && !file.sections.includes(row.section)) file.sections.push(row.section);
  }

  return [...tiers.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, files]) => ({
      type,
      files: [...files.values()].sort((a, b) => a.source.localeCompare(b.source))
    }));
}

export function formatTocText(toc = [], { full = false } = {}) {
  const lines = [];
  for (const tier of toc) {
    lines.push(`${tier.type}`);
    for (const file of tier.files) {
      lines.push(`- ${file.source} · ${file.date} · ${file.chunks} chunks`);
      if (full) {
        for (const section of file.sections) lines.push(`  - ${section}`);
      }
    }
  }
  return lines.join('\n');
}

function roundScore(value) {
  return typeof value === 'number' ? Number(value.toFixed(6)) : null;
}
