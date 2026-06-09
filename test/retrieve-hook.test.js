import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { extractPrompt, isSubstantive, normalizePromptForRetrieval, runRetrieveHook } from '../src/retrieve.js';

const CONFIG = Object.freeze({
  enabled: true,
  service: {
    host: '127.0.0.1',
    port: 37537,
    timeoutMs: 800
  }
});

test('extracts prompts from argv, hook json, and raw stdin', () => {
  assert.equal(extractPrompt('', ['hello', 'from argv']), 'hello from argv');
  assert.equal(extractPrompt('{"prompt":"hello from json"}', []), 'hello from json');
  assert.equal(extractPrompt('plain prompt text', []), 'plain prompt text');
});

test('normalizes C4 envelopes to only the current user message', () => {
  const dm = `[DISCORD DM] felixlin. said: <current-message> yes, this one </current-message> ---- reply via: node /Users/felixlin/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "discord" "123"`;
  assert.equal(normalizePromptForRetrieval(dm), 'yes, this one');

  const group = `[TG Group] Felix said: <current-message>
what embedder did we choose for recall and why
</current-message>
---- reply via: node /Users/felixlin/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "telegram" "-100"`;
  assert.equal(
    normalizePromptForRetrieval(group),
    'what embedder did we choose for recall and why'
  );

  const reply = `[HXA:coco DM] zylos-felix-vm said: <replying-to>
Earlier C4 routing text and quoted context.
</replying-to>
<current-message>please check recall retrieval quality</current-message> ---- reply via: node /Users/felixlin/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "hxa-connect" "org:coco|zylos-felix-vm"`;
  assert.equal(normalizePromptForRetrieval(reply), 'please check recall retrieval quality');
});

test('falls back to stripping leading channel tag and reply routing', () => {
  const envelope = `[SLACK DM] felix said: please recall alpha project details
---- reply via: node /Users/felixlin/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "slack" "U123"`;
  assert.equal(normalizePromptForRetrieval(envelope), 'please recall alpha project details');
  assert.equal(normalizePromptForRetrieval('plain prompt text'), 'plain prompt text');
});

test('skips trivial and control prompts', () => {
  assert.equal(isSubstantive('hello'), false);
  assert.equal(isSubstantive('fix the bug'), true);
  assert.equal(isSubstantive('Heartbeat check 123'), false);
  assert.equal(isSubstantive('[scheduled task] run now'), false);
  assert.equal(isSubstantive('please recall alpha project details'), true);
});

test('writes hook additionalContext when service returns memory', async () => {
  let fetchCalled = false;
  const output = [];
  const result = await runRetrieveHook({
    argv: [],
    stdin: Readable.from(['{"prompt":"please recall alpha project details"}']),
    stdout: { write: value => output.push(value) },
    config: CONFIG,
    timeoutSignal: ms => {
      assert.equal(ms, 800);
      return 'timeout-signal';
    },
    fetchImpl: async (url, options) => {
      fetchCalled = true;
      assert.equal(url, 'http://127.0.0.1:37537/retrieve');
      assert.equal(options.signal, 'timeout-signal');
      assert.deepEqual(JSON.parse(options.body), { query: 'please recall alpha project details' });
      return {
        ok: true,
        async json() {
          return { additionalContext: '<retrieved-memory>alpha</retrieved-memory>' };
        }
      };
    }
  });

  assert.equal(result, true);
  assert.equal(fetchCalled, true);
  const payload = JSON.parse(output.join(''));
  assert.deepEqual(payload, {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: '<retrieved-memory>alpha</retrieved-memory>'
    }
  });
});

test('sends normalized C4 prompt to retrieval service', async () => {
  const envelope = `[DISCORD DM] felixlin. said: <current-message>what embedder did recall choose?</current-message> ---- reply via: node /Users/felixlin/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "discord" "123"`;
  const result = await runRetrieveHook({
    argv: [],
    stdin: Readable.from([JSON.stringify({ prompt: envelope })]),
    stdout: { write() {} },
    config: CONFIG,
    timeoutSignal: () => 'timeout-signal',
    fetchImpl: async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body), { query: 'what embedder did recall choose?' });
      return {
        ok: true,
        async json() {
          return { additionalContext: '<retrieved-memory>recall</retrieved-memory>' };
        }
      };
    }
  });

  assert.equal(result, true);
});

test('skips contentless C4 messages after normalization', async () => {
  const result = await runRetrieveHook({
    argv: [],
    stdin: Readable.from(['[DISCORD DM] felixlin. said: <current-message>yes</current-message> ---- reply via: node c4-send.js "discord" "123"']),
    stdout: { write() {} },
    config: CONFIG,
    fetchImpl: async () => {
      throw new Error('fetch should not be called');
    }
  });

  assert.equal(result, false);
});

test('does not wait for stdin when argv contains the prompt', async () => {
  const result = await runRetrieveHook({
    argv: ['please recall alpha project details'],
    stdin: {
      setEncoding() {
        throw new Error('stdin should not be read');
      }
    },
    stdout: { write() {} },
    config: CONFIG,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { additionalContext: '<retrieved-memory>alpha</retrieved-memory>' };
      }
    })
  });

  assert.equal(result, true);
});

test('fails open on service errors and empty context', async () => {
  const output = [];
  const thrown = await runRetrieveHook({
    argv: ['please recall alpha project details'],
    stdin: Readable.from([]),
    stdout: { write: value => output.push(value) },
    config: CONFIG,
    fetchImpl: async () => {
      throw new Error('service unavailable');
    }
  });
  assert.equal(thrown, false);
  assert.equal(output.length, 0);

  const empty = await runRetrieveHook({
    argv: ['please recall alpha project details'],
    stdin: Readable.from([]),
    stdout: { write: value => output.push(value) },
    config: CONFIG,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { additionalContext: '' };
      }
    })
  });
  assert.equal(empty, false);
  assert.equal(output.length, 0);
});
