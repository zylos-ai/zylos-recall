import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('post-upgrade preserves existing timeout and threshold values', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-post-upgrade-'));
  const dataDir = path.join(home, 'zylos/components/recall');
  fs.mkdirSync(dataDir, { recursive: true });
  const configPath = path.join(dataDir, 'config.json');
  const original = {
    enabled: true,
    dataDir,
    indexPath: path.join(dataDir, 'index.sqlite'),
    corpus: {
      roots: [path.join(home, 'zylos')],
      allow: ['custom/**/*.md'],
      deny: ['custom-deny/**/*.md'],
      maxFileBytes: 524288
    },
    retrieval: {
      pipeline: ['denseRetrieve', 'freeGates', 'assemble'],
      threshold: 0.65
    },
    service: {
      host: '127.0.0.1',
      port: 37537,
      timeoutMs: 1000
    },
    freshness: {
      enabled: true,
      watch: true,
      sweep: true,
      debounceMs: 1000,
      sweepIntervalMs: 300000
    }
  };
  fs.writeFileSync(configPath, JSON.stringify(original, null, 2) + '\n');

  const result = spawnSync(process.execPath, ['hooks/post-upgrade.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home },
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const migrated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(migrated.service.timeoutMs, 1000);
  assert.equal(migrated.retrieval.threshold, 0.65);
  assert.deepEqual(migrated.retrieval.pipeline, ['denseRetrieve', 'freeGates', 'assemble']);
  assert.equal(migrated.retrieval.bm25TopK, 10);
  assert.equal(migrated.retrieval.rrfK, 60);
  assert.equal(migrated.retrieval.bm25AdmitTopN, 2);
  assert.deepEqual(migrated.retrieval.tierPenalties, { session: 0.05 });
  assert.deepEqual(migrated.corpus.allow, ['custom/**/*.md']);
  assert.deepEqual(migrated.corpus.deny, ['custom-deny/**/*.md']);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
});

test('post-upgrade repairs a loose config mode even without migrations', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-post-upgrade-mode-'));
  const dataDir = path.join(home, 'zylos/components/recall');
  fs.mkdirSync(dataDir, { recursive: true });
  const configPath = path.join(dataDir, 'config.json');
  const fullConfig = {
    enabled: true,
    dataDir,
    indexPath: path.join(dataDir, 'index.sqlite'),
    retrieval: {
      bm25TopK: 10,
      rrfK: 60,
      bm25AdmitTopN: 2,
      tierPenalties: { session: 0.05 }
    },
    freshness: {
      enabled: true,
      watch: true,
      sweep: true,
      debounceMs: 1000,
      sweepIntervalMs: 300000
    }
  };
  fs.writeFileSync(configPath, JSON.stringify(fullConfig, null, 2) + '\n', { mode: 0o644 });
  const before = fs.readFileSync(configPath, 'utf8');

  const result = spawnSync(process.execPath, ['hooks/post-upgrade.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home },
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /No config migrations needed/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), before);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
});
