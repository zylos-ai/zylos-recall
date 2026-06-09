import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkMarkdownDocument } from '../src/lib/chunker.js';

test('chunks markdown by section with bounded open metadata', () => {
  const stats = { mtimeMs: Date.parse('2026-06-09T00:00:00Z') };
  const text = `# Decision Log

This section has enough durable memory content to become a chunk. It describes a current project decision with enough words to pass the minimum token threshold in the semantic chunker.

## Follow Up

This second section also has enough durable memory content to become a chunk. It should keep the source and section as typed fields while the metadata blob stays open and minimal for v1.`;

  const chunks = chunkMarkdownDocument({
    filePath: '/tmp/zylos/memory/reference/decisions.md',
    rootPath: '/tmp/zylos',
    text,
    stats
  }, {
    targetTokens: 40,
    minTokens: 10,
    maxTokens: 80,
    overlapRatio: 0.15
  });

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].source, 'memory/reference/decisions.md');
  assert.equal(chunks[0].section, 'Decision Log');
  assert.deepEqual(Object.keys(chunks[0].metadata).sort(), ['date', 'type']);
  assert.equal(chunks[0].metadata.type, 'memory');
});

test('keeps section chunk ids stable when unrelated sections are inserted', () => {
  const stats = { mtimeMs: Date.parse('2026-06-09T00:00:00Z') };
  const rootPath = '/tmp/zylos';
  const filePath = '/tmp/zylos/memory/reference/projects.md';
  const options = {
    targetTokens: 40,
    minTokens: 5,
    maxTokens: 80,
    overlapRatio: 0.15
  };
  const alpha = `# Alpha

Alpha project memory has durable details that should remain the same chunk.`;
  const beta = `# Beta

Beta project memory has durable details that should keep the same chunk id.`;

  const before = chunkMarkdownDocument({ filePath, rootPath, text: `${alpha}\n\n${beta}`, stats }, options);
  const after = chunkMarkdownDocument({
    filePath,
    rootPath,
    text: `# Inserted

Inserted section has durable details but should not renumber the later sections.

${alpha}

${beta}`,
    stats
  }, options);

  assert.equal(after.find(chunk => chunk.section === 'Alpha').id, before.find(chunk => chunk.section === 'Alpha').id);
  assert.equal(after.find(chunk => chunk.section === 'Beta').id, before.find(chunk => chunk.section === 'Beta').id);
});

test('distinguishes duplicate headings without global ordinal ids', () => {
  const stats = { mtimeMs: Date.parse('2026-06-09T00:00:00Z') };
  const chunks = chunkMarkdownDocument({
    filePath: '/tmp/zylos/memory/reference/decisions.md',
    rootPath: '/tmp/zylos',
    text: `# Decision

First decision memory has enough durable content for the semantic chunker.

# Decision

Second decision memory has different durable content for the semantic chunker.`,
    stats
  }, {
    targetTokens: 40,
    minTokens: 5,
    maxTokens: 80,
    overlapRatio: 0.15
  });

  assert.equal(chunks.length, 2);
  assert.notEqual(chunks[0].id, chunks[1].id);
});

test('splits oversized dense bullet sections at semantic list boundaries', () => {
  const stats = { mtimeMs: Date.parse('2026-06-09T00:00:00Z') };
  const chunks = chunkMarkdownDocument({
    filePath: '/tmp/zylos/memory/reference/projects.md',
    rootPath: '/tmp/zylos',
    text: `### zylos-ms-teams Omnibus Entry
- **Status:** active public component with durable release state and owner-facing operational notes.
- **Auth:** custom JWT validation with pre-parse rejection and tenant-aware credential handling.
- **Conversation store:** file-locking for concurrency, a 1000-entry cap, LRU eviction, and 365-day retention limits.
  - Stored conversation references keep the service URL for follow-up replies.
- **Admin CLI:** add-team, remove-team, set-mention, and list-teams commands for operators.
- **Outbound:** group sends use a conversation-specific service URL from the stored reference.
- **Known issues:** legacy-domain DNS parking and reaction indicators still need catalog identifiers.`,
    stats
  }, {
    targetTokens: 24,
    minTokens: 8,
    maxTokens: 34,
    overlapRatio: 0.15
  });

  const conversation = chunks.find(chunk => chunk.text.includes('Conversation store'));
  assert.ok(conversation, 'buried conversation-store fact should be indexed');
  assert.match(conversation.text, /1000-entry cap/);
  assert.match(conversation.text, /365-day retention/);
  assert.match(conversation.text, /Stored conversation references/);
  assert.doesNotMatch(conversation.text, /Admin CLI/);
  assert.doesNotMatch(conversation.text, /Outbound/);
});

test('splits dense multi-topic sections even when below max tokens', () => {
  const stats = { mtimeMs: Date.parse('2026-06-09T00:00:00Z') };
  const text = `### zylos-ms-teams Omnibus Entry
- **Status:** active public component with durable release state and owner-facing operational notes.
- **Auth:** custom JWT validation with pre-parse rejection and tenant-aware credential handling.
- **Conversation store:** file-locking for concurrency, a 1000-entry cap, LRU eviction, and 365-day retention limits.
  - Stored conversation references keep the service URL for follow-up replies.
- **Admin CLI:** add-team, remove-team, set-mention, and list-teams commands for operators.
- **Outbound:** group sends use a conversation-specific service URL from the stored reference.
- **Known issues:** legacy-domain DNS parking and reaction indicators still need catalog identifiers.`;
  const chunks = chunkMarkdownDocument({
    filePath: '/tmp/zylos/memory/reference/projects.md',
    rootPath: '/tmp/zylos',
    text,
    stats
  }, {
    targetTokens: 24,
    minTokens: 8,
    maxTokens: 500,
    overlapRatio: 0.15
  });

  assert.ok(chunks.length > 1, 'dense multi-topic section should split before max-token fallback');
  assert.ok(chunks.every(chunk => chunk.tokenCount < 500), 'test fixture must stay below maxTokens');
  assert.equal(chunks.some(chunk => chunk.text === text), false, 'under-max section should not remain one diluted chunk');

  const conversation = chunks.find(chunk => chunk.text.includes('Conversation store'));
  assert.ok(conversation, 'buried conversation-store fact should be indexed');
  assert.match(conversation.text, /1000-entry cap/);
  assert.match(conversation.text, /365-day retention/);
  assert.match(conversation.text, /Stored conversation references/);
  assert.doesNotMatch(conversation.text, /Admin CLI/);
  assert.doesNotMatch(conversation.text, /Outbound/);
});

test('keeps small atomic sections unchanged', () => {
  const stats = { mtimeMs: Date.parse('2026-06-09T00:00:00Z') };
  const text = `### Atomic Decision

This small atomic section has one focused decision with enough durable context to index as a single unchanged chunk.`;
  const chunks = chunkMarkdownDocument({
    filePath: '/tmp/zylos/memory/reference/decisions.md',
    rootPath: '/tmp/zylos',
    text,
    stats
  }, {
    targetTokens: 24,
    minTokens: 8,
    maxTokens: 80,
    overlapRatio: 0.15
  });

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, text);
});

test('coalesces tiny semantic list items instead of emitting slivers', () => {
  const stats = { mtimeMs: Date.parse('2026-06-09T00:00:00Z') };
  const chunks = chunkMarkdownDocument({
    filePath: '/tmp/zylos/memory/reference/projects.md',
    rootPath: '/tmp/zylos',
    text: `### Tiny Status List
- Alpha ready.
- Beta queued.
- Gamma blocked.
- Delta shipped.
- Epsilon archived.
- Zeta pending.
- Eta reviewed.
- Theta closed.`,
    stats
  }, {
    targetTokens: 10,
    minTokens: 6,
    maxTokens: 12,
    overlapRatio: 0.15
  });

  assert.ok(chunks.length > 1, 'oversized tiny list should still split');
  assert.ok(chunks.every(chunk => chunk.tokenCount >= 6), 'tiny items should be coalesced above minTokens');
  assert.ok(chunks.some(chunk => chunk.text.includes('Beta queued') && chunk.text.includes('Gamma blocked')));
});
