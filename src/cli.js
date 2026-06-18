#!/usr/bin/env node

import { CONFIG_PATH, loadConfig, saveConfig } from './lib/config.js';
import { createEmbedder } from './lib/embedders/index.js';
import { buildIndex, queryIndex } from './lib/indexer.js';
import { retrieveMemory } from './lib/retriever.js';
import { inspectSession, formatInspection, inspectRetrievalLog, formatRetrievalLogInspection } from './inspect.js';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ChunkStore } from './lib/store.js';
import { TopicEngine } from './lib/topic-engine.js';
import {
  configFileExisted,
  formatApplyMessage,
  getConfigValue,
  modifyCorpusList,
  setConfigValue
} from './lib/config-cli.js';
import {
  formatRecallText,
  formatTocText,
  recallItems,
  runRecallTool,
  runTocTool
} from './lib/tool-face.js';
import { NodeWriter } from './lib/write-primitives.js';

function usage() {
  return `Usage:
  zylos-recall index [--config <path>]
  zylos-recall query [--config <path>] [--top-k <n>] <text>
  zylos-recall retrieve [--config <path>] <text>
  zylos-recall recall [--config <path>] [--top-k <n>] [--bm25-top-k <n>] [--max-total-tokens <n>] [--format text|json] <text>
  zylos-recall segment [--config <path>] --session <file.json>
  zylos-recall node-search [--config <path>] --key <text> [--k 5] [--kind memory]
  zylos-recall node-apply [--config <path>] --op CREATE|UPDATE|NOOP [--key <text>] [--value <text>] [--target-id <id>] [--kind memory]
  zylos-recall toc [--config <path>] [--tier <type>] [--full] [--format text|json]
  zylos-recall config get [--config <path>] [<dot.path>]
  zylos-recall config set [--config <path>] <dot.path> <value>
  zylos-recall config allow|deny list [--config <path>]
  zylos-recall config allow|deny add [--config <path>] <pattern>
  zylos-recall config allow|deny remove [--config <path>] [--force] <pattern>
  zylos-recall inspect [--session <id|latest>] [--last <n>] [--full]
  zylos-recall inspect --retrieval-log [<path>] [--last <n>]
`;
}

export function parseArgs(argv) {
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
    else if (value === '--k') options.k = Number(args.shift());
    else if (value === '--bm25-top-k') options.bm25TopK = Number(args.shift());
    else if (value === '--max-total-tokens') options.maxTotalTokens = Number(args.shift());
    else if (value === '--format') options.format = args.shift();
    else if (value === '--tier') options.tier = args.shift();
    else if (value === '--session') options.session = args.shift();
    else if (value === '--key') options.key = args.shift();
    else if (value === '--value') options.value = args.shift();
    else if (value === '--kind') options.kind = args.shift();
    else if (value === '--op') options.op = args.shift();
    else if (value === '--target-id') options.targetId = args.shift();
    else if (value === '--last') options.last = Number(args.shift());
    else if (value === '--full') options.full = true;
    else if (value === '--force') options.force = true;
    else if (value === '--retrieval-log') {
      options.retrievalLog = true;
      if (args[0] && !args[0].startsWith('--')) options.retrievalLogPath = args.shift();
    }
    else if (value === '--help' || value === '-h') options.help = true;
    else positionals.push(value);
  }

  return { command, options, positionals };
}

export async function runCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  configLoader = loadConfig,
  fetchImpl = globalThis.fetch,
  timeoutSignal = ms => AbortSignal.timeout(ms),
  directRetrieve,
  configSaver = saveConfig,
  configExists = configFileExisted,
  embedderFactory = createEmbedder,
  storeFactory = indexPath => new ChunkStore(indexPath)
} = {}) {
  const { command, options, positionals } = parseArgs(argv);
  if (options.help || !command) {
    stdout.write(`${usage()}\n`);
    return;
  }

  // inspect reads Claude transcripts only — no config/service needed, so it runs
  // even when recall is disabled.
  if (command === 'inspect') {
    if (options.retrievalLog) {
      const result = inspectRetrievalLog({ file: options.retrievalLogPath });
      stdout.write(`${formatRetrievalLogInspection(result, { last: options.last || 20 })}\n`);
      return;
    }
    const result = inspectSession({ session: options.session });
    stdout.write(`${formatInspection(result, { last: options.last || 12, full: options.full })}\n`);
    return;
  }

  if (command === 'config') {
    const configPath = options.configPath || CONFIG_PATH;
    const subcommand = positionals[0];
    if (subcommand === 'get') {
      const config = configLoader(options.configPath);
      const value = getConfigValue(config, positionals[1]);
      stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      return;
    }
    if (subcommand === 'set') {
      if (positionals.length < 3) {
        throw new Error('config set requires <dot.path> and <value>');
      }
      const [, dotPath, rawValue] = positionals;
      const existedBefore = configExists(configPath);
      const config = configLoader(options.configPath);
      const next = setConfigValue(config, dotPath, rawValue);
      configSaver(next, configPath);
      stdout.write(`${formatApplyMessage({ configPath, existedBefore })}\n`);
      return;
    }
    if (subcommand === 'allow' || subcommand === 'deny') {
      const action = positionals[1];
      if (action === 'list') {
        const config = configLoader(options.configPath);
        stdout.write(`${JSON.stringify(config.corpus[subcommand], null, 2)}\n`);
        return;
      }
      const existedBefore = configExists(configPath);
      const config = configLoader(options.configPath);
      const result = modifyCorpusList(config, subcommand, action, positionals[2], { force: options.force });
      if (!result.changed) {
        stdout.write(`${result.note} No changes saved.\n`);
        return;
      }
      configSaver(result.config, configPath);
      stdout.write(`${result.note}\n`);
      stdout.write(`${formatApplyMessage({ configPath, existedBefore })} Corpus changes take effect at the next reindex (freshness watch/sweep or service restart).\n`);
      stdout.write(`Note: your config now stores the complete corpus.${subcommand} array; future updates to the built-in default list will not auto-apply to this install.\n`);
      return;
    }
    throw new Error(`Unknown config command: ${subcommand || '(missing)'}\n${usage()}`);
  }

  const config = configLoader(options.configPath);

  if (command === 'segment') {
    if (!options.session) throw new Error('segment requires --session <file.json>');
    const messages = readJsonArrayFile(options.session, 'session');
    const embedder = embedderFactory(config.embedder);
    const topicEngine = new TopicEngine({ embedder, config: config.topicEngine });
    const groups = await topicEngine.segment(messages);
    writeJson(stdout, groups);
    return;
  }

  if (command === 'node-search') {
    const key = normalizeRequiredOption(options.key, 'key');
    const k = options.k === undefined ? 5 : normalizePositiveInteger(options.k, 'k');
    const { writer, store } = createOfflineNodeWriter(config, { embedderFactory, storeFactory });
    try {
      const result = await writer.searchNeighbors({
        key,
        k,
        kind: options.kind || 'memory'
      });
      writeJson(stdout, result);
    } finally {
      store.close();
    }
    return;
  }

  if (command === 'node-apply') {
    const decision = nodeApplyDecision(options);
    const { writer, store } = createOfflineNodeWriter(config, { embedderFactory, storeFactory });
    try {
      const result = await writer.applyConsolidation(decision);
      writeJson(stdout, result);
    } finally {
      store.close();
    }
    return;
  }

  if (!config.enabled) {
    stderr.write('[recall] disabled in config\n');
    process.exitCode = 2;
    return;
  }

  if (command === 'index') {
    const result = await buildIndex(config);
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'query') {
    const query = positionals.join(' ').trim();
    if (!query) throw new Error('query text is required');
    const results = await queryIndex(config, query, { topK: options.topK });
    stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return;
  }

  if (command === 'retrieve') {
    const query = positionals.join(' ').trim();
    if (!query) throw new Error('retrieve text is required');
    const result = await retrieveMemory(config, query);
    stdout.write(`${result.additionalContext}\n`);
    return;
  }

  if (command === 'recall') {
    const query = positionals.join(' ').trim();
    if (!query) throw new Error('recall query text is required');
    const format = normalizeFormat(options.format);
    const results = await runRecallTool(config, query, {
      overrides: {
        topK: options.topK,
        bm25TopK: options.bm25TopK,
        maxTotalTokens: options.maxTotalTokens
      },
      fetchImpl,
      timeoutSignal,
      directRetrieve,
      stderr
    });
    const output = format === 'json'
      ? JSON.stringify(recallItems(results), null, 2)
      : formatRecallText(results);
    stdout.write(`${output}\n`);
    return;
  }

  if (command === 'toc') {
    const format = normalizeFormat(options.format);
    const toc = runTocTool(config, { tier: options.tier });
    const output = format === 'json'
      ? JSON.stringify(toc, null, 2)
      : formatTocText(toc, { full: options.full });
    stdout.write(`${output}\n`);
    return;
  }

  throw new Error(`Unknown command: ${command}\n${usage()}`);
}

function readJsonArrayFile(file, name) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to read ${name} JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${name} JSON must be an array`);
  }
  return parsed;
}

function createOfflineNodeWriter(config, { embedderFactory, storeFactory }) {
  const embedder = embedderFactory(config.embedder);
  const store = storeFactory(config.indexPath);
  store.initialize(embedder);
  return {
    store,
    writer: new NodeWriter({ store, embedder })
  };
}

function nodeApplyDecision(options) {
  const operation = String(options.op || '').trim().toUpperCase();
  if (!['CREATE', 'UPDATE', 'NOOP'].includes(operation)) {
    throw new Error('node-apply --op must be CREATE, UPDATE, or NOOP');
  }
  if (operation === 'CREATE') {
    return {
      operation,
      key: normalizeRequiredOption(options.key, 'key'),
      value: normalizeRequiredOption(options.value, 'value'),
      kind: options.kind || 'memory'
    };
  }
  if (operation === 'UPDATE') {
    return {
      operation,
      target_id: normalizeRequiredOption(options.targetId, 'target-id'),
      value: normalizeRequiredOption(options.value, 'value'),
      kind: options.kind || 'memory'
    };
  }
  return { operation, kind: options.kind || 'memory' };
}

function normalizeRequiredOption(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`--${name} must be non-empty`);
  }
  return value.trim();
}

function normalizePositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return number;
}

function writeJson(stdout, value) {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function normalizeFormat(value) {
  const format = value || 'text';
  if (!['text', 'json'].includes(format)) {
    throw new Error('format must be text or json');
  }
  return format;
}

export function isDirectCliInvocation(argvPath = process.argv[1], moduleUrl = import.meta.url) {
  if (!argvPath) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(argvPath)).href;
  } catch {
    return moduleUrl === pathToFileURL(argvPath).href;
  }
}

if (isDirectCliInvocation()) {
  runCli().catch(err => {
    console.error(`[recall] ${err.message}`);
    process.exit(1);
  });
}

export async function main() {
  return runCli();
}
