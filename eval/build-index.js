#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildIndex } from '../src/lib/indexer.js';
import { createEvalConfig, EVAL_CORPUS_DIR, EVAL_INDEX_PATH } from './config.js';

export const DEFAULT_FIXTURE_DATE = '2026-01-01';

export async function buildEvalIndex(options = {}) {
  const config = options.config || createEvalConfig(options.configOverrides);
  applyFixtureDates(config.corpus.roots);
  removeIndexFiles(config.indexPath);
  const result = await buildIndex(config, options);
  return { ...result, indexPath: config.indexPath };
}

export function applyFixtureDates(roots = [EVAL_CORPUS_DIR]) {
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const filePath of markdownFiles(root)) {
      const date = extractFixtureDate(fs.readFileSync(filePath, 'utf8')) || DEFAULT_FIXTURE_DATE;
      const timestamp = Date.parse(`${date}T12:00:00Z`);
      if (!Number.isFinite(timestamp)) continue;
      const time = new Date(timestamp);
      fs.utimesSync(filePath, time, time);
    }
  }
}

export function extractFixtureDate(text) {
  const explicit = String(text).match(/^\s*date:\s*(20\d{2}-\d{2}-\d{2})\s*$/im);
  if (explicit) return explicit[1];
  const prose = String(text).match(/\bdated\s+(20\d{2}-\d{2}-\d{2})\b/i);
  return prose?.[1] || null;
}

export function removeIndexFiles(indexPath = EVAL_INDEX_PATH) {
  for (const suffix of ['', '-shm', '-wal']) {
    const candidate = `${indexPath}${suffix}`;
    if (fs.existsSync(candidate)) fs.rmSync(candidate, { force: true });
  }
}

function* markdownFiles(root) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    const stats = fs.lstatSync(current);
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      for (const entry of fs.readdirSync(current)) stack.push(path.join(current, entry));
      continue;
    }
    if (stats.isFile() && /\.(md|markdown|mdown)$/i.test(current)) yield current;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildEvalIndex().then(result => {
    console.log(JSON.stringify(result, null, 2));
  }).catch(err => {
    console.error(`[recall-eval] ${err.message}`);
    process.exit(1);
  });
}
