import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runCli } from '../src/cli.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../src/lib/config.js';
import {
  formatApplyMessage,
  sensitiveConfigKeyPaths,
  SETTABLE_CONFIG_PATHS
} from '../src/lib/config-cli.js';

test('default recall config has no secret-shaped keys exposed by config get', () => {
  assert.deepEqual(sensitiveConfigKeyPaths(DEFAULT_CONFIG), []);
  assert.deepEqual(
    sensitiveConfigKeyPaths({ apiKey: 'x', authToken: 'y', maxTotalTokens: 100 }),
    ['apiKey', 'authToken']
  );
});

test('config get prints effective config or a dot-path value', async () => {
  const { configPath } = writeConfig({
    retrieval: { topK: 8 }
  });

  const one = [];
  await runCli({
    argv: ['config', 'get', '--config', configPath, 'retrieval.topK'],
    stdout: { write: value => one.push(value) },
    stderr: { write() {} }
  });
  assert.equal(JSON.parse(one.join('')), 8);

  const all = [];
  await runCli({
    argv: ['config', 'get', '--config', configPath],
    stdout: { write: value => all.push(value) },
    stderr: { write() {} }
  });
  const parsed = JSON.parse(all.join(''));
  assert.equal(parsed.retrieval.topK, 8);
  assert.equal(parsed.retrieval.bm25TopK, DEFAULT_CONFIG.retrieval.bm25TopK);
});

test('config set coerces allowed scalar values and tier penalties', async () => {
  const { configPath } = writeConfig({});

  await runCli(io(configPath, ['config', 'set', '--config', configPath, 'enabled', 'false']));
  assert.equal(loadConfig(configPath).enabled, false);

  await runCli(io(configPath, ['config', 'set', '--config', configPath, 'retrieval.topK', '12']));
  assert.equal(loadConfig(configPath).retrieval.topK, 12);

  await runCli(io(configPath, ['config', 'set', '--config', configPath, 'retrieval.threshold', '0.42']));
  assert.equal(loadConfig(configPath).retrieval.threshold, 0.42);

  await runCli(io(configPath, ['config', 'set', '--config', configPath, 'retrieval.tierPenalties.project', '0.07']));
  assert.equal(loadConfig(configPath).retrieval.tierPenalties.project, 0.07);

  await runCli(io(configPath, ['config', 'set', '--config', configPath, 'filter.provider', 'rerank']));
  assert.equal(loadConfig(configPath).filter.provider, 'rerank');
});

test('config set rejects non-allowlisted paths with a clear settable list', async () => {
  const { configPath } = writeConfig({});

  await assert.rejects(
    runCli(io(configPath, ['config', 'set', '--config', configPath, 'corpus.allow', '[]'])),
    err => {
      assert.match(err.message, /corpus\.allow/);
      assert.match(err.message, /not settable/);
      for (const settable of SETTABLE_CONFIG_PATHS) {
        assert.match(err.message, new RegExp(escapeRegExp(settable)));
      }
      return true;
    }
  );
});

test('config set validation failure leaves config file untouched', async () => {
  const { configPath } = writeConfig({ retrieval: { topK: 5 } });
  const before = fs.readFileSync(configPath, 'utf8');

  await assert.rejects(
    runCli(io(configPath, ['config', 'set', '--config', configPath, 'retrieval.topK', '0'])),
    /retrieval\.topK must be a positive integer/
  );

  assert.equal(fs.readFileSync(configPath, 'utf8'), before);
  assert.equal(loadConfig(configPath).filter.keepK, DEFAULT_CONFIG.filter.keepK);
});

test('config set writes atomically with 0600 mode preserved', async () => {
  const { configPath } = writeConfig({});
  fs.chmodSync(configPath, 0o600);

  await runCli(io(configPath, ['config', 'set', '--config', configPath, 'service.timeoutMs', '1500']));

  assert.equal(loadConfig(configPath).service.timeoutMs, 1500);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
});

test('config set apply message reflects existing watcher reality', async () => {
  const { configPath } = writeConfig({});
  const stdout = [];
  await runCli({
    ...io(configPath, ['config', 'set', '--config', configPath, 'retrieval.topK', '9']),
    stdout: { write: value => stdout.push(value) }
  });

  const output = stdout.join('');
  assert.match(output, /reload it and restart runtime after the file-change event/);
  assert.match(output, /service\.timeoutMs.*immediately/);

  const missingPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recall-config-missing-')), 'config.json');
  assert.match(
    formatApplyMessage({ configPath: missingPath, existedBefore: false }),
    /Restart zylos-recall to apply service-side changes/
  );
});

test('config allow add appends a pattern and is idempotent', async () => {
  const { configPath } = writeConfig({});

  await runCli(io(configPath, ['config', 'allow', 'add', '--config', configPath, 'notes/**/*.md']));
  assert.equal(loadConfig(configPath).corpus.allow.includes('notes/**/*.md'), true);
  assert.equal(
    loadConfig(configPath).corpus.allow.length,
    DEFAULT_CONFIG.corpus.allow.length + 1
  );

  const before = fs.readFileSync(configPath, 'utf8');
  const stdout = [];
  await runCli({
    ...io(configPath, ['config', 'allow', 'add', '--config', configPath, 'notes/**/*.md']),
    stdout: { write: value => stdout.push(value) }
  });
  assert.match(stdout.join(''), /already present/);
  assert.match(stdout.join(''), /No changes saved/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), before);
});

test('config deny add and remove round-trip for custom patterns', async () => {
  const { configPath } = writeConfig({});

  await runCli(io(configPath, ['config', 'deny', 'add', '--config', configPath, 'scratch/**']));
  assert.equal(loadConfig(configPath).corpus.deny.includes('scratch/**'), true);

  await runCli(io(configPath, ['config', 'deny', 'remove', '--config', configPath, 'scratch/**']));
  assert.equal(loadConfig(configPath).corpus.deny.includes('scratch/**'), false);
  assert.deepEqual(loadConfig(configPath).corpus.deny, [...DEFAULT_CONFIG.corpus.deny]);

  const stdout = [];
  await runCli({
    ...io(configPath, ['config', 'deny', 'remove', '--config', configPath, 'scratch/**']),
    stdout: { write: value => stdout.push(value) }
  });
  assert.match(stdout.join(''), /not found/i);
});

test('config deny remove refuses built-in secret protections without --force', async () => {
  const { configPath } = writeConfig({});
  const before = fs.readFileSync(configPath, 'utf8');

  await assert.rejects(
    runCli(io(configPath, ['config', 'deny', 'remove', '--config', configPath, '**/*secret*'])),
    /built-in secret-protection|--force/
  );
  assert.equal(fs.readFileSync(configPath, 'utf8'), before);

  await runCli(io(configPath, ['config', 'deny', 'remove', '--config', configPath, '--force', '**/*secret*']));
  assert.equal(loadConfig(configPath).corpus.deny.includes('**/*secret*'), false);
});

test('config allow/deny list prints the effective array and pin note appears on edits', async () => {
  const { configPath } = writeConfig({});

  const listed = [];
  await runCli({
    ...io(configPath, ['config', 'deny', 'list', '--config', configPath]),
    stdout: { write: value => listed.push(value) }
  });
  assert.deepEqual(JSON.parse(listed.join('')), [...DEFAULT_CONFIG.corpus.deny]);

  const edited = [];
  await runCli({
    ...io(configPath, ['config', 'deny', 'add', '--config', configPath, 'scratch/**']),
    stdout: { write: value => edited.push(value) }
  });
  assert.match(edited.join(''), /complete corpus\.deny array/);
  assert.match(edited.join(''), /will not auto-apply/);
});

test('config allow rejects unknown actions and empty patterns', async () => {
  const { configPath } = writeConfig({});

  await assert.rejects(
    runCli(io(configPath, ['config', 'allow', 'frobnicate', '--config', configPath, 'x'])),
    /Unknown corpus list action/
  );
  await assert.rejects(
    runCli(io(configPath, ['config', 'allow', 'add', '--config', configPath])),
    /non-empty glob pattern/
  );
});

function writeConfig(overrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-config-cli-'));
  const configPath = path.join(dir, 'config.json');
  saveConfig({
    ...overrides,
    dataDir: dir,
    indexPath: path.join(dir, 'index.sqlite')
  }, configPath);
  return { dir, configPath };
}

function io(configPath, argv) {
  return {
    argv,
    stdout: { write() {} },
    stderr: { write() {} },
    configLoader: maybePath => loadConfig(maybePath || configPath),
    configSaver: (config, maybePath) => saveConfig(config, maybePath || configPath),
    configExists: maybePath => fs.existsSync(maybePath || configPath)
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
