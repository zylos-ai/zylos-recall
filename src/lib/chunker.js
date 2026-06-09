import path from 'node:path';
import { sha256, shortHash } from './hash.js';

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

export function estimateTokens(text) {
  if (!text) return 0;
  const latinWords = text.match(/[A-Za-z0-9_]+(?:[-'][A-Za-z0-9_]+)?/g) || [];
  const cjkChars = text.match(/[\u3400-\u9fff]/g) || [];
  const other = Math.ceil(text.replace(/[A-Za-z0-9_\s\u3400-\u9fff'-]/g, '').length / 3);
  return latinWords.length + cjkChars.length + other;
}

function slugify(value) {
  const slug = value
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'root';
}

function splitMarkdownSections(text) {
  const sections = [];
  let current = { heading: 'root', level: 0, lines: [] };

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(HEADING_RE);
    if (match && current.lines.some(existing => existing.trim())) {
      sections.push(current);
      current = { heading: match[2].trim(), level: match[1].length, lines: [line] };
    } else if (match && !current.lines.some(existing => existing.trim())) {
      current = { heading: match[2].trim(), level: match[1].length, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }

  if (current.lines.some(line => line.trim())) sections.push(current);
  return sections;
}

function splitOversizedSection(section, options) {
  const targetTokens = options.targetTokens;
  const maxTokens = options.maxTokens;
  const overlapTokens = Math.max(0, Math.floor(targetTokens * options.overlapRatio));
  const paragraphs = section.lines.join('\n').split(/\n{2,}/);
  const chunks = [];
  let current = [];
  let currentTokens = 0;

  for (const paragraph of paragraphs) {
    const paragraphTokens = estimateTokens(paragraph);
    if (current.length && currentTokens + paragraphTokens > maxTokens) {
      chunks.push(current.join('\n\n').trim());
      const overlap = [];
      let tokenCount = 0;
      for (let i = current.length - 1; i >= 0; i -= 1) {
        const candidate = current[i];
        tokenCount += estimateTokens(candidate);
        if (tokenCount > overlapTokens) break;
        overlap.unshift(candidate);
      }
      current = overlap;
      currentTokens = estimateTokens(current.join('\n\n'));
    }

    if (paragraphTokens > maxTokens) {
      const words = paragraph.split(/\s+/).filter(Boolean);
      for (let i = 0; i < words.length; i += targetTokens) {
        chunks.push(words.slice(i, i + maxTokens).join(' '));
      }
      current = [];
      currentTokens = 0;
      continue;
    }

    current.push(paragraph);
    currentTokens += paragraphTokens;
  }

  if (current.length) chunks.push(current.join('\n\n').trim());
  return chunks.filter(Boolean);
}

export function inferChunkMetadata(filePath, rootPath, stats) {
  const normalized = filePath.split(path.sep).join('/');
  const relative = path.relative(rootPath, filePath).split(path.sep).join('/');
  let type = 'doc';

  if (relative.startsWith('memory/reference/') || relative.startsWith('memory/users/')) type = 'memory';
  else if (relative.startsWith('http/public/pages/')) type = 'page';
  else if (relative.startsWith('.claude/skills/')) type = 'skill';

  const dateMatch = normalized.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  const date = dateMatch?.[1] || new Date(stats.mtimeMs).toISOString().slice(0, 10);
  return { date, type };
}

export function chunkMarkdownDocument({ filePath, rootPath, text, stats }, options) {
  const chunks = [];
  const sections = splitMarkdownSections(text);
  const metadata = inferChunkMetadata(filePath, rootPath, stats);
  let ordinal = 0;

  for (const section of sections) {
    const sectionText = section.lines.join('\n').trim();
    if (!sectionText) continue;

    const parts =
      estimateTokens(sectionText) > options.maxTokens
        ? splitOversizedSection(section, options)
        : [sectionText];

    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const part = parts[partIndex].trim();
      const tokenCount = estimateTokens(part);
      if (!part || tokenCount < options.minTokens) continue;

      const sectionSlug = slugify(section.heading);
      const source = path.relative(rootPath, filePath).split(path.sep).join('/');
      chunks.push({
        id: shortHash(`${source}:${sectionSlug}:${ordinal}`),
        text: part,
        source,
        section: section.heading,
        hash: sha256(part),
        mtime: Math.floor(stats.mtimeMs),
        tokenCount,
        embeddings: [],
        metadata
      });
      ordinal += 1;
    }
  }

  return chunks;
}
