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

  async embed(texts, mode) {
    assert.equal(mode, 'query');
    return texts.map(text => {
      const normalized = String(text).toLowerCase();
      if (normalized.includes('beta')) return [0, 1];
      return [1, 0];
    });
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

test('segment CLI prints topic segment index groups as JSON', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-cli-segment-'));
  const sessionPath = path.join(dir, 'session.json');
  fs.writeFileSync(sessionPath, JSON.stringify([
    { text: 'Alpha owner changed.' },
    'Alpha budget changed.',
    { text: 'Beta launch moved.' }
  ]));
  const stdout = [];

  await runCli({
    argv: ['segment', '--session', sessionPath],
    stdout: { write: value => stdout.push(value) },
    stderr: { write() {} },
    configLoader: () => testConfig(),
    embedderFactory: () => new FakeEmbedder()
  });

  assert.deepEqual(JSON.parse(stdout.join('')), [[0, 1], [2]]);
});

test('node-search CLI round-trips a written node with stable JSON shape', async () => {
  const config = testConfig();
  const createOut = [];
  await runCli({
    argv: ['node-apply', '--op', 'CREATE', '--key', 'Alpha owner', '--value', 'Felix owns Alpha'],
    stdout: { write: value => createOut.push(value) },
    stderr: { write() {} },
    configLoader: () => config,
    embedderFactory: () => new FakeEmbedder()
  });
  const created = JSON.parse(createOut.join(''));
  assert.deepEqual(Object.keys(created).sort(), ['id', 'op']);
  assert.equal(created.op, 'CREATE');

  const searchOut = [];
  await runCli({
    argv: ['node-search', '--key', 'Alpha owner', '--k', '5'],
    stdout: { write: value => searchOut.push(value) },
    stderr: { write() {} },
    configLoader: () => config,
    embedderFactory: () => new FakeEmbedder()
  });

  const results = JSON.parse(searchOut.join(''));
  assert.equal(results.length, 1);
  assert.deepEqual(Object.keys(results[0]).sort(), ['id', 'key', 'score', 'value']);
  assert.equal(results[0].id, created.id);
  assert.equal(results[0].key, 'Alpha owner');
  assert.equal(results[0].value, 'Felix owns Alpha');
  assert.equal(typeof results[0].score, 'number');
});

test('node-apply CLI handles CREATE UPDATE NOOP and rejects bad args', async () => {
  const config = testConfig();
  const createOut = [];
  await runCli({
    argv: ['node-apply', '--op', 'CREATE', '--key', 'Alpha plan', '--value', 'Initial value'],
    stdout: { write: value => createOut.push(value) },
    stderr: { write() {} },
    configLoader: () => config,
    embedderFactory: () => new FakeEmbedder()
  });
  const created = JSON.parse(createOut.join(''));
  assert.equal(created.op, 'CREATE');
  assert.ok(created.id);

  const updateOut = [];
  await runCli({
    argv: ['node-apply', '--op', 'UPDATE', '--target-id', created.id, '--value', 'Updated value'],
    stdout: { write: value => updateOut.push(value) },
    stderr: { write() {} },
    configLoader: () => config,
    embedderFactory: () => new FakeEmbedder()
  });
  assert.deepEqual(JSON.parse(updateOut.join('')), { id: created.id, op: 'UPDATE' });

  const searchOut = [];
  await runCli({
    argv: ['node-search', '--key', 'Alpha plan'],
    stdout: { write: value => searchOut.push(value) },
    stderr: { write() {} },
    configLoader: () => config,
    embedderFactory: () => new FakeEmbedder()
  });
  assert.equal(JSON.parse(searchOut.join(''))[0].value, 'Updated value');

  const noopOut = [];
  await runCli({
    argv: ['node-apply', '--op', 'NOOP'],
    stdout: { write: value => noopOut.push(value) },
    stderr: { write() {} },
    configLoader: () => config,
    embedderFactory: () => new FakeEmbedder()
  });
  assert.deepEqual(JSON.parse(noopOut.join('')), { id: null, op: 'NOOP' });

  await assert.rejects(
    () => runCli({
      argv: ['node-apply', '--op', 'CREATE', '--key', 'Alpha plan'],
      stdout: { write() {} },
      stderr: { write() {} },
      configLoader: () => config,
      embedderFactory: () => new FakeEmbedder()
    }),
    /--value must be non-empty/
  );
  await assert.rejects(
    () => runCli({
      argv: ['node-apply', '--op', 'UPDATE', '--value', 'Missing target'],
      stdout: { write() {} },
      stderr: { write() {} },
      configLoader: () => config,
      embedderFactory: () => new FakeEmbedder()
    }),
    /--target-id must be non-empty/
  );
  await assert.rejects(
    () => runCli({
      argv: ['node-apply', '--op', 'DELETE'],
      stdout: { write() {} },
      stderr: { write() {} },
      configLoader: () => config,
      embedderFactory: () => new FakeEmbedder()
    }),
    /node-apply --op must be CREATE, UPDATE, or NOOP/
  );
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
