import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './hash.js';

// Applied in order; PEM/JWT/bearer blocks first so structured tokens are
// caught whole before the generic key:value pattern slices them.
const SECRET_PATTERNS = [
  /-----BEGIN[A-Z ]*-----[A-Za-z0-9+/=\s]+?(?:-----END[A-Z ]*-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]+\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[a-z]-[A-Za-z0-9-]{8,}/gi,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\b[A-Za-z0-9_-]*(?:token|secret|password|passwd|pwd|credential|apikey|api[-_]key|private[-_]?key|authorization)[A-Za-z0-9_-]*\s*[:=]\s*\S+/gi
];

export function appendRetrievalLog(config, { query, selected = [], stages = [], durationMs, injected }) {
  const record = {
    kind: 'service',
    ts: new Date().toISOString(),
    queryHash: sha256(String(query || '')),
    queryPreview: redactQuery(String(query || '')),
    durationMs,
    injected: Boolean(injected),
    stages,
    selected: selected.map(candidate => ({
      id: candidate.id,
      source: candidate.source,
      score: roundScore(candidate.score),
      bm25Score: roundScore(candidate.bm25Score),
      denseRank: candidate.denseRank,
      bm25Rank: candidate.bm25Rank,
      fusedScore: roundScore(candidate.fusedScore),
      normalizedFused: roundScore(candidate.normalizedFused),
      rerankScore: roundScore(candidate.rerankScore),
      rankScore: roundScore(candidate.rankScore),
      finalScore: roundScore(candidate.finalScore)
    }))
  };

  appendJsonLine(config, record);
  return record;
}

export function appendClientRetrievalLog(config, { query, outcome, durationMs }) {
  const record = {
    kind: 'client',
    ts: new Date().toISOString(),
    queryHash: sha256(String(query || '')),
    outcome,
    durationMs
  };

  appendJsonLine(config, record);
  return record;
}

export function redactQuery(query) {
  // Redact before truncating so a credential cut at the 200-char boundary
  // cannot leave a partial value the patterns no longer match.
  let compact = query.replace(/\s+/g, ' ').trim();
  for (const pattern of SECRET_PATTERNS) {
    compact = compact.replace(pattern, '[redacted]');
  }
  return compact.slice(0, 200);
}

function roundScore(value) {
  return typeof value === 'number' ? Number(value.toFixed(6)) : null;
}

function appendJsonLine(config, record) {
  const logPath = config.retrieval?.logPath || path.join(config.dataDir, 'logs', 'retrieval.jsonl');
  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'a' });
}
