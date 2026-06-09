#!/usr/bin/env node
/**
 * Post-install hook for zylos-recall
 *
 * Called by zylos after configure hook and CLI installation.
 * CLI handles: download, npm install, manifest, registration.
 * zylos/agent handles: config collection, configure hook, this hook, service start.
 *
 * This hook handles component-specific setup:
 * - Create subdirectories
 * - Create default config.json when no configure hook values were provided
 * - Verify required config fields if needed
 */

import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/recall');
const INDEX_PATH = path.join(DATA_DIR, 'index.sqlite');

const INITIAL_CONFIG = {
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
    maxFileBytes: 524288
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
  filter: {
    provider: 'none'
  }
};

console.log('[post-install] Running recall-specific setup...\n');

// 1. Create subdirectories
console.log('Creating subdirectories...');
fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'models'), { recursive: true });
console.log('  - logs/');
console.log('  - models/');

// 2. Create default config if not exists
const configPath = path.join(DATA_DIR, 'config.json');
if (!fs.existsSync(configPath)) {
  console.log('\nCreating default config.json...');
  fs.writeFileSync(configPath, JSON.stringify(INITIAL_CONFIG, null, 2) + '\n', { mode: 0o600 });
  console.log('  - config.json created');
} else {
  console.log('\nConfig already exists, skipping.');
}

console.log('\n[post-install] Complete!');
