import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_SETTINGS_PATH = path.join(os.homedir(), 'zylos/.claude/settings.json');
export const DEFAULT_RECALL_COMMAND = 'node ~/zylos/.claude/skills/recall/src/retrieve.js';
export const RECALL_HOOK_TIMEOUT_MS = 1000;

export function registerRecallHook(settingsPath = DEFAULT_SETTINGS_PATH, command = DEFAULT_RECALL_COMMAND) {
  const settings = readSettings(settingsPath);
  if (!settings.hooks) settings.hooks = {};
  if (!Array.isArray(settings.hooks.UserPromptSubmit)) settings.hooks.UserPromptSubmit = [];

  const hook = {
    type: 'command',
    command,
    timeout: RECALL_HOOK_TIMEOUT_MS
  };
  const group = findOrCreatePromptGroup(settings.hooks.UserPromptSubmit);
  const existingIndex = group.hooks.findIndex(item => isRecallHook(item));
  if (existingIndex >= 0) {
    group.hooks[existingIndex] = hook;
  } else {
    group.hooks.push(hook);
  }

  writeSettings(settingsPath, settings);
  return settings;
}

export function removeRecallHook(settingsPath = DEFAULT_SETTINGS_PATH) {
  const settings = readSettings(settingsPath);
  const groups = settings.hooks?.UserPromptSubmit;
  if (!Array.isArray(groups)) return settings;

  settings.hooks.UserPromptSubmit = groups
    .map(group => ({
      ...group,
      hooks: Array.isArray(group.hooks) ? group.hooks.filter(hook => !isRecallHook(hook)) : []
    }))
    .filter(group => group.hooks.length > 0);

  writeSettings(settingsPath, settings);
  return settings;
}

export function isRecallHook(hook) {
  return hook?.type === 'command' &&
    typeof hook.command === 'string' &&
    hook.command.includes('/skills/recall/src/retrieve.js');
}

function findOrCreatePromptGroup(groups) {
  const existing = groups.find(group => !group.matcher && Array.isArray(group.hooks));
  if (existing) return existing;
  const group = { hooks: [] };
  groups.push(group);
  return group;
}

function readSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return {};
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

function writeSettings(settingsPath, settings) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  const tmpPath = `${settingsPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmpPath, settingsPath);
}
