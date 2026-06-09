import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../src/lib/config.js';
import { FreshnessManager, concreteWatchDirs } from '../src/lib/freshness.js';

test('freshness manager indexes on startup and skips unchanged sweeps', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-fresh-root-'));
  const file = path.join(root, 'memory/reference/projects.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# Alpha\n\nAlpha project memory has enough durable content for indexing.');

  const config = structuredClone(DEFAULT_CONFIG);
  config.corpus.roots = [root];
  config.corpus.allow = ['memory/reference/**/*.md'];
  config.freshness.watch = false;
  config.freshness.sweep = false;
  const calls = [];
  const manager = new FreshnessManager(config, {
    embedder: {},
    store: {},
    log: () => {},
    build: async (_config, options) => {
      calls.push(options);
      return { total: 1, inserted: 1, updated: 0, unchanged: 0, removed: 0 };
    }
  });

  await manager.start();
  await manager.checkForChanges('sweep');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].embedder, manager.embedder);
  await manager.stop();
});

test('freshness manager refreshes when corpus signature changes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-fresh-change-'));
  const file = path.join(root, 'memory/reference/projects.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# Alpha\n\nAlpha project memory has enough durable content for indexing.');

  const config = structuredClone(DEFAULT_CONFIG);
  config.corpus.roots = [root];
  config.corpus.allow = ['memory/reference/**/*.md'];
  config.freshness.watch = false;
  config.freshness.sweep = false;
  let calls = 0;
  const manager = new FreshnessManager(config, {
    log: () => {},
    build: async () => {
      calls += 1;
      return { total: 1, inserted: 0, updated: 1, unchanged: 0, removed: 0 };
    }
  });

  await manager.start();
  fs.appendFileSync(file, '\nMore details.');
  await manager.checkForChanges('sweep');

  assert.equal(calls, 2);
  await manager.stop();
});

test('watch roots are narrowed to concrete allowlist subtrees', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-watch-root-'));
  for (const dir of [
    'memory/reference',
    'memory/users',
    'http/public/pages',
    '.claude/skills',
    'workspace',
    'workspace/example/docs',
    'workspace/example/node_modules',
    'workspace/example/.git',
    'node_modules',
    '.git'
  ]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }

  const config = structuredClone(DEFAULT_CONFIG);
  config.corpus.roots = [root];

  const watched = concreteWatchDirs(config).map(entry => ({
    dir: path.relative(root, entry.dir).split(path.sep).join('/'),
    recursive: entry.recursive
  }));

  assert.deepEqual(watched, [
    { dir: '.claude/skills', recursive: false },
    { dir: 'http/public/pages', recursive: true },
    { dir: 'memory/reference', recursive: true },
    { dir: 'memory/users', recursive: true },
    { dir: 'workspace', recursive: false }
  ]);
  assert.equal(watched.some(entry => entry.dir === 'node_modules'), false);
  assert.equal(watched.some(entry => entry.dir === '.git'), false);
  assert.equal(watched.some(entry => entry.dir === ''), false);
});
