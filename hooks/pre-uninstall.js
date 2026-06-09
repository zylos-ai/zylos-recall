#!/usr/bin/env node
/**
 * Pre-uninstall hook for zylos-recall.
 *
 * Removes the UserPromptSubmit hook registered by post-install/post-upgrade.
 */

import { removeRecallHook } from '../src/lib/settings-hooks.js';

try {
  console.log('[pre-uninstall] Removing recall UserPromptSubmit hook...');
  removeRecallHook();
  console.log('[pre-uninstall] Complete.');
} catch (err) {
  console.error(`[pre-uninstall] ${err.message}`);
  process.exit(1);
}
