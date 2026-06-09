import fs from 'node:fs';
import path from 'node:path';
import { minimatch } from 'minimatch';
import { chunkMarkdownDocument } from './chunker.js';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown']);

function normalizeForMatch(value) {
  return value.split(path.sep).join('/');
}

function matchesAny(candidate, patterns) {
  return patterns.some(pattern => minimatch(candidate, pattern, { dot: true, nocase: true }));
}

function shouldSkipDir(name) {
  return name === '.git' || name === 'node_modules';
}

function isAllowed(filePath, rootPath, corpusConfig) {
  const relative = normalizeForMatch(path.relative(rootPath, filePath));
  const absolute = normalizeForMatch(filePath);
  if (matchesAny(relative, corpusConfig.deny) || matchesAny(absolute, corpusConfig.deny)) return false;
  return matchesAny(relative, corpusConfig.allow) || matchesAny(absolute, corpusConfig.allow);
}

export function* walkCorpusFiles(config) {
  for (const root of config.corpus.roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const current = stack.pop();
      const stats = fs.lstatSync(current);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        if (current !== root && shouldSkipDir(path.basename(current))) continue;
        for (const entry of fs.readdirSync(current)) {
          stack.push(path.join(current, entry));
        }
        continue;
      }
      if (!stats.isFile()) continue;
      if (!MARKDOWN_EXTENSIONS.has(path.extname(current).toLowerCase())) continue;
      if (stats.size > config.corpus.maxFileBytes) continue;
      if (!isAllowed(current, root, config.corpus)) continue;
      yield { filePath: current, rootPath: root, stats };
    }
  }
}

export function collectCorpusChunks(config) {
  const chunks = [];
  const files = [];
  for (const entry of walkCorpusFiles(config)) {
    const text = fs.readFileSync(entry.filePath, 'utf8');
    const document = { ...entry, text };
    const documentChunks = chunkMarkdownDocument(document, config.chunking);
    chunks.push(...documentChunks);
    files.push({
      source: path.relative(entry.rootPath, entry.filePath).split(path.sep).join('/'),
      chunks: documentChunks.length
    });
  }
  chunks.sort((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
  files.sort((a, b) => a.source.localeCompare(b.source));
  return { chunks, files };
}

export function collectCorpusSignature(config) {
  const files = [];
  for (const entry of walkCorpusFiles(config)) {
    files.push({
      source: path.relative(entry.rootPath, entry.filePath).split(path.sep).join('/'),
      mtimeMs: Math.floor(entry.stats.mtimeMs),
      size: entry.stats.size
    });
  }
  files.sort((a, b) => a.source.localeCompare(b.source));
  return JSON.stringify(files);
}
