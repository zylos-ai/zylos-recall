import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../src/lib/config.js';

export const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
export const EVAL_CORPUS_DIR = path.join(EVAL_DIR, 'corpus');
export const EVAL_INDEX_PATH = path.join(EVAL_DIR, 'index.sqlite');
export const DEFAULT_EVAL_NOW = Date.parse('2026-06-09T12:00:00Z');

export function createEvalConfig(overrides = {}) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.dataDir = EVAL_DIR;
  config.indexPath = overrides.indexPath || EVAL_INDEX_PATH;
  config.corpus.roots = overrides.roots || [EVAL_CORPUS_DIR];
  config.corpus.allow = overrides.allow || ['**/*.md'];
  config.corpus.deny = overrides.deny || ['**/.git/**', '**/node_modules/**'];
  config.corpus.maxFileBytes = 256 * 1024;
  config.chunking.minTokens = overrides.minTokens || 8;
  config.retrieval.topK = overrides.topK || 5;
  // Default the eval report to the live deployed threshold (0.65) so the regression
  // gate tests the shipped gate config; the sweep overrides this per grid point.
  config.retrieval.threshold = overrides.threshold ?? 0.65;
  config.retrieval.recencyWeight = overrides.recencyWeight ?? config.retrieval.recencyWeight;
  config.enabled = true;
  return config;
}

