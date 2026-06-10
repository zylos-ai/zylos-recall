# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- Default corpus denylist now excludes secret-named directories
  (`**/*secret*/**`, `**/*token*/**`, `**/*credential*/**`, and password /
  apikey / private-key variants) and credential-shaped filename stems plus
  `*.pem` / `*.key`. Previously a markdown file under a directory named like
  `secrets/` or `tokens/` inside an allowed tree was indexed and injectable.
- Retrieval-log query previews now redact spaced `key: value` credentials,
  `Bearer` tokens, JWTs, PEM blocks, and known provider token shapes
  (AWS, Slack, GitHub, Google) in addition to `sk-` keys, and redaction runs
  before the 200-character truncation so boundary-cut secrets cannot leak.
- The configure and post-upgrade hooks write `config.json` with mode `0600`
  (configure previously created it with the process umask while storing
  collected secrets) and post-upgrade repairs a loose mode on every upgrade.
- README configuration example now shows the complete default deny list and
  warns that user-supplied arrays replace defaults wholesale; a truncated
  copied example previously dropped the secret denials silently.

### Added
- `zylos-recall config allow|deny list` and
  `config allow|deny add|remove <pattern>` for item-level corpus list editing:
  idempotent edits that always write the complete effective list, a pin
  warning that default-list updates no longer auto-apply after the first edit,
  and a `--force` requirement to remove built-in secret-protection deny
  entries.
- Config directory watching now catches config files created after service
  start, debounces duplicate atomic-save events into one reload, and PM2 treats
  intentional `enabled=false` exits as non-relaunching `waiting restart` parks
  instead of restart failures or errored states.
- Hybrid retrieval stages: FTS5 BM25 `bm25Retrieve` plus reciprocal-rank
  fusion `rrfFuse`, with per-stage logs that include ranks/scores but no chunk
  text.
- FTS5 index maintenance, backfill, and fail-open text search in the sqlite
  chunk store.
- Expanded default corpus coverage for current session logs, skill reference
  docs, workspace docs, and workspace repo `CLAUDE.md` files while keeping root
  runtime instruction files excluded.
- Session-tier retrieval metadata with a default `retrieval.tierPenalties`
  nudge and assembled session-log supersession marker.
- `zylos-recall recall` deliberate retrieval tool face with warm-service
  preference, direct local fallback, text/JSON output, and clamped tool-mode
  retrieval overrides.
- `zylos-recall toc` sqlite-only index table of contents grouped by metadata
  tier, with optional full section-title output.
- `zylos-recall config get/set` for allowlisted runtime knobs, with dot-path
  reads, typed value parsing, existing config validation, atomic writes, and
  truthful apply-semantics messaging.
- Issue #9 startup index reuse when corpus signature and chunking fingerprint
  match, avoiding unchanged corpus re-chunk/re-embed work on service start.
- Truthful retrieval logging with per-stage candidate snapshots, free-gate drop
  accounting, and service/client JSONL records joined by normalized query hash.
- `zylos-recall inspect --retrieval-log` for service/client retrieval log
  inspection with legacy-line compatibility.

### Changed
- New default retrieval pipeline is
  `denseRetrieve -> bm25Retrieve -> rrfFuse -> freeGates -> assemble`; existing
  post-upgrade configs preserve their configured pipeline.
- Free gates now admit BM25-only candidates only within
  `retrieval.bm25AdmitTopN` and log other BM25-only drops as
  `bm25WeakNoDense`.
- Post-upgrade adds `retrieval.tierPenalties` when missing but preserves
  existing corpus allow/deny arrays for measured live deployment.
- Default denylist excludes workspace backup/original trees such as `.backup/`
  and `.zylos/` to avoid stale near-duplicate docs in expanded corpus matches.
- Default hook timeout is now 1000ms for new installs/default configs; existing
  post-upgrade configs are preserved.

## [0.0.8] - 2026-06-09

### Added
- R1 scaffold and indexer.
- Config schema for corpus allow/denylist, chunking, local ONNX embedder,
  retrieval pipeline shape, and filter provider.
- Markdown corpus walker with hard secret/session/archive denylist.
- Semantic section chunker with content hashes and v1 open metadata
  `{date,type}`.
- Embedder interface plus local ONNX multilingual-e5-small driver with
  required e5 `query:` / `passage:` prefixes.
- SQLite/sqlite-vec chunk store with minimal typed columns, `embeddings[]`
  JSON, open metadata JSON, WAL mode, incremental hash-diff indexing, and
  full reset when embedder id/dimension changes.
- `zylos-recall index` and `zylos-recall query` CLI commands.
- Unit tests for config validation, corpus policy, chunking, e5 prefixes, and
  incremental indexing.
- R2 retrieval pipeline with configured stages:
  `denseRetrieve -> freeGates -> assemble`.
- `<retrieved-memory>` assembly with source/date tags, token budget, and
  truncation pointer.
- Warm local HTTP service with `/health` and fail-open `/retrieve` endpoint.
- Fail-open `src/retrieve.js` hook client with an 800ms default timeout.
- `zylos-recall retrieve` CLI command for gated retrieval smoke checks.
- R3 `UserPromptSubmit` hook registration during install/upgrade and hook
  cleanup during uninstall.
- Freshness manager with startup indexing, debounced filesystem refresh where
  supported, and periodic corpus mtime/size sweep fallback.
- Retrieval metadata JSONL log with redacted query preview and selected
  chunk IDs/scores, without chunk text.
- Runtime hotfixes for live install: listen-before-warm service startup,
  retrieval staleness gate, narrowed default corpus allowlist, scoped
  non-recursive workspace watcher behavior, and PM2 thread-count caps.
- Hook query normalization that strips C4 channel/routing envelopes before
  embedding, preferring `<current-message>` content when present.
- R5 deterministic eval harness with frozen fixtures, golden cases, metric
  helpers, runner, baseline gate, and threshold/recency/topK sweep mode.
- `zylos-recall inspect` CLI to audit recall utilization by pairing transcript
  prompts with delivered `<retrieved-memory>` context.
- Filter-target golden cases with `requiresFilter` gate exclusion so the eval
  harness measures usefulness filtering separately from the baseline gate.
- Local cross-encoder rerank filter using q8 `Xenova/bge-reranker-base`,
  configured with `filter.provider: "rerank"` and the `rerankFilter` pipeline
  stage.
- Reranker warm-load and fail-open behavior so retrieval continues without the
  optional filter when the reranker cannot warm or score a turn.
- `rerankScore`, rerank stage timings, and passage-cap metadata in retrieval
  logs without recording chunk text.
- `filter.maxPassageTokens` with default `128` and validation range `64..256`
  to cap reranker scorer input while preserving full stored and injected chunks.

### Changed
- Chunk IDs are stable against unrelated section insertion/removal by deriving
  IDs from source, section slug, duplicate-heading occurrence, and part index.
- Dense markdown sections now split at semantic sub-boundaries when a section
  mixes multiple labeled topics, improving retrieval of buried facts.
- Incremental indexing preserves vector row IDs for unchanged chunks instead of
  deleting and reinserting embeddings.
- Short substantive prompts with at least three words, such as `fix the bug`,
  are no longer skipped by the hook client.
- `<retrieved-memory>` note now warns that snippets from actively edited files
  may be stale.
- Incremental indexing embeds changed chunks in configured batches and yields
  between batches to keep the service event loop responsive during heavy first
  index builds.
- Runtime readiness is delayed until warmup and the initial freshness startup
  index complete, so a fresh empty index fails open until the first build is
  available.
- Reranker passage scoring now applies a cheap pre-tokenizer text slice plus
  tokenizer `max_length` to keep live K=5 reranking under the hook timeout.

### Upgrade Notes

Initial release. For fresh installation:

```bash
zylos add recall
```

The rerank filter is opt-in. Existing installs that explicitly configure
`retrieval.pipeline` must include `rerankFilter` in that pipeline when enabling
`filter.provider: "rerank"`.

No migration required.
