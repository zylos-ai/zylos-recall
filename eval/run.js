#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildEvalIndex } from './build-index.js';
import { createEvalConfig, DEFAULT_EVAL_NOW, EVAL_DIR } from './config.js';
import { mean, mrr, ndcgAtK, precisionAtK, recallAtK } from './metrics.js';
import { queryIndex } from '../src/lib/indexer.js';
import { assemble, freeGates } from '../src/lib/retriever.js';

const GOLDEN_PATH = path.join(EVAL_DIR, 'golden/golden.json');
const BASELINE_PATH = path.join(EVAL_DIR, 'baseline.json');
const DEFAULT_POOL_K = 30;

export async function runEval(options = {}) {
  const k = options.k || 5;
  const config = options.config || createEvalConfig(options.configOverrides);
  const cases = options.cases || loadJson(options.goldenPath || GOLDEN_PATH);
  const baseline = options.baseline || loadOptionalJson(options.baselinePath || BASELINE_PATH);
  const embedder = options.embedder;
  const store = options.store;
  const candidatePools = options.candidatePools || await collectCandidatePools(cases, config, {
    embedder,
    store,
    topK: options.poolK || Math.max(DEFAULT_POOL_K, config.retrieval.topK)
  });

  if (options.sweep) {
    return runSweep(cases, config, candidatePools, { k, sweep: options.sweep, now: options.now });
  }

  const caseResults = cases.map(testCase => scoreCase(testCase, candidatePools.get(testCase.id) || [], config, {
    k,
    now: options.now
  }));
  const summary = summarize(caseResults, k);
  const passed = passesBaseline(summary, baseline);
  if (options.print !== false) printReport(caseResults, summary, baseline);
  return { cases: caseResults, summary, baseline, passed };
}

export async function collectCandidatePools(cases, config, options = {}) {
  const pools = new Map();
  for (const testCase of cases) {
    const candidates = await queryIndex(config, testCase.query, {
      embedder: options.embedder,
      store: options.store,
      topK: options.topK || DEFAULT_POOL_K
    });
    pools.set(testCase.id, sortCandidates(candidates));
  }
  return pools;
}

export function scoreCase(testCase, candidates, baseConfig, options = {}) {
  const k = options.k || 5;
  const ranked = sortCandidates(candidates).map(candidate => sourceForGolden(candidate.source));
  const relevantSet = new Set(testCase.expect.map(item => item.source));
  const gradeMap = new Map(testCase.expect.map(item => [item.source, item.grade]));
  const selected = applyGates(candidates, baseConfig, { now: options.now }).map(candidate => ({
    ...candidate,
    source: sourceForGolden(candidate.source)
  }));
  const selectedSources = selected.map(candidate => candidate.source);
  const forbid = new Set(testCase.forbid || []);
  const forbidViolations = selectedSources.filter(source => forbid.has(source));
  const expectedInjected = selectedSources.filter(source => relevantSet.has(source));

  return {
    id: testCase.id,
    query: testCase.query,
    ranked,
    selected,
    precisionAtK: precisionAtK(ranked, relevantSet, k),
    recallAtK: recallAtK(ranked, relevantSet, k),
    mrr: mrr(ranked, relevantSet),
    ndcgAtK: ndcgAtK(ranked, gradeMap, k),
    injectedPrecision: selectedSources.length ? expectedInjected.length / selectedSources.length : 0,
    injectedHit: expectedInjected.length > 0,
    forbidViolations
  };
}

export function applyGates(candidates, baseConfig, options = {}) {
  const config = structuredClone(baseConfig);
  if (options.threshold !== undefined) config.retrieval.threshold = options.threshold;
  if (options.recencyWeight !== undefined) config.retrieval.recencyWeight = options.recencyWeight;
  if (options.topK !== undefined) config.retrieval.topK = options.topK;
  const ctx = {
    config,
    candidates: sortCandidates(candidates).slice(0, config.retrieval.topK),
    selected: [],
    log: [],
    now: options.now || DEFAULT_EVAL_NOW
  };
  freeGates(ctx);
  assemble(ctx);
  return ctx.selected;
}

export function summarize(caseResults, k) {
  return {
    cases: caseResults.length,
    k,
    meanPrecisionAtK: mean(caseResults.map(result => result.precisionAtK)),
    meanRecallAtK: mean(caseResults.map(result => result.recallAtK)),
    meanMrr: mean(caseResults.map(result => result.mrr)),
    meanNdcgAtK: mean(caseResults.map(result => result.ndcgAtK)),
    forbidViolations: caseResults.reduce((sum, result) => sum + result.forbidViolations.length, 0),
    injectedHits: caseResults.filter(result => result.injectedHit).length
  };
}

export function runSweep(cases, baseConfig, candidatePools, options = {}) {
  const k = options.k || 5;
  const grids = normalizeSweep(options.sweep);
  const rows = [];
  for (const threshold of grids.threshold) {
    for (const recencyWeight of grids.recencyWeight) {
      for (const topK of grids.topK) {
        const config = structuredClone(baseConfig);
        config.retrieval.threshold = threshold;
        config.retrieval.recencyWeight = recencyWeight;
        config.retrieval.topK = topK;
        const caseResults = cases.map(testCase => scoreCase(
          testCase,
          candidatePools.get(testCase.id) || [],
          config,
          { k, now: options.now }
        ));
        rows.push({
          threshold,
          recencyWeight,
          topK,
          ...summarize(caseResults, k)
        });
      }
    }
  }
  rows.sort((a, b) =>
    a.forbidViolations - b.forbidViolations ||
    b.meanNdcgAtK - a.meanNdcgAtK ||
    b.meanRecallAtK - a.meanRecallAtK
  );
  return { rows, best: rows[0] || null };
}

export function parseArgs(argv) {
  const options = { k: 5, poolK: DEFAULT_POOL_K };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--build') options.build = true;
    else if (arg === '--k') options.k = Number(argv[++index]);
    else if (arg === '--pool-k') options.poolK = Number(argv[++index]);
    else if (arg === '--golden') options.goldenPath = argv[++index];
    else if (arg === '--baseline') options.baselinePath = argv[++index];
    else if (arg === '--sweep') options.sweep = parseSweepArg(argv[++index]);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

export function parseSweepArg(value) {
  const sweep = {};
  for (const part of String(value || '').split(',').filter(Boolean)) {
    const [name, spec] = part.split('=');
    if (!name || !spec) throw new Error(`Invalid sweep spec: ${part}`);
    sweep[name] = spec.includes(':') ? range(spec) : spec.split('|').map(Number);
  }
  return sweep;
}

function normalizeSweep(sweep = {}) {
  return {
    threshold: sweep.threshold || range('0.30:0.80:0.05'),
    recencyWeight: sweep.recencyWeight || [0.05],
    topK: sweep.topK || [5]
  };
}

function range(spec) {
  const [start, end, step] = spec.split(':').map(Number);
  if (![start, end, step].every(Number.isFinite) || step <= 0) {
    throw new Error(`Invalid range: ${spec}`);
  }
  const values = [];
  for (let value = start; value <= end + step / 10; value += step) {
    values.push(Number(value.toFixed(6)));
  }
  return values;
}

function sortCandidates(candidates) {
  // Stable tie handling for deterministic eval output: score desc, then source asc.
  return [...candidates].sort((a, b) =>
    b.score - a.score ||
    sourceForGolden(a.source).localeCompare(sourceForGolden(b.source))
  );
}

function sourceForGolden(source) {
  return source.startsWith('corpus/') ? source : `corpus/${source}`;
}

function passesBaseline(summary, baseline) {
  if (!baseline) return true;
  if (summary.forbidViolations > (baseline.maxForbidViolations ?? 0)) return false;
  if (summary.meanNdcgAtK < (baseline.meanNdcgAtK ?? 0)) return false;
  return true;
}

function printReport(caseResults, summary, baseline) {
  console.log('id\tP@k\tR@k\tMRR\tnDCG@k\tinjected\tforbid');
  for (const result of caseResults) {
    console.log([
      result.id,
      format(result.precisionAtK),
      format(result.recallAtK),
      format(result.mrr),
      format(result.ndcgAtK),
      result.injectedHit ? 'hit' : 'miss',
      result.forbidViolations.join(',') || '-'
    ].join('\t'));
  }
  console.log('');
  console.log(`summary\tcases=${summary.cases}\tmeanP@${summary.k}=${format(summary.meanPrecisionAtK)}\tmeanR@${summary.k}=${format(summary.meanRecallAtK)}\tmeanMRR=${format(summary.meanMrr)}\tmeanNDCG@${summary.k}=${format(summary.meanNdcgAtK)}\tforbid=${summary.forbidViolations}`);
  if (baseline) {
    console.log(`baseline\tmeanNDCG@${summary.k}>=${baseline.meanNdcgAtK}\tforbid<=${baseline.maxForbidViolations ?? 0}`);
  }
}

function printSweep(sweep) {
  console.log('threshold\trecencyWeight\ttopK\tmeanNDCG@k\tmeanR@k\tforbid');
  for (const row of sweep.rows) {
    console.log([
      row.threshold,
      row.recencyWeight,
      row.topK,
      format(row.meanNdcgAtK),
      format(row.meanRecallAtK),
      row.forbidViolations
    ].join('\t'));
  }
  if (sweep.best) {
    console.log(`best\tthreshold=${sweep.best.threshold}\trecencyWeight=${sweep.best.recencyWeight}\ttopK=${sweep.best.topK}\tmeanNDCG@${sweep.best.k}=${format(sweep.best.meanNdcgAtK)}`);
  }
}

function format(value) {
  return Number(value).toFixed(3);
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadOptionalJson(filePath) {
  return fs.existsSync(filePath) ? loadJson(filePath) : null;
}

function usage() {
  return `Usage:
  node eval/build-index.js
  node eval/run.js [--build] [--k 5] [--pool-k 30]
  node eval/run.js --sweep threshold=0.30:0.80:0.05[,recencyWeight=0|0.05,topK=3|5]
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    if (options.build) await buildEvalIndex();
    const result = await runEval(options);
    if (options.sweep) printSweep(result);
    else if (!result.passed) process.exitCode = 1;
  })().catch(err => {
    console.error(`[recall-eval] ${err.message}`);
    process.exit(1);
  });
}
