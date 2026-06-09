import { estimateTokens } from './chunker.js';
import { createEmbedder } from './embedders/index.js';
import { ChunkStore } from './store.js';
import fs from 'node:fs';
import path from 'node:path';

export const STAGES = Object.freeze({
  denseRetrieve,
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
  ctx.log.push({ stage: 'denseRetrieve', candidates: ctx.candidates.length });
}

export async function rerankFilter(ctx) {
  const started = Date.now();
  const filter = ctx.config.filter || { provider: 'none' };
  if (filter.provider !== 'rerank') {
    ctx.log.push({ stage: 'rerankFilter', enabled: false, candidates: ctx.candidates.length });
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

  for (const candidate of ctx.candidates) {
    if (candidate.score < threshold) continue;
    if (isStaleCandidate(ctx.config, candidate)) continue;
    if (seenHashes.has(candidate.hash)) continue;
    seenHashes.add(candidate.hash);
    const ageDays = Math.max(0, (now - candidate.mtime) / 86_400_000);
    const recencyBoost = recencyWeight / (1 + ageDays / 30);
    const rankScore = candidate.rerankScore ?? candidate.score;
    gated.push({
      ...candidate,
      rankScore,
      finalScore: rankScore + recencyBoost
    });
  }

  gated.sort((a, b) => b.finalScore - a.finalScore || b.mtime - a.mtime);
  ctx.selected = trimToBudget(gated, ctx.config.retrieval);
  ctx.log.push({ stage: 'freeGates', selected: ctx.selected.length });
}

export function trimToBudget(candidates, retrievalConfig) {
  const maxTotalTokens = retrievalConfig.maxTotalTokens;
  const selected = [];
  let used = 0;
  for (const candidate of candidates) {
    if (used >= maxTotalTokens) break;
    const tokenCount = Math.min(candidate.tokenCount, retrievalConfig.chunkTokens);
    if (used + tokenCount > maxTotalTokens && selected.length > 0) continue;
    selected.push(candidate);
    used += tokenCount;
  }
  return selected;
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
