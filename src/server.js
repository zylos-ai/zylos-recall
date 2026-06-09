#!/usr/bin/env node

import { main, shutdown } from './index.js';

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch(err => {
  console.error(`[recall] Fatal error:`, err);
  process.exit(1);
});
