# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-06-09

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

### Changed
- Chunk IDs are stable against unrelated section insertion/removal by deriving
  IDs from source, section slug, duplicate-heading occurrence, and part index.
- Incremental indexing preserves vector row IDs for unchanged chunks instead of
  deleting and reinserting embeddings.

### Upgrade Notes

Initial release. For fresh installation:

```bash
zylos add recall
```

No migration required.
