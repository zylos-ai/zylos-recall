#!/usr/bin/env node
/**
 * Post-upgrade hook for zylos-recall
 *
 * Called by Claude after CLI upgrade completes (zylos upgrade --json).
 * CLI handles: stop service, backup, file sync, npm install, manifest.
 *
 * This hook handles component-specific migrations:
 * - Config schema migrations
 * - Data format updates
 *
 * Note: Service restart is handled by Claude after this hook.
 */

import fs from 'fs';
import path from 'path';
import { registerRecallHook } from '../src/lib/settings-hooks.js';

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/recall');
const configPath = path.join(DATA_DIR, 'config.json');
const OLD_DEFAULT_ALLOW = [
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
];
const NARROW_DEFAULT_ALLOW = [
  'memory/reference/**/*.md',
  'memory/users/**/*.md',
  'http/public/pages/**/*.md',
  '.claude/skills/*/SKILL.md',
  'workspace/*.md',
  'workspace/**/README.md',
  'workspace/**/DESIGN.md',
  'workspace/**/CHANGELOG.md'
];

console.log('[post-upgrade] Running recall-specific migrations...\n');

// Config migrations
if (fs.existsSync(configPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    let migrated = false;
    const migrations = [];

    // Migration 1: Ensure enabled field
    if (config.enabled === undefined) {
      config.enabled = true;
      migrated = true;
      migrations.push('Added enabled field');
    }

    if (!config.dataDir) {
      config.dataDir = DATA_DIR;
      migrated = true;
      migrations.push('Added dataDir field');
    }

    if (!config.indexPath) {
      config.indexPath = path.join(DATA_DIR, 'index.sqlite');
      migrated = true;
      migrations.push('Added indexPath field');
    }
    if (arraysEqual(config.corpus?.allow, OLD_DEFAULT_ALLOW)) {
      config.corpus.allow = NARROW_DEFAULT_ALLOW;
      migrated = true;
      migrations.push('Narrowed default corpus allowlist');
    }

    if (!config.freshness) {
      config.freshness = {};
      migrated = true;
      migrations.push('Added freshness config');
    }
    if (config.freshness.enabled === undefined) {
      config.freshness.enabled = true;
      migrated = true;
      migrations.push('Added freshness.enabled');
    }
    if (config.freshness.watch === undefined) {
      config.freshness.watch = true;
      migrated = true;
      migrations.push('Added freshness.watch');
    }
    if (config.freshness.sweep === undefined) {
      config.freshness.sweep = true;
      migrated = true;
      migrations.push('Added freshness.sweep');
    }
    if (config.freshness.debounceMs === undefined) {
      config.freshness.debounceMs = 1000;
      migrated = true;
      migrations.push('Added freshness.debounceMs');
    }
    if (config.freshness.sweepIntervalMs === undefined) {
      config.freshness.sweepIntervalMs = 300000;
      migrated = true;
      migrations.push('Added freshness.sweepIntervalMs');
    }

    // Add more migrations as needed for future versions
    // Migration N: Example
    // if (config.newField === undefined) {
    //   config.newField = 'default';
    //   migrated = true;
    //   migrations.push('Added newField');
    // }

    // Save if migrated
    if (migrated) {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log('Config migrations applied:');
      migrations.forEach(m => console.log('  - ' + m));
    } else {
      console.log('No config migrations needed.');
    }
  } catch (err) {
    console.error('Config migration failed:', err.message);
    process.exit(1);
  }
} else {
  console.log('No config file found, skipping migrations.');
}

console.log('\nRegistering UserPromptSubmit hook...');
registerRecallHook();
console.log('  - recall retrieve hook registered');

console.log('\n[post-upgrade] Complete!');

function arraysEqual(left, right) {
  return Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index]);
}
