import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/cli.js';
import { DEFAULT_CONFIG } from '../src/lib/config.js';
import { ChunkStore } from '../src/lib/store.js';

class FakeEmbedder {
  id() {
    return 'fake@2';
  }

  dimension() {
    return 2;
  }
}

test('recall CLI sends clamped tool overrides and renders JSON hits', async () => {
  const stdout = [];
  let requestBody = null;
  await runCli({
    argv: [
      'recall',
      '--top-k', '999',
      '--bm25-top-k', 'bad',
      '--max-total-tokens', '7000',
      '--format', 'json',
      'alpha project'
    ],
    stdout: { write: value => stdout.push(value) },
    stderr: { write() {} },
    configLoader: () => testConfig(),
    timeoutSignal: ms => {
      assert.equal(ms, 1000);
      return 'timeout-signal';
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:37537/retrieve');
      assert.equal(options.signal, 'timeout-signal');
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        async json() {
          return { selected: [sampleCandidate()] };
        }
      };
    }
  });

  assert.deepEqual(requestBody, {
    query: 'alpha project',
    topK: 25,
    bm25TopK: 15,
    maxTotalTokens: 6000
  });
  const parsed = JSON.parse(stdout.join(''));
  assert.deepEqual(parsed, [{
    source: 'memory/reference/projects.md',
    section: 'Alpha',
    date: '2026-06-10',
    scores: {
      cosine: 0.912346,
      bm25: 8.25,
      fused: 0.75
    },
    text: 'Alpha project memory text.'
  }]);
});

test('recall CLI falls back to direct retrieval with one stderr notice', async () => {
  const stdout = [];
  const stderr = [];
  let fallbackConfig = null;
  await runCli({
    argv: ['recall', '--top-k', '50', 'alpha project'],
    stdout: { write: value => stdout.push(value) },
    stderr: { write: value => stderr.push(value) },
    configLoader: () => testConfig(),
    fetchImpl: async () => {
      throw new Error('service down');
    },
    directRetrieve: async (config, query) => {
      fallbackConfig = config;
      assert.equal(query, 'alpha project');
      return { selected: [sampleCandidate()] };
    }
  });

  assert.equal(fallbackConfig.retrieval.topK, 25);
  assert.equal(fallbackConfig.retrieval.bm25TopK, 15);
  assert.equal(fallbackConfig.retrieval.maxTotalTokens, 3000);
  assert.equal(stderr.join(''), '[recall] service unavailable; loading local index directly (slow path)\n');
  const output = stdout.join('');
  assert.match(output, /memory\/reference\/projects\.md · 2026-06-10 · cosine=0\.912346/);
  assert.match(output, /Alpha project memory text\./);
  assert.doesNotMatch(output, /<retrieved-memory/);
});

test('toc CLI groups sqlite chunks by tier and stays compact by default', async () => {
  const config = indexedConfig();
  const compact = [];
  await runCli({
    argv: ['toc'],
    stdout: { write: value => compact.push(value) },
    stderr: { write() {} },
    configLoader: () => config
  });

  const compactText = compact.join('');
  assert.match(compactText, /^memory\n/m);
  assert.match(compactText, /memory\/reference\/projects\.md · 2026-05-01 · 1 chunks/);
  assert.match(compactText, /^session\n/m);
  assert.match(compactText, /memory\/sessions\/current\.md · 2026-06-10 · 2 chunks/);
  assert.doesNotMatch(compactText, /session chunk body text/);
  assert.doesNotMatch(compactText, /Alpha Section/);

  const full = [];
  await runCli({
    argv: ['toc', '--tier', 'session', '--full', '--format', 'json'],
    stdout: { write: value => full.push(value) },
    stderr: { write() {} },
    configLoader: () => config
  });

  const parsed = JSON.parse(full.join(''));
  assert.deepEqual(parsed, [{
    type: 'session',
    files: [{
      source: 'memory/sessions/current.md',
      date: '2026-06-10',
      chunks: 2,
      sections: ['Session Alpha', 'Session Beta']
    }]
  }]);
});

test('cli entrypoint runs when invoked through a bin-style symlink', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-cli-bin-'));
  const link = path.join(dir, 'zylos-recall');
  const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  fs.symlinkSync(cliPath, link);

  const result = spawnSync(process.execPath, [link, '--help'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /zylos-recall recall/);
  assert.equal(result.stderr, '');
});

function testConfig() {
  const config = structuredClone(DEFAULT_CONFIG);
  config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-tool-face-'));
  config.indexPath = path.join(config.dataDir, 'index.sqlite');
  config.freshness.enabled = false;
  return config;
}

function indexedConfig() {
  const config = testConfig();
  const store = new ChunkStore(config.indexPath);
  try {
    store.initialize(new FakeEmbedder());
    store.replaceCorpus([
      {
        id: 'memory-a',
        text: 'memory chunk body text should not be shown in compact toc',
        source: 'memory/reference/projects.md',
        section: 'Alpha Section',
        hash: 'memory-a-hash',
        mtime: Date.parse('2026-05-01T00:00:00Z'),
        tokenCount: 9,
        metadata: { type: 'memory', date: '2026-05-01' }
      },
      {
        id: 'session-a',
        text: 'session chunk body text should not be shown in compact toc',
        source: 'memory/sessions/current.md',
        section: 'Session Alpha',
        hash: 'session-a-hash',
        mtime: Date.parse('2026-06-09T00:00:00Z'),
        tokenCount: 9,
        metadata: { type: 'session', date: '2026-06-09' }
      },
      {
        id: 'session-b',
        text: 'second session chunk body text should not be shown in compact toc',
        source: 'memory/sessions/current.md',
        section: 'Session Beta',
        hash: 'session-b-hash',
        mtime: Date.parse('2026-06-10T00:00:00Z'),
        tokenCount: 9,
        metadata: { type: 'session', date: '2026-06-10' }
      }
    ], 'fake@2', [
      [[1, 0]],
      [[0.9, 0.1]],
      [[0.8, 0.2]]
    ]);
  } finally {
    store.close();
  }
  return config;
}

function sampleCandidate() {
  return {
    id: 'alpha',
    text: 'Alpha project memory text.',
    source: 'memory/reference/projects.md',
    section: 'Alpha',
    mtime: Date.parse('2026-06-10T00:00:00Z'),
    tokenCount: 5,
    metadata: { date: '2026-06-10', type: 'memory' },
    score: 0.91234567,
    bm25Score: 8.25,
    normalizedFused: 0.75,
    finalScore: 0.85
  };
}
