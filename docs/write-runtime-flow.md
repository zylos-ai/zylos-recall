# recall v0.2 — Write Runtime Flow (distill-at-rotation subagent)

**What this is.** The offline *write* path of recall v0.2: a background subagent (a sibling of Memory Sync) that, at session rotation, distills the just-ended session into atomic `{key, value}` memory nodes. It mirrors the validated `distillSession` loop in `src/lib/write-orchestrator.js`, executed via the recall CLI ops + the subagent's own LLM reasoning.

**Why a subagent (not a script).** The extract/consolidate steps need a model, and the design constraint is *no separate API key* — the model is the agent runtime. Only an LLM (a subagent) can both reason *and* call tools; deterministic code can't call the runtime model. So the subagent drives the deterministic ops via CLI and does the two LLM steps itself — exactly how Memory Sync works. `distillSession` (W2b-core) is the validated executable spec + test harness this flow mirrors; keep them in lockstep.

---

## Trigger

Fired at **session rotation** (the ~70%-context point) — the same lifecycle moment Memory Sync uses. Launch as a **background subagent** (model: Sonnet to start; Opus is an A/B add-on) with this document as its flow prompt. Coordinate with Memory Sync so the session isn't independently LLM-distilled twice (share the conversation fetch where practical).

*(Trigger/registration wiring = the W2b-runtime-trigger slice, code — Local's lane.)*

## Inputs

The rotating session's conversation messages, fetched the way Memory Sync fetches (`c4-fetch.js` / the session transcript), written to a temp JSON **array** file (`[{text|content}|string, ...]`).

## Flow (the subagent executes these steps)

1. **Segment** — write the messages to a temp JSON file, then run:
   `zylos-recall segment --session <file.json>` → JSON array of segment index-groups. (W4)

2. **Per segment — extract.** Build the segment text from its member messages (the CLI/W4 path already strips C4 envelope + reply-via plumbing via `normalizeTopicText`). Apply the **EXTRACTION prompt** (source of truth: `EXTRACTION_PROMPT` exported from `src/lib/write-orchestrator.js`, §11b) to the segment text → `{"memories":[{"key","value"}]}`. **Validate + repair:** require valid JSON + non-empty `key`+`value` per item; re-prompt up to 2× on malformed; skip a persistently-bad item (do **not** sink the rest of the batch).

3. **Per memory item — consolidate + apply.**
   a. `zylos-recall node-search --key "<key>" --k 5` → neighbors `[{id,key,value,score}]`. (W2a)
   b. **Exact-key backstop:** if a neighbor's `key` **exactly** equals the new key → do **NOT** CREATE; route to **UPDATE** that neighbor (or NOOP if the value is already represented). (`writeNode` is idempotent-by-`(kind,key)`; an exact-key CREATE would silently overwrite a distinct fact.)
   c. Otherwise apply the **CONSOLIDATION prompt** (source of truth: `CONSOLIDATION_PROMPT` from `src/lib/write-orchestrator.js`, §11b) with the new item + neighbors → `{operation, target_id, value}`. **Validate:** `operation ∈ {CREATE,UPDATE,NOOP}`; for UPDATE, `target_id` must be one of the given neighbor ids (else repair/skip — never invent an id). Fail-closed on malformed.
   d. Apply: `zylos-recall node-apply --op <OP> [--target-id <id>] [--key "<key>"] [--value "<value>"]` → `{id, op}`. (W2a)

4. **Summary** — report `{segments, created, updated, noop, skipped}` and mark the trigger task done.

## Principles

- **Offline = spend on quality.** No hot-path latency budget here; use the best model tier available. The whole system rests on key quality.
- **Prompts are single-source.** Apply the `EXTRACTION_PROMPT` / `CONSOLIDATION_PROMPT` constants from `write-orchestrator.js` verbatim — do not paraphrase them here (avoids drift; this doc is the *procedure*, those constants are the *prompts*).
- **Coexistence.** The CLI ops sit before the recall `config.enabled` gate, so the write path runs even while the read service is disabled. They use the component's configured index.
- **Mirror, don't fork.** This flow is the human/agent-readable mirror of `distillSession`; if the orchestrator logic changes, update this doc (and vice versa).

---

*W2b-runtime = this flow doc (the §11b-prompt distill procedure, VM-authored) + the trigger/registration wiring (Local-authored code). Reviewed + merged together as the W2b-runtime slice.*
