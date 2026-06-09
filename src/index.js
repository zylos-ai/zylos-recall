#!/usr/bin/env node
/**
 * zylos-recall
 *
 * Proactive memory retrieval (RAG) — surfaces relevant memory into context each turn
 */

import { getConfig, watchConfig, DATA_DIR } from './lib/config.js';
import http from 'node:http';
import { createEmbedder } from './lib/embedders/index.js';
import { FreshnessManager } from './lib/freshness.js';
import { appendRetrievalLog } from './lib/retrieval-log.js';
import { retrieveMemory } from './lib/retriever.js';
import { ChunkStore } from './lib/store.js';

let config = null;
let server = null;
let embedder = null;
let store = null;
let freshness = null;
let runtimeGeneration = 0;
let runtimeState = {
  ready: false,
  warming: false,
  warmError: null,
  freshnessStarted: false,
  freshnessError: null
};

export async function main() {
  console.log('[recall] Starting...');
  console.log(`[recall] Data directory: ${DATA_DIR}`);

  config = getConfig();
  console.log(`[recall] Config loaded, enabled: ${config.enabled}`);

  if (!config.enabled) {
    console.log('[recall] Component disabled in config, exiting.');
    process.exit(0);
  }

  await startRuntime(config);
  watchConfig(async (newConfig) => {
    console.log('[recall] Config reloaded');
    config = newConfig;
    if (!newConfig.enabled) {
      console.log('[recall] Component disabled, stopping...');
      shutdown();
      return;
    }
    await restartRuntime(config);
  });
}

export async function startRuntime(activeConfig, options = {}) {
  const generation = runtimeGeneration + 1;
  runtimeGeneration = generation;
  config = activeConfig;
  embedder = options.embedder || createEmbedder(activeConfig.embedder);
  store = options.store || new ChunkStore(activeConfig.indexPath);
  store.initialize(embedder);
  freshness = options.freshness || new FreshnessManager(activeConfig, { embedder, store });
  runtimeState = {
    ready: false,
    warming: true,
    warmError: null,
    freshnessStarted: false,
    freshnessError: null
  };

  server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { ok: true, service: 'zylos-recall', ...runtimeState });
      return;
    }
    if (req.method === 'POST' && req.url === '/retrieve') {
      await handleRetrieve(req, res);
      return;
    }
    sendJson(res, 404, { ok: false, error: 'not_found' });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(activeConfig.service.port, activeConfig.service.host, resolve);
  });
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : activeConfig.service.port;
  console.log(`[recall] Service listening on ${activeConfig.service.host}:${boundPort}`);
  startBackgroundRuntime(generation);
  return server;
}

export async function restartRuntime(activeConfig, options = {}) {
  await stopRuntime();
  await startRuntime(activeConfig, options);
}

export async function stopRuntime() {
  runtimeGeneration += 1;
  if (freshness) {
    await freshness.stop();
    freshness = null;
  }
  if (server) {
    await new Promise(resolve => server.close(resolve));
    server = null;
  }
  if (store) {
    store.close();
    store = null;
  }
  runtimeState.ready = false;
}

export async function handleRetrieve(req, res) {
  const started = Date.now();
  try {
    const body = await readJson(req);
    const query = String(body.query || '').trim();
    if (!query) {
      sendJson(res, 200, { ok: true, additionalContext: '' });
      return;
    }
    if (!runtimeState.ready) {
      sendJson(res, 200, { ok: true, additionalContext: '' });
      return;
    }
    const result = await retrieveMemory(config, query, { embedder, store, storeInitialized: true });
    try {
      appendRetrievalLog(config, {
        query,
        selected: result.selected,
        durationMs: Date.now() - started,
        injected: Boolean(result.additionalContext)
      });
    } catch (err) {
      console.error(`[recall] retrieval log failed: ${err.message}`);
    }
    sendJson(res, 200, {
      ok: true,
      additionalContext: result.additionalContext,
      selected: result.selected.map(candidate => ({
        id: candidate.id,
        source: candidate.source,
        score: candidate.score,
        finalScore: candidate.finalScore
      }))
    });
  } catch (err) {
    console.error(`[recall] retrieve failed: ${err.message}`);
    sendJson(res, 200, { ok: true, additionalContext: '' });
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let input = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      input += chunk;
      if (input.length > 64 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!input.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(input));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

export function shutdown() {
  console.log(`[recall] Shutting down...`);
  if (server) server.close();
  if (freshness) freshness.stop();
  if (store) store.close();
  process.exit(0);
}

async function startBackgroundRuntime(generation) {
  try {
    console.log('[recall] Warming embedder...');
    await embedder.embed(['warmup'], 'query');
    if (generation !== runtimeGeneration) return;
    runtimeState.warming = false;
    runtimeState.ready = true;
    console.log('[recall] Embedder warm.');
  } catch (err) {
    if (generation !== runtimeGeneration) return;
    runtimeState.warming = false;
    runtimeState.warmError = err.message;
    console.error(`[recall] Embedder warm failed: ${err.message}`);
  }

  try {
    if (generation !== runtimeGeneration) return;
    await freshness.start();
    if (generation !== runtimeGeneration) return;
    runtimeState.freshnessStarted = true;
  } catch (err) {
    if (generation !== runtimeGeneration) return;
    runtimeState.freshnessError = err.message;
    console.error(`[recall] Freshness start failed: ${err.message}`);
  }
}
