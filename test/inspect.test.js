import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  inspectSession, formatInspection, promptText, cleanPrompt, isRetrievedMemory, injectionSources
} from '../src/inspect.js';

function writeTranscript(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-inspect-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n'));
  return file;
}

test('promptText skips tool results and meta, returns text otherwise', () => {
  assert.equal(promptText({ message: { content: 'hello' } }), 'hello');
  assert.equal(promptText({ isMeta: true, message: { content: 'meta' } }), null);
  assert.equal(promptText({ message: { content: [{ type: 'tool_result', content: 'x' }] } }), null);
  assert.equal(promptText({ message: { content: [{ type: 'text', text: 'hi' }] } }), 'hi');
});

test('cleanPrompt strips the C4 envelope down to the human words', () => {
  const raw = '[DISCORD DM] felix said: <current-message>do the thing</current-message> ---- reply via: node x.js';
  assert.equal(cleanPrompt(raw), 'do the thing');
  assert.equal(cleanPrompt('plain text'), 'plain text');
});

test('isRetrievedMemory only matches recall hook attachments', () => {
  assert.ok(isRetrievedMemory({ type: 'attachment', attachment: { type: 'hook_additional_context', content: ['<retrieved-memory>x</retrieved-memory>'] } }));
  assert.ok(!isRetrievedMemory({ type: 'attachment', attachment: { type: 'hook_additional_context', content: ['some other hook output'] } }));
  assert.ok(!isRetrievedMemory({ type: 'user', message: { content: '<retrieved-memory>' } }));
});

test('injectionSources parses [source · date] chunk headers', () => {
  const block = '<retrieved-memory>\n[memory/reference/decisions.md · 2026-06-09] text\n[http/public/pages/x.md · 2026-05-20] more\n</retrieved-memory>';
  const srcs = injectionSources(block);
  assert.deepEqual(srcs, [
    { source: 'memory/reference/decisions.md', date: '2026-06-09' },
    { source: 'http/public/pages/x.md', date: '2026-05-20' }
  ]);
});

test('inspectSession pairs each prompt with its injection (or null)', () => {
  const file = writeTranscript([
    { type: 'user', message: { content: 'first question' }, timestamp: '2026-06-09T10:00:00Z' },
    { type: 'attachment', attachment: { type: 'hook_additional_context', content: ['<retrieved-memory>\n[memory/reference/decisions.md · 2026-06-09] d\n</retrieved-memory>'] } },
    { type: 'assistant', message: { content: 'answer' } },
    { type: 'user', message: { content: 'second question, no injection' }, timestamp: '2026-06-09T10:01:00Z' },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'ignored' }] } }, // skipped
    { type: 'assistant', message: { content: 'answer2' } }
  ]);

  const { turns } = inspectSession({ file });
  assert.equal(turns.length, 2, 'tool_result user record must not count as a prompt');
  assert.equal(turns[0].prompt, 'first question');
  assert.ok(turns[0].injection && turns[0].injection.includes('decisions.md'));
  assert.equal(turns[1].prompt, 'second question, no injection');
  assert.equal(turns[1].injection, null);

  const report = formatInspection({ file, turns }, { last: 12 });
  assert.ok(report.includes('injected: 1/2'));
  assert.ok(report.includes('stayed quiet'));
});
