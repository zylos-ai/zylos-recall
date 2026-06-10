import { estimateTokens } from './chunker.js';
import { createEmbedder } from './embedders/index.js';
import { ChunkStore } from './store.js';
import fs from 'node:fs';
import path from 'node:path';

export const STAGES = Object.freeze({
  denseRetrieve,
  bm25Retrieve,
  rrfFuse,
  rerankFilter,
  freeGates,
  assemble
});

export async function retrieveMemory(config, query, options = {}) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return { query: trimmed, candidates: [], selected: [], additionalContext: '' };

  const embedder = options.embedder || createEmbedder(config.embedder);
  const store = options.store || new ChunkStore(config.indexPath);
  const closeStore = !options.store;
  const ctx = {
    query: trimmed,
    config,
    embedder,
    reranker: options.reranker || null,
    store,
    candidates: [],
    retrieverLists: {},
    selected: [],
    additionalContext: '',
    log: []
  };

  try {
    if (!options.storeInitialized) store.initialize(embedder);
    for (const stageName of config.retrieval.pipeline) {
      const stage = STAGES[stageName];
      if (!stage) throw new Error(`Unknown retrieval stage: ${stageName}`);
      await stage(ctx);
    }
    return {
      query: ctx.query,
      candidates: ctx.candidates,
      selected: ctx.selected,
      additionalContext: ctx.additionalContext,
      log: ctx.log
    };
  } finally {
    if (closeStore) store.close();
  }
}

export async function denseRetrieve(ctx) {
  const [vector] = await ctx.embedder.embed([ctx.query], 'query');
  ctx.candidates = ctx.store.search(vector, { topK: ctx.config.retrieval.topK });
  ctx.retrieverLists.dense = ctx.candidates;
  ctx.log.push({
    stage: 'denseRetrieve',
    count: ctx.candidates.length,
    candidates: ctx.candidates.map(candidateSnapshot)
  });
}

export function bm25Retrieve(ctx) {
  const topK = ctx.config.retrieval.bm25TopK ?? 10;
  let candidates = [];
  let failOpenReason = null;
  try {
    candidates = typeof ctx.store.searchText === 'function'
      ? ctx.store.searchText(ctx.query, { topK })
      : [];
    if (!Array.isArray(candidates)) candidates = [];
  } catch (err) {
    failOpenReason = err.message;
  }
  ctx.retrieverLists.bm25 = candidates;
  const logEntry = {
    stage: 'bm25Retrieve',
    count: candidates.length,
    candidates: candidates.map(candidate => ({
      id: candidate.id,
      source: candidate.source,
      bm25Score: roundScore(candidate.bm25Score)
    }))
  };
  if (failOpenReason) {
    logEntry.failOpen = true;
    logEntry.reason = failOpenReason;
  }
  ctx.log.push(logEntry);
}

export function rrfFuse(ctx) {
  const lists = Object.entries(ctx.retrieverLists || {})
    .filter(([, candidates]) => Array.isArray(candidates) && candidates.length > 0);
  if (!lists.length) {
    ctx.candidates = [];
    ctx.log.push({ stage: 'rrfFuse', count: 0, candidates: [] });
    return;
  }

  const k = ctx.config.retrieval.rrfK ?? 60;
  const byId = new Map();
  for (const [name, candidates] of lists) {
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const rank = index + 1;
      const existing = byId.get(candidate.id) || {
        ...candidate,
        score: undefined,
        bm25Score: undefined,
        fusedScore: 0
      };
      existing.fusedScore += 1 / (k + rank);
      if (name === 'dense') {
        existing.score = candidate.score;
        existing.denseRank = rank;
      } else if (name === 'bm25') {
        existing.bm25Score = candidate.bm25Score;
        existing.bm25Rank = rank;
      }
      byId.set(candidate.id, {
        ...existing,
        ...candidate,
        score: existing.score,
        bm25Score: existing.bm25Score,
        denseRank: existing.denseRank,
        bm25Rank: existing.bm25Rank,
        fusedScore: existing.fusedScore
      });
    }
  }

  const maxPossible = lists.length / (k + 1);
  ctx.candidates = Array.from(byId.values()).map(candidate => ({
    ...candidate,
    normalizedFused: maxPossible > 0 ? candidate.fusedScore / maxPossible : 0
  })).sort((a, b) =>
    b.normalizedFused - a.normalizedFused ||
    (b.score ?? -Infinity) - (a.score ?? -Infinity) ||
    (b.bm25Score ?? -Infinity) - (a.bm25Score ?? -Infinity) ||
    b.mtime - a.mtime
  );

  ctx.log.push({
    stage: 'rrfFuse',
    count: ctx.candidates.length,
    candidates: ctx.candidates.map(candidate => ({
      id: candidate.id,
      denseRank: candidate.denseRank ?? null,
      bm25Rank: candidate.bm25Rank ?? null,
      fusedScore: roundScore(candidate.fusedScore)
    }))
  });
}

export async function rerankFilter(ctx) {
  const started = Date.now();
  const filter = ctx.config.filter || { provider: 'none' };
  if (filter.provider !== 'rerank') {
    ctx.log.push({ stage: 'rerankFilter', enabled: false, count: ctx.candidates.length });
    return;
  }
  if (!ctx.reranker) {
    ctx.log.push({
      stage: 'rerankFilter',
      failOpen: true,
      reason: 'reranker_unavailable',
      candidates: ctx.candidates.length,
      durationMs: Date.now() - started
    });
    return;
  }

  try {
    const input = ctx.candidates;
    const scores = await ctx.reranker.rerank(ctx.query, input.map(candidate => candidate.text));
    if (!Array.isArray(scores) || scores.length !== input.length || scores.some(score => !Number.isFinite(Number(score)))) {
      throw new Error('reranker returned invalid scores');
    }
    const rescored = input.map((candidate, index) => ({
      ...candidate,
      rerankScore: Number(scores[index])
    }));
    const keptIds = new Set(
      rescored
        .filter(candidate => candidate.rerankScore >= filter.threshold)
        .sort((a, b) => b.rerankScore - a.rerankScore || b.score - a.score || b.mtime - a.mtime)
        .slice(0, filter.keepK)
        .map(candidate => candidate.id)
    );
    ctx.candidates = rescored
      .filter(candidate => candidate.rerankScore >= filter.threshold)
      .sort((a, b) => b.rerankScore - a.rerankScore || b.score - a.score || b.mtime - a.mtime)
      .slice(0, filter.keepK);
    ctx.log.push({
      stage: 'rerankFilter',
      scored: input.length,
      kept: ctx.candidates.length,
      threshold: filter.threshold,
      keepK: filter.keepK,
      maxPassageTokens: filter.maxPassageTokens,
      candidates: rescored.map(candidate => ({
        id: candidate.id,
        rerankScore: roundScore(candidate.rerankScore),
        kept: keptIds.has(candidate.id)
      })),
      durationMs: Date.now() - started
    });
  } catch (err) {
    ctx.log.push({
      stage: 'rerankFilter',
      failOpen: true,
      reason: err.message,
      candidates: ctx.candidates.length,
      durationMs: Date.now() - started
    });
  }
}

export function freeGates(ctx) {
  const threshold = ctx.config.retrieval.threshold;
  const seenHashes = new Set();
  const now = ctx.now || Date.now();
  const recencyWeight = ctx.config.retrieval.recencyWeight || 0;
  const gated = [];
  const decisions = [];

  for (const candidate of ctx.candidates) {
    const hasDenseScore = typeof candidate.score === 'number';
    if (hasDenseScore && candidate.score < threshold) {
      decisions.push({ id: candidate.id, dropReason: 'belowThreshold' });
      continue;
    }
    if (!hasDenseScore) {
      const admitTopN = ctx.config.retrieval.bm25AdmitTopN ?? 2;
      if (typeof candidate.bm25Rank !== 'number' || candidate.bm25Rank > admitTopN) {
        decisions.push({ id: candidate.id, dropReason: 'bm25WeakNoDense' });
        continue;
      }
    }
    if (isStaleCandidate(ctx.config, candidate)) {
      decisions.push({ id: candidate.id, dropReason: 'stale' });
      continue;
    }
    if (seenHashes.has(candidate.hash)) {
      decisions.push({ id: candidate.id, dropReason: 'dup' });
      continue;
    }
    seenHashes.add(candidate.hash);
    const ageDays = Math.max(0, (now - candidate.mtime) / 86_400_000);
    const recencyBoost = recencyWeight / (1 + ageDays / 30);
    const rankScore = candidate.normalizedFused ?? candidate.rerankScore ?? candidate.score;
    const passed = {
      ...candidate,
      rankScore,
      finalScore: rankScore + recencyBoost
    };
    gated.push(passed);
    decisions.push({ id: candidate.id, kept: true });
  }

  gated.sort((a, b) => b.finalScore - a.finalScore || b.mtime - a.mtime);
  const { selected, budgetDropped } = trimToBudgetWithDrops(gated, ctx.config.retrieval);
  ctx.selected = selected;

  const budgetDroppedIds = new Set(budgetDropped.map(candidate => candidate.id));
  const selectedIds = new Set(selected.map(candidate => candidate.id));
  const finalDecisions = decisions.map(decision => {
    if (!decision.kept) return decision;
    if (selectedIds.has(decision.id)) return { id: decision.id, kept: true };
    if (budgetDroppedIds.has(decision.id)) return { id: decision.id, dropReason: 'budget' };
    return { id: decision.id, dropReason: 'budget' };
  });

  ctx.log.push({
    stage: 'freeGates',
    selected: ctx.selected.length,
    survivors: ctx.selected.map(candidate => candidate.id),
    drops: countDropReasons(finalDecisions),
    candidates: finalDecisions
  });
}

export function trimToBudget(candidates, retrievalConfig) {
  return trimToBudgetWithDrops(candidates, retrievalConfig).selected;
}

function trimToBudgetWithDrops(candidates, retrievalConfig) {
  const maxTotalTokens = retrievalConfig.maxTotalTokens;
  const selected = [];
  const budgetDropped = [];
  let used = 0;
  for (const candidate of candidates) {
    if (used >= maxTotalTokens) {
      budgetDropped.push(candidate);
      continue;
    }
    const tokenCount = Math.min(candidate.tokenCount, retrievalConfig.chunkTokens);
    if (used + tokenCount > maxTotalTokens && selected.length > 0) {
      budgetDropped.push(candidate);
      continue;
    }
    selected.push(candidate);
    used += tokenCount;
  }
  return { selected, budgetDropped };
}

export function assemble(ctx) {
  if (!ctx.selected.length) {
    ctx.additionalContext = '';
    ctx.log.push({ stage: 'assemble', injected: false });
    return;
  }

  const lines = [
    '<retrieved-memory note="Possibly-relevant items from your own memory. Treat as candidates: use if they apply, verify against the source file, ignore if not. If cut off, read the full file. If you are actively editing any cited source file this session, treat its snippet as possibly out of date.">'
  ];

  for (const candidate of ctx.selected) {
    const date = candidate.metadata?.date || new Date(candidate.mtime).toISOString().slice(0, 10);
    const text = truncateChunk(candidate.text, ctx.config.retrieval.chunkTokens);
    lines.push(`[${candidate.source} · ${date}] ${text}`);
  }

  lines.push('</retrieved-memory>');
  ctx.additionalContext = lines.join('\n');
  ctx.log.push({ stage: 'assemble', injected: true, bytes: ctx.additionalContext.length });
}

export function truncateChunk(text, maxTokens) {
  if (estimateTokens(text) <= maxTokens) return text;
  const words = text.split(/\s+/).filter(Boolean);
  const truncated = words.slice(0, maxTokens).join(' ');
  return `${truncated}\n[truncated; read source file for full chunk]`;
}

export function isStaleCandidate(config, candidate) {
  for (const root of config.corpus.roots) {
    const filePath = path.join(root, candidate.source);
    try {
      const stats = fs.statSync(filePath);
      if (Math.floor(stats.mtimeMs) > candidate.mtime) return true;
      return false;
    } catch {
      continue;
    }
  }
  return true;
}

function candidateSnapshot(candidate) {
  return {
    id: candidate.id,
    source: candidate.source,
    score: roundScore(candidate.score)
  };
}

function roundScore(value) {
  return typeof value === 'number' ? Number(value.toFixed(6)) : null;
}

function countDropReasons(decisions) {
  const counts = {};
  for (const decision of decisions) {
    if (!decision.dropReason) continue;
    counts[decision.dropReason] = (counts[decision.dropReason] || 0) + 1;
  }
  return counts;
}
