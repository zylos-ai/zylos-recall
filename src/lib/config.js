/**
 * Configuration loader for zylos-recall.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = process.env.HOME || os.homedir();

export const DATA_DIR = path.join(HOME, 'zylos/components/recall');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
export const INDEX_PATH = path.join(DATA_DIR, 'index.sqlite');

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  dataDir: DATA_DIR,
  indexPath: INDEX_PATH,
  corpus: {
    roots: [path.join(HOME, 'zylos')],
    allow: [
      'memory/reference/**/*.md',
      'memory/users/**/*.md',
      'http/public/pages/**/*.md',
      '.claude/skills/*/SKILL.md',
      '.claude/skills/*/references/**/*.md',
      'workspace/*.md',
      'workspace/**/README.md',
      'workspace/**/DESIGN.md',
      'workspace/**/CHANGELOG.md',
      'workspace/**/CLAUDE.md',
      'workspace/**/docs/**/*.md'
    ],
    deny: [
      '**/.git/**',
      '**/node_modules/**',
      '**/logs/**',
      '**/*.log',
      '**/.env',
      '**/.env.*',
      '**/*secret*',
      '**/*token*',
      'memory/identity.md',
      'memory/state.md',
      'memory/references.md',
      'memory/sessions/**',
      'memory/archive/**',
      'CLAUDE.md',
      'AGENTS.md',
      'ZYLOS.md',
      '**/*.bak',
      '**/*.backup',
      '**/*.RETIRED',
      '**/index.sqlite',
      '**/index.sqlite-*'
    ],
    maxFileBytes: 512 * 1024
  },
  chunking: {
    targetTokens: 350,
    minTokens: 40,
    maxTokens: 500,
    overlapRatio: 0.15
  },
  embedder: {
    provider: 'local-onnx',
    model: 'Xenova/multilingual-e5-small',
    dimension: 384,
    batchSize: 16,
    cacheDir: path.join(DATA_DIR, 'models')
  },
  retrieval: {
    pipeline: ['denseRetrieve', 'freeGates', 'assemble'],
    topK: 5,
    threshold: 0.35,
    maxTotalTokens: 1500,
    chunkTokens: 350,
    recencyWeight: 0.05
  },
  service: {
    host: '127.0.0.1',
    port: 37537,
    timeoutMs: 800
  },
  freshness: {
    enabled: true,
    watch: true,
    sweep: true,
    debounceMs: 1000,
    sweepIntervalMs: 300000
  },
  filter: {
    provider: 'none'
  }
});

let config = null;
let configWatcher = null;

export function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return HOME;
  if (value.startsWith('~/')) return path.join(HOME, value.slice(2));
  return value;
}

function mergeObject(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return structuredClone(base);
  }

  const merged = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      merged[key] &&
      typeof merged[key] === 'object' &&
      !Array.isArray(merged[key])
    ) {
      merged[key] = mergeObject(merged[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function normalizeConfig(input) {
  const merged = mergeObject(DEFAULT_CONFIG, input);
  merged.dataDir = expandHome(merged.dataDir);
  merged.indexPath = expandHome(merged.indexPath);
  merged.embedder.cacheDir = expandHome(merged.embedder.cacheDir);
  merged.corpus.roots = merged.corpus.roots.map(expandHome);
  return validateConfig(merged);
}

export function validateConfig(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Config must be a JSON object');
  }
  if (typeof value.enabled !== 'boolean') errors.push('enabled must be boolean');
  if (!Array.isArray(value.corpus?.roots) || value.corpus.roots.length === 0) {
    errors.push('corpus.roots must be a non-empty array');
  }
  for (const field of ['allow', 'deny']) {
    if (!Array.isArray(value.corpus?.[field])) {
      errors.push(`corpus.${field} must be an array`);
    }
  }
  if (!Number.isInteger(value.corpus?.maxFileBytes) || value.corpus.maxFileBytes <= 0) {
    errors.push('corpus.maxFileBytes must be a positive integer');
  }
  if (!Number.isInteger(value.chunking?.targetTokens) || value.chunking.targetTokens <= 0) {
    errors.push('chunking.targetTokens must be a positive integer');
  }
  if (!Number.isInteger(value.chunking?.maxTokens) || value.chunking.maxTokens < value.chunking.targetTokens) {
    errors.push('chunking.maxTokens must be an integer >= chunking.targetTokens');
  }
  if (!Number.isInteger(value.embedder?.dimension) || value.embedder.dimension <= 0) {
    errors.push('embedder.dimension must be a positive integer');
  }
  if (value.embedder?.provider !== 'local-onnx') {
    errors.push('embedder.provider must be local-onnx for R1');
  }
  if (!Array.isArray(value.retrieval?.pipeline)) {
    errors.push('retrieval.pipeline must be an array');
  }
  if (typeof value.service?.host !== 'string' || !value.service.host.trim()) {
    errors.push('service.host must be a non-empty string');
  }
  if (!Number.isInteger(value.service?.port) || value.service.port <= 0 || value.service.port > 65535) {
    errors.push('service.port must be a valid TCP port');
  }
  if (!Number.isInteger(value.service?.timeoutMs) || value.service.timeoutMs <= 0) {
    errors.push('service.timeoutMs must be a positive integer');
  }
  if (typeof value.freshness?.enabled !== 'boolean') {
    errors.push('freshness.enabled must be boolean');
  }
  if (!Number.isInteger(value.freshness?.debounceMs) || value.freshness.debounceMs < 0) {
    errors.push('freshness.debounceMs must be a non-negative integer');
  }
  if (!Number.isInteger(value.freshness?.sweepIntervalMs) || value.freshness.sweepIntervalMs < 0) {
    errors.push('freshness.sweepIntervalMs must be a non-negative integer');
  }
  if (value.filter?.provider !== 'none') {
    errors.push('filter.provider must be none for v1');
  }
  if (errors.length) {
    throw new Error(`Invalid recall config: ${errors.join('; ')}`);
  }
  return value;
}

export function loadConfig(configPath = CONFIG_PATH) {
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      config = normalizeConfig(JSON.parse(content));
    } else {
      config = normalizeConfig({});
    }
  } catch (err) {
    throw new Error(`Failed to load recall config: ${err.message}`);
  }
  return config;
}

export function getConfig() {
  if (!config) return loadConfig();
  return config;
}

export function saveConfig(newConfig, configPath = CONFIG_PATH) {
  const normalized = normalizeConfig(newConfig);
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const tmpPath = `${configPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(normalized, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmpPath, configPath);
  config = normalized;
  return normalized;
}

export function watchConfig(onChange, configPath = CONFIG_PATH) {
  if (configWatcher) configWatcher.close();
  if (!fs.existsSync(configPath)) return;

  configWatcher = fs.watch(configPath, (eventType) => {
    if (eventType !== 'change' && eventType !== 'rename') return;
    try {
      const next = loadConfig(configPath);
      onChange?.(next);
    } catch (err) {
      console.error(`[recall] Config reload failed: ${err.message}`);
    }
  });
}

export function stopWatching() {
  if (configWatcher) {
    configWatcher.close();
    configWatcher = null;
  }
}
