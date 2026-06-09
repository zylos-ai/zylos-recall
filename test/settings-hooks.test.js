import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { registerRecallHook, removeRecallHook } from '../src/lib/settings-hooks.js';

test('registers recall hook idempotently and preserves existing prompt hooks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-settings-'));
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      UserPromptSubmit: [{
        hooks: [{
          type: 'command',
          command: 'node ~/zylos/.claude/skills/activity-monitor/scripts/hook-activity.js',
          async: true,
          timeout: 5
        }]
      }]
    }
  }));

  registerRecallHook(settingsPath);
  registerRecallHook(settingsPath);

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const hooks = settings.hooks.UserPromptSubmit[0].hooks;
  assert.equal(hooks.length, 2);
  assert.equal(hooks.filter(hook => hook.command.includes('/skills/recall/src/retrieve.js')).length, 1);
  assert.equal(hooks.at(-1).timeout, 1000);
});

test('removes only the recall hook', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-settings-remove-'));
  const settingsPath = path.join(dir, 'settings.json');
  registerRecallHook(settingsPath);
  const withRecall = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  withRecall.hooks.UserPromptSubmit[0].hooks.unshift({
    type: 'command',
    command: 'node ~/zylos/.claude/skills/activity-monitor/scripts/hook-activity.js',
    timeout: 5
  });
  fs.writeFileSync(settingsPath, JSON.stringify(withRecall));

  removeRecallHook(settingsPath);

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const hooks = settings.hooks.UserPromptSubmit[0].hooks;
  assert.equal(hooks.length, 1);
  assert.match(hooks[0].command, /activity-monitor/);
});
