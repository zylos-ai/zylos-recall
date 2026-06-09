#!/usr/bin/env node

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildIndex } from '../src/lib/indexer.js';
import { createEvalConfig, EVAL_INDEX_PATH } from './config.js';

export async function buildEvalIndex(options = {}) {
  const config = options.config || createEvalConfig(options.configOverrides);
  removeIndexFiles(config.indexPath);
  const result = await buildIndex(config, options);
  return { ...result, indexPath: config.indexPath };
}

export function removeIndexFiles(indexPath = EVAL_INDEX_PATH) {
  for (const suffix of ['', '-shm', '-wal']) {
    const candidate = `${indexPath}${suffix}`;
    if (fs.existsSync(candidate)) fs.rmSync(candidate, { force: true });
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
