# zylos-recall — Design Document

**Component:** `recall` · **Service:** `zylos-recall` · **Type:** capability
**Date:** 2026-06-09 · **Owner:** Felix · **Status:** Design complete → R1 build

> **Canonical full design:** https://felix-lin.coco.site/pages/recall-design (中文: /pages/recall-design-zh)
> This file is the in-repo working spec for implementation; the published page is the source of truth for rationale.

---

## 1. Overview

A retrieval layer that, on every substantive user turn, proactively surfaces the *relevant* slice of Zylos's own memory/knowledge into context — so the agent acts on what it knows instead of only on what was auto-loaded. It fulfills the existing on-demand rules in CLAUDE.md ("check decisions / read the profile / check preferences") by *triggering* them at the right moment.

**Binding constraint = visibility, not obedience.** The failure today is "never saw it," not "saw it and ignored it."

## 2. Architecture

```
user msg ─▶ UserPromptSubmit hook ─▶ retrieve.js (thin client)
                                        │
                        ┌───────────────┼──────────────────┐
                        ▼               ▼                   ▼
                  embed query     vector search        free gates
                 (warm service)   (sqlite-vec)    (threshold/topK/dedup/
                        │               │           recency/budget)
                        └───────────────┴──────────────┬──┘
                                                        ▼
                                          [R4: optional LLM filter]
                                                        ▼
                                   <retrieved-memory> block ─▶ additionalContext
```

- Self-contained component. Ships `retrieve.js` + a warm embedding **PM2 service** (`zylos-recall`) + a sqlite-vec index in its data dir.
- `post-install` registers the `UserPromptSubmit` hook in `~/.claude/settings.json` → `retrieve.js`; `pre-uninstall` removes it. No zylos-core dependency for v1.
- Runtime calls the component (hook → script), never the reverse.

**Injection:** via the hook's `additionalContext`, **context-first / question-last**. Verbatim chunks (no summarization), source+date-tagged, truncate-long-with-pointer. Only injected when the relevance gate passes (no empty block).

```
<retrieved-memory note="Possibly-relevant items from your own memory. Treat as candidates:
use if they apply, verify against the source file, ignore if not. If cut off, read the full file.">
[reference/decisions.md · 2026-06-09] <chunk text>
[users/<id>/profile · 2026-06-05]    <chunk text>
</retrieved-memory>
```

**Authority model:** lowest layer — `system+CLAUDE.md` > always-loaded memory > user message > `<retrieved-memory>`. Low authority (cannot override a rule) ≠ low impact (visibility changes behavior). Conflicts resolve toward live/current state; date tags drive recency.

## 3. Corpus

**INDEX (v1, priority order):**
1. Curated current-state memory — `reference/*` (decisions, projects, preferences, ideas, procedures, findings, backlogs), `users/<id>/profile.md` + `thinking-patterns.md`
2. Published pages — `http/public/pages/*.md`
3. Skill docs — `skills/*/SKILL.md` (+ `references/*.md`)
4. Selective workspace + in-repo DOCS — `workspace/*.md`, and `{README,DESIGN,CHANGELOG}.md` + `docs/*.md` + per-repo `CLAUDE.md` inside repos (docs yes, code no)

**SKIP:** always-loaded files (identity/state/references, CLAUDE.md/ZYLOS.md); `sessions/*` + `archive/` (chronological — rely on Memory Sync distilling into curated tier); raw C4 chat DB.

**NEVER:** `.env`/secrets/tokens-in-configs (hard line); code; logs; binaries/media; `node_modules`/`.git`; backup/retired files; the index itself.

Governance: explicit **allowlist** of dirs/globs + hard **denylist**; every chunk tagged `source` + `type`.

## 4. Retrieval — gatekeeper ladder

Similarity = topical closeness, not task-usefulness. Gate cheap → expensive:
1. **Similarity threshold** (free)
2. **Top-K + dedup + recency-weighting** (free)
3. **LLM filter / rerank** (R4, optional, ~0.5–2s) — NOT in the v1 sync path

**Length bounding:** chunk ~200–500 tok (by section) → threshold → top-K (~3–6) → total budget cap (≤1–2K tok) → truncate-with-pointer.

## 5. Locked decisions (Felix, 2026-06-09)

| Decision | Value |
|----------|-------|
| Embedder (v1) | **multilingual-e5-small** (384-dim, ~118M, on-box). Needs `query:`/`passage:` prefixes. bge-m3 = A/B upgrade in R5. |
| Component name | `recall` (service `zylos-recall`) |
| Query construction | **current message ONLY** — no context window; channel-level dedup collapses repeats |
| Trigger skip-rule | skip control/heartbeat/scheduler-dispatch + very short/trivial; fire on substantive |
| Multi-user scoping | dropped for v1 (profiles indexed flat) |
| Filter day-one | threshold/free-gates only; LLM filter → R4 |
| Hook wiring | component self-registers `UserPromptSubmit`; zylos-core deferred |
| Robustness | **fail-open + hard timeout (~1000ms)**: index missing / service down / any error → inject nothing, never block the turn |

## 6. Interfaces — a generic RAG substrate (policy deferred)

**Design principle (Felix, 2026-06-09):** build the RAG *mechanism* now; defer the *policy* (exactly **what** to index/embed and **how** to retrieve/rank/route). The engine must not preclude any future indexing, embedding, or retrieval policy. v1 ships the simplest path (dense similarity + free gates); smarter policies are added as config + stages later, with **no re-architecture**. Three stable seams below; **build the seams general, implement only the v1 path (no speculative stages — YAGNI).**

### 6.1 Open chunk schema (the load-bearing seam)

Every chunk is stored as a record whose typed columns are minimal and whose **`metadata` is an open JSON blob** — so any future indexing/embedding/retrieval policy can attach and key off arbitrary fields **without a schema migration**:

```jsonc
{
  "id":        "string",          // stable chunk id
  "text":      "string",          // verbatim chunk
  "source":    "string",          // file path / origin
  "hash":      "string",          // content hash (incremental reindex)
  "mtime":     "number",
  "embeddings": [                  // ZERO-OR-MORE — multi-vector / multi-embedder ready
    { "embedder_id": "e5-small@384", "vector": [/* … */] }
  ],
  "metadata":  { /* OPEN BLOB — anything a policy needs */ }
  //   v1 fills:   { "date": "...", "type": "memory|page|skill|doc" }
  //   later, freely: { "tier": "...", "applies_when": "...", "importance": 0.0,
  //                    "intent_tags": [...], "user_scope": "...", "supersedes": "..." }
}
```

Requirements this guarantees:
- **Embedding policy is open** — `embeddings` is a list keyed by `embedder_id`, so single-vector, multi-vector (ColBERT-style), or several embedders side-by-side all fit; metadata can hold sparse/keyword signals for hybrid (dense+BM25) retrieval later.
- **Indexing policy is open** — what gets chunked, how it's split, and what tags are attached are all writes into `metadata`; the store never needs to know the policy.
- **Retrieval policy is open** — any stage can **filter / weight / route / quota** on any `metadata` field (tier, applies_when, importance, intent_tags, user_scope). The metadata is the contract between "how we index" and "how we retrieve."

### 6.2 Embedder interface

`embed(texts[], mode) -> vectors[]`, `dimension()`, `id()` where `mode ∈ {query, passage}` (encodes the right e5 prefix). Index keyed to embedder `id`+dim → swap = re-index. Drivers: `local-onnx` (ship: multilingual-e5-small), later `local-python`, `api`, multi-vector.

### 6.3 Retriever interface — an ordered, pluggable STAGE pipeline

Retrieval is **not** a fixed function; it's a config-ordered list of stages, each a `Stage(ctx) -> ctx` over a shared retrieval context `{query, expandedQuery, candidates[], budget, log}`:

```
expand → retrieve[1..N] → merge → gate → rank → assemble
```

- current pipeline: `denseRetrieve(top-K) → rerankFilter(optional/no-op by default) → freeGates(threshold/dedup/recency/budget) → assemble(<retrieved-memory>)`.
- Later (no rewrite — just register stages): `queryExpand`, `applicabilityRetrieve` (routes on `metadata.applies_when`/intent), `quota`/`MMR` (reserve guidance slots), `alwaysOnCore`.
- Because every stage reads/writes the same metadata-rich candidate list, the "knowledge vs guidance / similarity vs applicability" distinction we discussed becomes *additional stages*, not a new engine.

### 6.4 Filter

`filter(query, candidates[]) -> selected[]`. A specialization of a rank/gate stage. Drivers: `none` (passthrough), `rerank` (local cross-encoder precision filter).

```jsonc
{
  "embedder": { "provider": "local-onnx", "model": "multilingual-e5-small" },
  "retrieval": {
    "pipeline": ["denseRetrieve", "rerankFilter", "freeGates", "assemble"],
    "topK": 5, "threshold": 0.35, "maxTotalTokens": 1500, "chunkTokens": 350
  },
  "filter": { "provider": "none", "maxPassageTokens": 128 },
  "corpus": { "roots": ["..."], "allow": ["..."], "deny": ["..."] }
}
```

## 7. Build plan

| Slice | Deliverable |
|-------|-------------|
| **R1 — Scaffold + indexer** | config schema (corpus allow/denylist, embedder, retrieval pipeline, filter); corpus walker + **semantic chunker** (by section, bounded, content-hash); **embedder interface + local-onnx multilingual-e5-small driver** (query/passage modes); **open chunk store** per §6.1 — minimal typed columns + `embeddings[]` (multi-vector ready) + **open `metadata` JSON blob** (v1 fills date/type; future policies attach freely, no migration); sqlite-vec for vectors; build + **incremental** index (hash-diff) + full-reindex on embedder change; index/query CLI; unit tests. |
| **R2 — Retrieval + free gates + format** | **Retriever stage-pipeline** per §6.3 (config-ordered `Stage(ctx)->ctx`); initial pipeline: `denseRetrieve → freeGates(threshold/dedup/recency/budget) → assemble(<retrieved-memory>)` (verbatim, source-tagged, truncate+pointer); warm embedding **PM2 service**; `retrieve.js` thin client with **fail-open + ~1000ms timeout**; tests on a fixed corpus. |
| **R3 — Hook wiring + freshness** | `post-install` registers `UserPromptSubmit`→`retrieve.js` (pre-uninstall removes); **per-tier freshness** (content-hash diff): memory tier re-index on Memory-Sync/checkpoint (+ mtime first-pass); non-memory tiers via fs-watcher (debounced) + scheduler sweep; trigger skip-rule; live end-to-end on Claude Code. |
| **R4 — Cross-encoder precision filter** | optional local rerank stage (`none`/`rerank`) in the per-turn retrieval pipeline; fail-open and warmed with the service. |
| **R5 — Multi-provider + eval** | more embedder drivers (bge-m3, API); named per-embedder indexes; **eval harness** (labeled query→expected-memory → Recall@K / Precision@K). |

**v1 = R1–R3.**

## 8. Success objective

**Intrinsic:** labeled eval set (~30–50 real messages → expected chunk). **Recall@5 ≥ ~85%** on queries that have a relevant memory (primary — if not retrieved, unusable); high Precision@K; rank quality (MRR/nDCG); **~zero false-positive injection** on negative/trivial queries (must return empty block). Tune threshold/top-K/chunk-size empirically against this set.
**Extrinsic:** did surfacing the memory improve the answer — judgment-based log spot-checks.

## 9. Robustness & security (must-haves)

- **Fail-open** with ~1000ms hard timeout on the hook path — never block or break a turn (protects heartbeat/liveness).
- **Never index secrets** — `.env`, tokens-in-configs are hard-excluded by the denylist; retrieved chunks could otherwise leak into context/logs/responses.
- Query↔passage prefix asymmetry encoded in the e5 driver (recall tanks otherwise).
- sqlite **WAL** for concurrent reconcile-write vs query-read.
- Retrieval logging on (query, chunks, scores) — **no secrets**.
- Chunk overlap ~15% for boundary recall.

## 10. Future

- bge-m3 / API embedders + named-index A/B (R5)
- LLM rerank (R4)
- Upgrade C3's mtime-only memory freshness with recall's per-chunk content-hash
