#!/usr/bin/env node

import { loadConfig } from './lib/config.js';
import { buildIndex, queryIndex } from './lib/indexer.js';
import { retrieveMemory } from './lib/retriever.js';
import { inspectSession, formatInspection } from './inspect.js';

function usage() {
  return `Usage:
  zylos-recall index [--config <path>]
  zylos-recall query [--config <path>] [--top-k <n>] <text>
  zylos-recall retrieve [--config <path>] <text>
  zylos-recall inspect [--session <id|latest>] [--last <n>] [--full]
`;
}

function parseArgs(argv) {
  const args = [...argv];
  if (args[0] === '--help' || args[0] === '-h') {
    return { command: null, options: { help: true }, positionals: [] };
  }
  const command = args.shift();
  const options = {};
  const positionals = [];

  while (args.length) {
    const value = args.shift();
    if (value === '--config') options.configPath = args.shift();
    else if (value === '--top-k') options.topK = Number(args.shift());
    else if (value === '--session') options.session = args.shift();
    else if (value === '--last') options.last = Number(args.shift());
    else if (value === '--full') options.full = true;
    else if (value === '--help' || value === '-h') options.help = true;
    else positionals.push(value);
  }

  return { command, options, positionals };
}

async function main() {
  const { command, options, positionals } = parseArgs(process.argv.slice(2));
  if (options.help || !command) {
    console.log(usage());
    return;
  }

  // inspect reads Claude transcripts only — no config/service needed, so it runs
  // even when recall is disabled.
  if (command === 'inspect') {
    const result = inspectSession({ session: options.session });
    console.log(formatInspection(result, { last: options.last || 12, full: options.full }));
    return;
  }

  const config = loadConfig(options.configPath);
  if (!config.enabled) {
    console.error('[recall] disabled in config');
    process.exitCode = 2;
    return;
  }

  if (command === 'index') {
    const result = await buildIndex(config);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'query') {
    const query = positionals.join(' ').trim();
    if (!query) throw new Error('query text is required');
    const results = await queryIndex(config, query, { topK: options.topK });
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (command === 'retrieve') {
    const query = positionals.join(' ').trim();
    if (!query) throw new Error('retrieve text is required');
    const result = await retrieveMemory(config, query);
    console.log(result.additionalContext);
    return;
  }

  throw new Error(`Unknown command: ${command}\n${usage()}`);
}

main().catch(err => {
  console.error(`[recall] ${err.message}`);
  process.exit(1);
});
