import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../src/lib/config.js';
import { collectCorpusChunks, walkCorpusFiles } from '../src/lib/corpus.js';

test('walks allowlisted markdown and applies hard deny rules', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-corpus-'));
  fs.mkdirSync(path.join(root, 'memory/reference'), { recursive: true });
  fs.mkdirSync(path.join(root, 'memory/sessions'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude/skills/example/references'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude/skills/example/references/node_modules/pkg'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspace/repo/docs/nested'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspace/repo/.backup/old'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspace/repo/.zylos/originals'), { recursive: true });
  fs.writeFileSync(path.join(root, 'memory/reference/decisions.md'), '# Decisions\n\nEnough words for an indexed durable decision chunk that should be included by the allowlist.');
  fs.writeFileSync(path.join(root, 'memory/reference/API-TOKEN.md'), '# Token\n\nThis convenience-denied token-like markdown file should not be indexed.');
  fs.writeFileSync(path.join(root, 'memory/sessions/current.md'), '# Session\n\nThis chronological session has current working context that should be indexed with a session metadata tier.');
  fs.writeFileSync(path.join(root, 'memory/sessions/2026-06-09.md'), '# Old Session\n\nThis older session should not be indexed because only current.md is allowed.');
  fs.writeFileSync(path.join(root, '.claude/skills/example/references/guide.md'), '# Guide\n\nSkill reference material has enough words to become a useful indexed chunk.');
  fs.writeFileSync(path.join(root, '.claude/skills/example/references/node_modules/pkg/README.md'), '# Dependency\n\nNode modules under references must remain excluded from indexing.');
  fs.writeFileSync(path.join(root, 'workspace/repo/docs/guide.md'), '# Docs\n\nWorkspace docs at the direct docs level should be indexed for project context.');
  fs.writeFileSync(path.join(root, 'workspace/repo/docs/nested/deep.md'), '# Deep Docs\n\nNested docs should not match the single-level docs allow pattern.');
  fs.writeFileSync(path.join(root, 'workspace/repo/CLAUDE.md'), '# Repo Instructions\n\nWorkspace repo Claude instructions should be indexed as project context.');
  fs.writeFileSync(path.join(root, 'workspace/repo/.backup/old/README.md'), '# Backup Readme\n\nBackup tree README files should stay excluded as stale duplicate content.');
  fs.writeFileSync(path.join(root, 'workspace/repo/.zylos/originals/CLAUDE.md'), '# Original Instructions\n\nZylos originals should stay excluded as stale duplicate content.');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Root Instructions\n\nRoot runtime instructions must stay excluded by the root-only deny pattern.');
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=secret');

  const config = structuredClone(DEFAULT_CONFIG);
  config.corpus.roots = [root];
  config.chunking.minTokens = 3;

  const files = [...walkCorpusFiles(config)]
    .map(entry => path.relative(root, entry.filePath).split(path.sep).join('/'))
    .sort();
  assert.deepEqual(files, [
    '.claude/skills/example/references/guide.md',
    'memory/reference/decisions.md',
    'memory/sessions/current.md',
    'workspace/repo/CLAUDE.md',
    'workspace/repo/docs/guide.md'
  ]);

  const { chunks } = collectCorpusChunks(config);
  assert.equal(chunks.find(chunk => chunk.source === 'memory/reference/decisions.md').metadata.type, 'memory');
  assert.equal(chunks.find(chunk => chunk.source === 'memory/sessions/current.md').metadata.type, 'session');
  assert.equal(chunks.find(chunk => chunk.source === '.claude/skills/example/references/guide.md').metadata.type, 'skill');
  assert.equal(chunks.find(chunk => chunk.source === 'workspace/repo/docs/guide.md').metadata.type, 'doc');
});
