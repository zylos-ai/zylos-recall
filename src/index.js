#!/usr/bin/env node
/**
 * zylos-recall
 *
 * Proactive memory retrieval (RAG) — surfaces relevant memory into context each turn
 */

import { getConfig, watchConfig, DATA_DIR } from './lib/config.js';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createEmbedder } from './lib/embedders/index.js';
import { retrieveMemory } from './lib/retriever.js';
import { ChunkStore } from './lib/store.js';

let config = null;
let server = null;
let embedder = null;
let store = null;

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
  config = activeConfig;
  embedder = options.embedder || createEmbedder(activeConfig.embedder);
  store = options.store || new ChunkStore(activeConfig.indexPath);
  store.initialize(embedder);
  console.log('[recall] Warming embedder...');
  await embedder.embed(['warmup'], 'query');

  server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { ok: true, service: 'zylos-recall' });
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
  return server;
}

export async function restartRuntime(activeConfig, options = {}) {
  await stopRuntime();
  await startRuntime(activeConfig, options);
}

export async function stopRuntime() {
  if (server) {
    await new Promise(resolve => server.close(resolve));
    server = null;
  }
  if (store) {
    store.close();
    store = null;
  }
}

export async function handleRetrieve(req, res) {
  try {
    const body = await readJson(req);
    const query = String(body.query || '').trim();
    if (!query) {
      sendJson(res, 200, { ok: true, additionalContext: '' });
      return;
    }
    const result = await retrieveMemory(config, query, { embedder, store, storeInitialized: true });
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

function shutdown() {
  console.log(`[recall] Shutting down...`);
  if (server) server.close();
  if (store) store.close();
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  main().catch(err => {
    console.error(`[recall] Fatal error:`, err);
    process.exit(1);
  });
}
