import path from 'node:path';
import { sha256, shortHash } from './hash.js';

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const LIST_MARKER_RE = /^(\s*)(?:[-*+]\s+|\d+[.)]\s+)/;
const BOLD_LABEL_RE = /^(\s*)(?:(?:[-*+]\s+|\d+[.)]\s+))?\*\*[^*\n]{1,120}:\*\*/;

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

function splitSemanticSection(section, options) {
  const maxTokens = options.maxTokens;
  const units = semanticUnits(section.lines);
  const chunks = [];

  let pending = [];

  function pendingText() {
    return pending.join('\n\n').trim();
  }

  function flushPending({ final = false } = {}) {
    const text = pendingText();
    if (text) {
      if (final && estimateTokens(text) < options.minTokens && chunks.length) {
        const combined = `${chunks[chunks.length - 1]}\n\n${text}`;
        if (estimateTokens(combined) <= maxTokens) chunks[chunks.length - 1] = combined;
        else chunks.push(text);
      } else {
        chunks.push(text);
      }
    }
    pending = [];
  }

  function appendPending(unit) {
    if (!unit) return;
    const candidate = [...pending, unit].join('\n\n').trim();
    if (pending.length && estimateTokens(candidate) > maxTokens) flushPending();
    pending.push(unit);
  }

  for (const unit of units) {
    const unitTokens = estimateTokens(unit);

    if (unitTokens > maxTokens) {
      flushPending();
      chunks.push(...splitLongText(unit, options));
      continue;
    }

    if (unitTokens < options.minTokens) {
      appendPending(unit);
      if (estimateTokens(pendingText()) >= options.minTokens) flushPending();
      continue;
    }

    if (pending.length) {
      const combined = [...pending, unit].join('\n\n').trim();
      if (estimateTokens(pendingText()) < options.minTokens && estimateTokens(combined) <= maxTokens) {
        chunks.push(combined);
        pending = [];
        continue;
      }
      flushPending();
    }

    chunks.push(unit);
  }

  flushPending({ final: true });
  return chunks.filter(Boolean);
}

function shouldSplitSectionSemantically(section, sectionTokens, options) {
  if (sectionTokens > options.maxTokens) return true;

  let topLevelListItems = 0;
  let boldLabels = 0;

  for (const line of section.lines) {
    if (isTopLevelListItem(line)) topLevelListItems += 1;
    if (isBoldLabelBoundary(line)) boldLabels += 1;
  }

  if (boldLabels >= 2 && topLevelListItems >= 3) return true;
  return topLevelListItems >= 3 && sectionTokens > options.targetTokens;
}

function semanticUnits(lines) {
  const units = [];
  let current = [];
  let previousBlank = false;

  for (const line of lines) {
    const boundary =
      current.length > 0 &&
      line.trim() &&
      (
        previousBlank ||
        HEADING_RE.test(line) ||
        isBoldLabelBoundary(line) ||
        isTopLevelListItem(line)
      );

    if (boundary) {
      units.push(current.join('\n').trim());
      current = [];
    }

    current.push(line);
    previousBlank = !line.trim();
  }

  if (current.some(line => line.trim())) units.push(current.join('\n').trim());
  return units.filter(Boolean);
}

function isTopLevelListItem(line) {
  const match = line.match(LIST_MARKER_RE);
  return Boolean(match && match[1].length === 0);
}

function isBoldLabelBoundary(line) {
  const match = line.match(BOLD_LABEL_RE);
  return Boolean(match && match[1].length === 0);
}

function splitLongText(text, options) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < words.length; i += options.targetTokens) {
    chunks.push(words.slice(i, i + options.maxTokens).join(' '));
  }
  return chunks;
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
  const sectionOccurrences = new Map();

  for (const section of sections) {
    const sectionText = section.lines.join('\n').trim();
    if (!sectionText) continue;

    const sectionTokens = estimateTokens(sectionText);
    const parts = shouldSplitSectionSemantically(section, sectionTokens, options)
      ? splitSemanticSection(section, options)
      : [sectionText];
    const sectionSlug = slugify(section.heading);
    const occurrence = sectionOccurrences.get(sectionSlug) || 0;
    sectionOccurrences.set(sectionSlug, occurrence + 1);

    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const part = parts[partIndex].trim();
      const tokenCount = estimateTokens(part);
      if (!part || tokenCount < options.minTokens) continue;

      const source = path.relative(rootPath, filePath).split(path.sep).join('/');
      chunks.push({
        id: shortHash(`${source}:${sectionSlug}:${occurrence}:${partIndex}`),
        text: part,
        source,
        section: section.heading,
        hash: sha256(part),
        mtime: Math.floor(stats.mtimeMs),
        tokenCount,
        embeddings: [],
        metadata
      });
    }
  }

  return chunks;
}
