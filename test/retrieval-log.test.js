import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../src/lib/config.js';
import { appendClientRetrievalLog, appendRetrievalLog, redactQuery } from '../src/lib/retrieval-log.js';
import { sha256 } from '../src/lib/hash.js';

test('redacts likely secrets from query previews', () => {
  assert.equal(redactQuery('use sk-ant-api123SECRET for setup'), 'use [redacted] for setup');
  assert.equal(redactQuery('token=abc123 should not be exposed'), '[redacted] should not be exposed');
});

test('redacts spaced key-value, bearer, jwt, pem, and known provider token shapes', () => {
  assert.equal(redactQuery('my password: hunter2 leaked'), 'my [redacted] leaked');
  assert.equal(redactQuery('the token: abcdef should hide'), 'the [redacted] should hide');
  assert.equal(redactQuery('set api_key = abc123 now'), 'set [redacted] now');
  // Bearer pattern redacts the credential, then the authorization key-value
  // pattern collapses the remaining "Authorization: [redacted]" pair.
  assert.equal(redactQuery('header Authorization: Bearer abc.def-ghi_jkl please'), 'header [redacted] please');
  assert.equal(
    redactQuery('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig-part here'),
    'jwt [redacted] here'
  );
  assert.equal(
    redactQuery('-----BEGIN RSA PRIVATE KEY----- MIIEowIBAAKCAQEA7 -----END RSA PRIVATE KEY----- pasted'),
    '[redacted] pasted'
  );
  assert.equal(redactQuery('aws AKIAIOSFODNN7EXAMPLE in logs'), 'aws [redacted] in logs');
  assert.equal(redactQuery('slack xoxb-1234567890-abcdef in config'), 'slack [redacted] in config');
  assert.equal(redactQuery('gh ghp_abcdefghijklmnop1234 found'), 'gh [redacted] found');
  assert.equal(redactQuery('pat github_pat_22ABCDEF0123456789 found'), 'pat [redacted] found');
});

test('keeps benign technical queries unredacted', () => {
  assert.equal(redactQuery('what is the retrieval threshold: 0.65 doing'), 'what is the retrieval threshold: 0.65 doing');
  assert.equal(redactQuery('how does the tokenizer split markdown sections'), 'how does the tokenizer split markdown sections');
  assert.equal(redactQuery('where are session tier penalties configured'), 'where are session tier penalties configured');
});

test('redacts before truncating so boundary-cut credentials never leak', () => {
  const padding = 'context '.repeat(24); // 192 chars
  const preview = redactQuery(`${padding}password=supersecretvalue1234567890`);
  assert.equal(preview.includes('supersecret'), false);
  assert.equal(preview.length <= 200, true);
});

test('appends retrieval metadata without chunk text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-log-'));
  const config = structuredClone(DEFAULT_CONFIG);
  config.dataDir = dir;
  const record = appendRetrievalLog(config, {
    query: 'alpha project details',
    durationMs: 12,
    injected: true,
    stages: [{ stage: 'rerankFilter', scored: 2, kept: 1, maxPassageTokens: 128, durationMs: 42 }],
    selected: [{
      id: 'alpha',
      source: 'memory/reference/projects.md',
      score: 0.91234567,
      bm25Score: 6.5432109,
      denseRank: 1,
      bm25Rank: 2,
      fusedScore: 0.03252247,
      normalizedFused: 0.99193548,
      rerankScore: 0.81234567,
      rankScore: 0.81234567,
      finalScore: 0.93456789,
      text: 'chunk text must not be logged'
    }]
  });

  const logPath = path.join(dir, 'logs', 'retrieval.jsonl');
  const line = fs.readFileSync(logPath, 'utf8').trim();
  const parsed = JSON.parse(line);
  assert.equal(parsed.kind, 'service');
  assert.equal(parsed.queryHash, sha256('alpha project details'));
  assert.equal(parsed.queryPreview, 'alpha project details');
  assert.equal(parsed.selected[0].score, 0.912346);
  assert.equal(parsed.selected[0].bm25Score, 6.543211);
  assert.equal(parsed.selected[0].denseRank, 1);
  assert.equal(parsed.selected[0].bm25Rank, 2);
  assert.equal(parsed.selected[0].fusedScore, 0.032522);
  assert.equal(parsed.selected[0].normalizedFused, 0.991935);
  assert.equal(parsed.selected[0].rerankScore, 0.812346);
  assert.equal(parsed.selected[0].rankScore, 0.812346);
  assert.equal(parsed.selected[0].finalScore, 0.934568);
  assert.deepEqual(parsed.stages, [{ stage: 'rerankFilter', scored: 2, kept: 1, maxPassageTokens: 128, durationMs: 42 }]);
  assert.equal(line.includes('chunk text must not be logged'), false);
  assert.equal(record.injected, true);
  assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(logPath)).mode & 0o777, 0o700);
});

test('appends compact client outcome lines joinable by queryHash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-client-log-'));
  const config = structuredClone(DEFAULT_CONFIG);
  config.dataDir = dir;
  const record = appendClientRetrievalLog(config, {
    query: 'alpha project details',
    outcome: 'timeout',
    durationMs: 1001
  });

  const line = fs.readFileSync(path.join(dir, 'logs', 'retrieval.jsonl'), 'utf8').trim();
  const parsed = JSON.parse(line);
  assert.deepEqual(Object.keys(parsed).sort(), ['durationMs', 'kind', 'outcome', 'queryHash', 'ts']);
  assert.equal(parsed.kind, 'client');
  assert.equal(parsed.queryHash, sha256('alpha project details'));
  assert.equal(parsed.outcome, 'timeout');
  assert.equal(parsed.durationMs, 1001);
  assert.equal(record.kind, 'client');
});
