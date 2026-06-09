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

// Main component logic
async function main() {
  // TODO: Implement your component logic here
  //
  // Communication components: set up platform SDK, listen for events, forward to C4
  // Capability components: start HTTP server or other service interface
  // Utility components: run task and exit (remove the keepalive below)

  console.log(`[recall] Running`);
}

// Graceful shutdown
function shutdown() {
  console.log(`[recall] Shutting down...`);
  // TODO: Close connections, stop listeners, cleanup
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Run
main().catch(err => {
  console.error(`[recall] Fatal error:`, err);
  process.exit(1);
});
