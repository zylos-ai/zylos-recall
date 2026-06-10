import fs from 'node:fs';
import { DEFAULT_CONFIG } from './config.js';

export const SETTABLE_CONFIG_PATHS = Object.freeze([
  'enabled',
  'retrieval.topK',
  'retrieval.bm25TopK',
  'retrieval.rrfK',
  'retrieval.bm25AdmitTopN',
  'retrieval.threshold',
  'retrieval.maxTotalTokens',
  'retrieval.recencyWeight',
  'retrieval.tierPenalties.<tier>',
  'filter.provider',
  'filter.threshold',
  'filter.keepK',
  'service.timeoutMs'
]);

const EXACT_SETTERS = new Set(SETTABLE_CONFIG_PATHS.filter(path => !path.includes('<')));
const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

export const CORPUS_LIST_NAMES = Object.freeze(['allow', 'deny']);

// Default deny entries that exist to keep secrets and private memory out of
// the index. `config deny remove` refuses these unless --force is given.
export const PROTECTED_DENY_PATTERNS = Object.freeze(
  DEFAULT_CONFIG.corpus.deny.filter(pattern =>
    /secret|token|credential|password|apikey|api[-_]key|private[-_]?key|\.env|\.pem$|\.key$|identity\.md|state\.md|references\.md/i.test(pattern)
  )
);

export function isProtectedDenyPattern(pattern) {
  const normalized = String(pattern || '').toLowerCase();
  return PROTECTED_DENY_PATTERNS.some(entry => entry.toLowerCase() === normalized);
}

export function modifyCorpusList(config, listName, action, pattern, { force = false } = {}) {
  if (!CORPUS_LIST_NAMES.includes(listName)) {
    throw new Error(`Unknown corpus list "${listName}". Use allow or deny.`);
  }
  const value = String(pattern || '').trim();
  if (!value) throw new Error(`A non-empty glob pattern is required for corpus.${listName}`);

  const next = structuredClone(config);
  const list = next.corpus[listName];
  const index = list.findIndex(entry => entry.toLowerCase() === value.toLowerCase());

  if (action === 'add') {
    if (index >= 0) {
      return { config: next, changed: false, note: `Pattern already present in corpus.${listName}: ${list[index]}` };
    }
    list.push(value);
    return { config: next, changed: true, note: `Added "${value}" to corpus.${listName} (${list.length} entries).` };
  }

  if (action === 'remove') {
    if (index < 0) {
      return { config: next, changed: false, note: `Pattern not found in corpus.${listName}: ${value}` };
    }
    if (listName === 'deny' && isProtectedDenyPattern(value) && !force) {
      throw new Error(
        `"${value}" is a built-in secret-protection deny pattern; removing it can expose credential-like files to indexing. ` +
        'Re-run with --force if you really intend this.'
      );
    }
    list.splice(index, 1);
    return { config: next, changed: true, note: `Removed "${value}" from corpus.${listName} (${list.length} entries).` };
  }

  throw new Error(`Unknown corpus list action "${action || '(missing)'}". Use add, remove, or list.`);
}
export function getConfigValue(config, dotPath = null) {
  if (!dotPath) return config;
  const { parent, key } = locateParent(config, dotPath, { requireExisting: true });
  return parent[key];
}

export function setConfigValue(config, dotPath, rawValue) {
  assertSettablePath(dotPath);
  const next = structuredClone(config);
  const { parent, key, current } = locateParent(next, dotPath, {
    requireExisting: !isTierPenaltyPath(dotPath)
  });
  parent[key] = parseConfigValue(dotPath, rawValue, current);
  return next;
}

export function assertSettablePath(dotPath) {
  if (EXACT_SETTERS.has(dotPath) || isTierPenaltyPath(dotPath)) return;
  throw new Error(
    `Config path "${dotPath}" is not settable. Settable paths: ${SETTABLE_CONFIG_PATHS.join(', ')}`
  );
}

export function parseConfigValue(dotPath, rawValue, currentValue) {
  if (dotPath === 'enabled') return parseBoolean(rawValue);
  if (dotPath === 'filter.provider') return String(rawValue);
  if (isTierPenaltyPath(dotPath) || typeof currentValue === 'number') {
    return parseNumber(rawValue, dotPath);
  }
  if (typeof currentValue === 'boolean') return parseBoolean(rawValue);
  if (typeof currentValue === 'string') return String(rawValue);
  throw new Error(`Config path "${dotPath}" does not have a supported scalar type`);
}

export function formatApplyMessage({ configPath, existedBefore }) {
  if (existedBefore) {
    return [
      `Saved ${configPath}.`,
      'Running zylos-recall services watch the config directory, reload this config once after duplicate file-change events settle, and restart runtime.',
      'The hook client reads service.timeoutMs from config on each turn, so that timeout changes immediately for new hook calls.'
    ].join(' ');
  }
  return [
    `Saved ${configPath}.`,
    'Running zylos-recall services watch the config directory, so creating this file is applied after the file-change event.',
    'The hook client reads service.timeoutMs from config on each turn, so that timeout changes immediately for new hook calls.'
  ].join(' ');
}

export function configFileExisted(configPath) {
  return fs.existsSync(configPath);
}

export function sensitiveConfigKeyPaths(config = DEFAULT_CONFIG) {
  const paths = [];
  collectSensitiveKeys(config, [], paths);
  return paths;
}

function locateParent(config, dotPath, { requireExisting }) {
  const segments = pathSegments(dotPath);
  let parent = config;
  for (const segment of segments.slice(0, -1)) {
    if (!parent || typeof parent !== 'object' || Array.isArray(parent)) {
      throw new Error(`Config path "${dotPath}" does not exist`);
    }
    if (!(segment in parent)) {
      if (requireExisting) throw new Error(`Config path "${dotPath}" does not exist`);
      parent[segment] = {};
    }
    parent = parent[segment];
  }

  const key = segments.at(-1);
  if (!parent || typeof parent !== 'object' || Array.isArray(parent)) {
    throw new Error(`Config path "${dotPath}" does not exist`);
  }
  if (requireExisting && !(key in parent)) {
    throw new Error(`Config path "${dotPath}" does not exist`);
  }
  return { parent, key, current: parent[key] };
}

function pathSegments(dotPath) {
  const segments = String(dotPath || '').split('.');
  if (!segments.length || segments.some(segment => !segment || UNSAFE_PATH_SEGMENTS.has(segment))) {
    throw new Error(`Invalid config path: ${dotPath}`);
  }
  return segments;
}

function isTierPenaltyPath(dotPath) {
  const segments = String(dotPath || '').split('.');
  return (
    segments.length === 3 &&
    segments[0] === 'retrieval' &&
    segments[1] === 'tierPenalties' &&
    Boolean(segments[2]) &&
    !UNSAFE_PATH_SEGMENTS.has(segments[2])
  );
}

function parseBoolean(rawValue) {
  if (rawValue === true || rawValue === 'true') return true;
  if (rawValue === false || rawValue === 'false') return false;
  throw new Error(`Expected boolean value "true" or "false", got "${rawValue}"`);
}

function parseNumber(rawValue, dotPath) {
  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    throw new Error(`Expected numeric value for ${dotPath}, got "${rawValue}"`);
  }
  return value;
}

function collectSensitiveKeys(value, prefix, paths) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...prefix, key];
    if (isSensitiveKey(key)) paths.push(nextPath.join('.'));
    collectSensitiveKeys(child, nextPath, paths);
  }
}

function isSensitiveKey(key) {
  const normalized = String(key).replace(/[_-]/g, '').toLowerCase();
  if (
    normalized.includes('apikey') ||
    normalized.includes('secret') ||
    normalized.includes('password') ||
    normalized.includes('credential') ||
    normalized.includes('privatekey')
  ) {
    return true;
  }
  return normalized.includes('token') && !normalized.endsWith('tokens');
}
