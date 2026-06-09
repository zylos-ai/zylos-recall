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
  // requiresFilter cases are R4 usefulness-filter targets: they are DESIGNED to fail
  // pre-filter (a superseded/mention doc passes similarity), so they are reported but
  // excluded from the baseline pass/fail gate until the filter exists.
  const gatingResults = caseResults.filter(result => !result.requiresFilter);
  const filterResults = caseResults.filter(result => result.requiresFilter);
  const summary = summarize(gatingResults, k);
  const passed = passesBaseline(summary, baseline);
  if (options.print !== false) printReport(caseResults, summary, baseline, filterResults, k);
  return { cases: caseResults, summary, baseline, passed, filterResults };
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
  const ranked = dedupeBySource(sortCandidates(candidates)).map(candidate => sourceForGolden(candidate.source));
  const relevantSet = new Set(testCase.expect.map(item => item.source));
  const gradeMap = new Map(testCase.expect.map(item => [item.source, item.grade]));
  const selected = applyGates(candidates, baseConfig, { now: options.now }).map(candidate => ({
    ...candidate,
    source: sourceForGolden(candidate.source)
  }));
  const selectedSources = dedupeSources(selected.map(candidate => candidate.source));
  const forbid = new Set(testCase.forbid || []);
  const forbidViolations = selectedSources.filter(source => forbid.has(source));
  const expectedInjected = selectedSources.filter(source => relevantSet.has(source));
  const shouldHit = relevantSet.size > 0;
  const injectedRecall = shouldHit ? expectedInjected.length / relevantSet.size : 0;
  const injectedPrecision = selectedSources.length ? expectedInjected.length / selectedSources.length : 0;

  return {
    id: testCase.id,
    query: testCase.query,
    shouldHit,
    requiresFilter: Boolean(testCase.requiresFilter),
    ranked,
    selected,
    precisionAtK: precisionAtK(ranked, relevantSet, k),
    recallAtK: recallAtK(ranked, relevantSet, k),
    mrr: mrr(ranked, relevantSet),
    ndcgAtK: ndcgAtK(ranked, gradeMap, k),
    injectedRecall,
    injectedPrecision,
    injectedF1: f1(injectedPrecision, injectedRecall),
    injectedHit: expectedInjected.length > 0,
    quiet: !shouldHit && selectedSources.length === 0,
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
  const shouldHit = caseResults.filter(result => result.shouldHit);
  const expectEmpty = caseResults.filter(result => !result.shouldHit);
  return {
    cases: caseResults.length,
    shouldHitCases: shouldHit.length,
    expectEmptyCases: expectEmpty.length,
    k,
    meanPrecisionAtK: mean(shouldHit.map(result => result.precisionAtK)),
    meanRecallAtK: mean(shouldHit.map(result => result.recallAtK)),
    meanMrr: mean(shouldHit.map(result => result.mrr)),
    meanNdcgAtK: mean(shouldHit.map(result => result.ndcgAtK)),
    injectedPrecision: mean(shouldHit.map(result => result.injectedPrecision)),
    injectedRecall: mean(shouldHit.map(result => result.injectedRecall)),
    injectedF1: f1(
      mean(shouldHit.map(result => result.injectedPrecision)),
      mean(shouldHit.map(result => result.injectedRecall))
    ),
    quietAccuracy: expectEmpty.length
      ? expectEmpty.filter(result => result.quiet).length / expectEmpty.length
      : 1,
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
    b.quietAccuracy - a.quietAccuracy ||
    b.injectedF1 - a.injectedF1 ||
    b.injectedRecall - a.injectedRecall ||
    b.meanNdcgAtK - a.meanNdcgAtK
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

function dedupeBySource(candidates) {
  const seen = new Set();
  const deduped = [];
  for (const candidate of candidates) {
    const source = sourceForGolden(candidate.source);
    if (seen.has(source)) continue;
    seen.add(source);
    deduped.push(candidate);
  }
  return deduped;
}

function dedupeSources(sources) {
  return [...new Set(sources)];
}

function sourceForGolden(source) {
  return source.startsWith('corpus/') ? source : `corpus/${source}`;
}

function passesBaseline(summary, baseline) {
  if (!baseline) return true;
  if (summary.forbidViolations > (baseline.maxForbidViolations ?? 0)) return false;
  if (summary.meanNdcgAtK < (baseline.meanNdcgAtK ?? 0)) return false;
  if (summary.injectedF1 < (baseline.injectedF1 ?? 0)) return false;
  if (summary.quietAccuracy < (baseline.quietAccuracy ?? 0)) return false;
  return true;
}

function printReport(caseResults, summary, baseline, filterResults = [], k = summary.k) {
  console.log('id\ttype\tP@k\tR@k\tMRR\tnDCG@k\tinjR\tinjP\tquiet\tforbid');
  for (const result of caseResults) {
    console.log([
      result.id,
      result.requiresFilter ? 'filter' : (result.shouldHit ? 'hit' : 'empty'),
      format(result.precisionAtK),
      format(result.recallAtK),
      format(result.mrr),
      format(result.ndcgAtK),
      format(result.injectedRecall),
      format(result.injectedPrecision),
      result.quiet ? 'yes' : '-',
      result.forbidViolations.join(',') || '-'
    ].join('\t'));
  }
  console.log('');
  console.log(`summary\tcases=${summary.cases}\tshouldHit=${summary.shouldHitCases}\texpectEmpty=${summary.expectEmptyCases}\tmeanP@${summary.k}=${format(summary.meanPrecisionAtK)}\tmeanR@${summary.k}=${format(summary.meanRecallAtK)}\tmeanMRR=${format(summary.meanMrr)}\tmeanNDCG@${summary.k}=${format(summary.meanNdcgAtK)}\tinjectedF1=${format(summary.injectedF1)}\tquiet=${format(summary.quietAccuracy)}\tforbid=${summary.forbidViolations}`);
  if (baseline) {
    console.log(`baseline\tmeanNDCG@${summary.k}>=${baseline.meanNdcgAtK}\tinjectedF1>=${baseline.injectedF1 ?? 0}\tquiet>=${baseline.quietAccuracy ?? 0}\tforbid<=${baseline.maxForbidViolations ?? 0}`);
  }
  if (filterResults.length) {
    const forbidHits = filterResults.reduce((sum, r) => sum + r.forbidViolations.length, 0);
    const cleanInject = filterResults.filter(r => r.injectedHit && !r.forbidViolations.length).length;
    console.log(`filter-target\tcases=${filterResults.length}\tforbidViolations=${forbidHits}\tclean=${cleanInject}\t(NOT gated — R4 usefulness-filter targets; expected to fail pre-filter)`);
  }
}

function printSweep(sweep) {
  console.log('threshold\trecencyWeight\ttopK\tinjF1\tinjR\tinjP\tquiet\tmeanNDCG@k\tforbid');
  for (const row of sweep.rows) {
    console.log([
      row.threshold,
      row.recencyWeight,
      row.topK,
      format(row.injectedF1),
      format(row.injectedRecall),
      format(row.injectedPrecision),
      format(row.quietAccuracy),
      format(row.meanNdcgAtK),
      row.forbidViolations
    ].join('\t'));
  }
  if (sweep.best) {
    console.log(`best\tthreshold=${sweep.best.threshold}\trecencyWeight=${sweep.best.recencyWeight}\ttopK=${sweep.best.topK}\tinjectedF1=${format(sweep.best.injectedF1)}\tquiet=${format(sweep.best.quietAccuracy)}\tmeanNDCG@${sweep.best.k}=${format(sweep.best.meanNdcgAtK)}`);
  }
}

function format(value) {
  return Number(value).toFixed(3);
}

function f1(precision, recall) {
  return precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
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
