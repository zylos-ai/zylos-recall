#!/usr/bin/env node
/**
 * zylos-recall
 *
 * Proactive memory retrieval (RAG) — surfaces relevant memory into context each turn
 */

import { getConfig, watchConfig, DATA_DIR } from './lib/config.js';

// Initialize
console.log(`[recall] Starting...`);
console.log(`[recall] Data directory: ${DATA_DIR}`);

// Load configuration
let config = getConfig();
console.log(`[recall] Config loaded, enabled: ${config.enabled}`);

if (!config.enabled) {
  console.log(`[recall] Component disabled in config, exiting.`);
  process.exit(0);
}

// Watch for config changes
watchConfig((newConfig) => {
  console.log(`[recall] Config reloaded`);
  config = newConfig;
  if (!newConfig.enabled) {
    console.log(`[recall] Component disabled, stopping...`);
    shutdown();
  }
});

async function main() {
  console.log('[recall] R1 indexer component ready. Run `zylos-recall index` to build the local chunk index.');
}

// Graceful shutdown
function shutdown() {
  console.log(`[recall] Shutting down...`);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Run
main().catch(err => {
  console.error(`[recall] Fatal error:`, err);
  process.exit(1);
});
