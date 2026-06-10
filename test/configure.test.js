import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runConfigure(home, stdin) {
  return spawnSync(process.execPath, ['hooks/configure.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home },
    input: stdin,
    encoding: 'utf8'
  });
}

test('configure creates config.json with 0600 mode when writing collected secrets', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-configure-'));
  const configPath = path.join(home, 'zylos/components/recall/config.json');

  const result = runConfigure(home, JSON.stringify({ RECALL_API_KEY: 'sk-test-value' }));

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.api_key, 'sk-test-value');
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
});

test('configure repairs a loose existing config to 0600 on rewrite', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-configure-repair-'));
  const dataDir = path.join(home, 'zylos/components/recall');
  fs.mkdirSync(dataDir, { recursive: true });
  const configPath = path.join(dataDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ enabled: true }, null, 2) + '\n', { mode: 0o644 });

  const result = runConfigure(home, JSON.stringify({ RECALL_API_KEY: 'sk-test-value' }));

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
});
