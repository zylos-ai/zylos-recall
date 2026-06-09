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
| Robustness | **fail-open + hard timeout (~800ms)**: index missing / service down / any error → inject nothing, never block the turn |

## 6. Interfaces (model-agnostic)

**Embedder** — `embed(texts[], mode) -> vectors[]`, `dimension()`, `id()` where `mode ∈ {query, passage}` (encodes the right e5 prefix). Index keyed to embedder `id`+dim → swap = re-index. Drivers: `local-onnx` (ship: multilingual-e5-small), later `local-python`, `api`.

**Filter** — `filter(query, candidates[]) -> selected[]`. Drivers: `none` (v1 passthrough), `llm` (R4).

```jsonc
{
  "embedder": { "provider": "local-onnx", "model": "multilingual-e5-small" },
  "filter":   { "provider": "none" },
  "retrieval": { "topK": 5, "threshold": 0.35, "maxTotalTokens": 1500, "chunkTokens": 350 },
  "corpus":   { "roots": ["..."], "allow": ["..."], "deny": ["..."] }
}
```

## 7. Build plan

| Slice | Deliverable |
|-------|-------------|
| **R1 — Scaffold + indexer** | config schema (corpus allow/denylist, embedder, filter, retrieval); corpus walker + **semantic chunker** (by section, bounded, content-hash); **embedder interface + local-onnx multilingual-e5-small driver** (query/passage modes); sqlite-vec store `{chunk, embedding, source, section, hash, mtime, embedder_id}`; build + **incremental** index (hash-diff) + full-reindex on embedder change; index/query CLI; unit tests. |
| **R2 — Retrieval + free gates + format** | retriever: embed query → vector search → free gates (threshold/dedup/recency/budget) → `<retrieved-memory>` block (verbatim, source-tagged, truncate+pointer); warm embedding **PM2 service**; `retrieve.js` thin client with **fail-open + ~800ms timeout**; tests on a fixed corpus. |
| **R3 — Hook wiring + freshness** | `post-install` registers `UserPromptSubmit`→`retrieve.js` (pre-uninstall removes); **per-tier freshness** (content-hash diff): memory tier re-index on Memory-Sync/checkpoint (+ mtime first-pass); non-memory tiers via fs-watcher (debounced) + scheduler sweep; trigger skip-rule; live end-to-end on Claude Code. |
| **R4 — LLM gatekeeper** | filter interface + `none`/`llm` drivers; optional rerank stage; off the sync path. |
| **R5 — Multi-provider + eval** | more embedder drivers (bge-m3, API); named per-embedder indexes; **eval harness** (labeled query→expected-memory → Recall@K / Precision@K). |

**v1 = R1–R3.**

## 8. Success objective

**Intrinsic:** labeled eval set (~30–50 real messages → expected chunk). **Recall@5 ≥ ~85%** on queries that have a relevant memory (primary — if not retrieved, unusable); high Precision@K; rank quality (MRR/nDCG); **~zero false-positive injection** on negative/trivial queries (must return empty block). Tune threshold/top-K/chunk-size empirically against this set.
**Extrinsic:** did surfacing the memory improve the answer — judgment-based log spot-checks.

## 9. Robustness & security (must-haves)

- **Fail-open** with ~800ms hard timeout on the hook path — never block or break a turn (protects heartbeat/liveness).
- **Never index secrets** — `.env`, tokens-in-configs are hard-excluded by the denylist; retrieved chunks could otherwise leak into context/logs/responses.
- Query↔passage prefix asymmetry encoded in the e5 driver (recall tanks otherwise).
- sqlite **WAL** for concurrent reconcile-write vs query-read.
- Retrieval logging on (query, chunks, scores) — **no secrets**.
- Chunk overlap ~15% for boundary recall.

## 10. Future

- bge-m3 / API embedders + named-index A/B (R5)
- LLM rerank (R4)
- Upgrade C3's mtime-only memory freshness with recall's per-chunk content-hash
