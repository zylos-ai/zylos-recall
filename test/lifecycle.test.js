import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('PM2 treats intentional disabled exits as no-relaunch exits', () => {
  const ecosystem = require('../ecosystem.config.cjs');
  const app = ecosystem.apps.find(entry => entry.name === 'zylos-recall');

  assert.equal(app.autorestart, true);
  assert.deepEqual(app.stop_exit_codes, [0]);
});

test('disabled startup exits with code 0 for PM2 no-relaunch semantics', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-disabled-home-'));
  const dataDir = path.join(home, 'zylos/components/recall');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    enabled: false,
    dataDir,
    indexPath: path.join(dataDir, 'index.sqlite')
  }, null, 2) + '\n');

  const result = spawnSync(process.execPath, ['src/server.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home },
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Component disabled in config, exiting with code 0/);
  assert.match(result.stdout, /PM2 will park this as waiting restart without relaunching/);
});
