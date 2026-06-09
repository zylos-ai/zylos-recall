import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './hash.js';

const SECRET_RE = /\b(?:sk-[A-Za-z0-9_-]+|[A-Za-z0-9_-]*token[A-Za-z0-9_-]*[:=][^\s]+|[A-Za-z0-9_-]*secret[A-Za-z0-9_-]*[:=][^\s]+)\b/gi;

export function appendRetrievalLog(config, { query, selected = [], stages = [], durationMs, injected }) {
  const logPath = config.retrieval?.logPath || path.join(config.dataDir, 'logs', 'retrieval.jsonl');
  const record = {
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
      rerankScore: roundScore(candidate.rerankScore),
      rankScore: roundScore(candidate.rankScore),
      finalScore: roundScore(candidate.finalScore)
    }))
  };

  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}

export function redactQuery(query) {
  const compact = query.replace(/\s+/g, ' ').trim().slice(0, 200);
  return compact.replace(SECRET_RE, '[redacted]');
}

function roundScore(value) {
  return typeof value === 'number' ? Number(value.toFixed(6)) : null;
}
