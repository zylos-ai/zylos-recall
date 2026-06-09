#!/usr/bin/env node

import { getConfig } from './lib/config.js';
import { pathToFileURL } from 'node:url';

function readStdin(stream = process.stdin) {
  return new Promise((resolve, reject) => {
    let input = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => { input += chunk; });
    stream.on('end', () => resolve(input));
    stream.on('error', reject);
  });
}

export function extractPrompt(raw, argv) {
  const argText = argv.join(' ').trim();
  if (argText) return argText;
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed);
    return String(
      parsed.prompt ||
      parsed.userPrompt ||
      parsed.message ||
      parsed.input ||
      parsed.text ||
      ''
    ).trim();
  } catch {
    return trimmed;
  }
}

export function normalizePromptForRetrieval(prompt) {
  let text = String(prompt || '').trim();
  const currentMessage = text.match(/<current-message>\s*([\s\S]*?)\s*<\/current-message>/i);
  if (currentMessage) return currentMessage[1].trim();

  text = text.replace(/(?:^|\n)\s*----\s*reply via:\s*node\s+[\s\S]*$/i, '').trim();
  text = text.replace(/<replying-to>[\s\S]*?<\/replying-to>/gi, '').trim();
  text = text.replace(/^\s*\[[^\]]+\]\s+[\s\S]*?\bsaid:\s*/i, '').trim();
  return text;
}

export async function runRetrieveHook(options = {}) {
  try {
    const {
      argv = process.argv.slice(2),
      stdin = process.stdin,
      stdout = process.stdout,
      config = getConfig(),
      fetchImpl = globalThis.fetch,
      timeoutSignal = ms => AbortSignal.timeout(ms)
    } = options;

    if (!config.enabled) return false;
    const argPrompt = argv.join(' ').trim();
    const prompt = normalizePromptForRetrieval(argPrompt || extractPrompt(await readStdin(stdin), []));
    if (!isSubstantive(prompt)) return false;

    const response = await fetchImpl(`http://${config.service.host}:${config.service.port}/retrieve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: prompt }),
      signal: timeoutSignal(config.service.timeoutMs)
    });
    if (!response.ok) return false;
    const payload = await response.json();
    if (!payload?.additionalContext) return false;

    stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: payload.additionalContext
      }
    }));
    return true;
  } catch {
    // Fail open: hook errors must never block a user turn.
    return false;
  }
}

export function isSubstantive(prompt) {
  const trimmed = String(prompt || '').trim();
  if (/heartbeat check/i.test(trimmed)) return false;
  if (/^\s*(meanwhile,\s*)?context usage at/i.test(trimmed)) return false;
  if (/^\s*\[?scheduled task/i.test(trimmed)) return false;
  const words = trimmed.match(/[A-Za-z0-9_]+(?:[-'][A-Za-z0-9_]+)?/g) || [];
  if (trimmed.length < 12 && words.length < 3) return false;
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRetrieveHook();
}
