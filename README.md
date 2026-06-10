<p align="center">
  <img src="./assets/logo.png" alt="Zylos" height="120">
</p>

<h1 align="center">zylos-recall</h1>

<p align="center">
  Proactive memory retrieval (RAG) — surfaces relevant memory into context each turn
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg" alt="Node.js"></a>
  <a href="https://discord.gg/GS2J39EGff"><img src="https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://x.com/ZylosAI"><img src="https://img.shields.io/badge/X-follow-000000?logo=x&logoColor=white" alt="X"></a>
  <a href="https://zylos.ai"><img src="https://img.shields.io/badge/website-zylos.ai-blue" alt="Website"></a>
  <a href="https://coco.xyz"><img src="https://img.shields.io/badge/Built%20by-Coco-orange" alt="Built by Coco"></a>
</p>

---

`zylos-recall` is a private capability component for proactive memory retrieval.
It walks an allowlisted Markdown corpus, splits documents by semantic sections,
embeds chunks with multilingual-e5-small, stores records plus vectors in
SQLite/sqlite-vec, and serves turn-time retrieval from a warm local service.

## Install

```bash
zylos add recall
```

Or manually:

```bash
cd ~/zylos/.claude/skills
git clone https://github.com/zylos-ai/zylos-recall.git recall
cd recall && npm install
```

## Configuration

Edit `~/zylos/components/recall/config.json`:

```json
{
  "enabled": true,
  "corpus": {
    "roots": ["~/zylos"],
    "allow": [
      "memory/reference/**/*.md",
      "memory/users/**/*.md",
      "memory/sessions/current.md",
      "http/public/pages/**/*.md",
      ".claude/skills/*/SKILL.md",
      ".claude/skills/*/references/**/*.md",
      "workspace/*.md",
      "workspace/**/README.md",
      "workspace/**/DESIGN.md",
      "workspace/**/CHANGELOG.md",
      "workspace/**/docs/*.md",
      "workspace/**/CLAUDE.md"
    ],
    "deny": [
      "**/.git/**",
      "**/.backup/**",
      "**/.zylos/**",
      "**/node_modules/**",
      "**/logs/**",
      "**/*.log",
      "**/.env",
      "**/.env.*",
      "**/*secret*",
      "**/*secret*/**",
      "**/*token*",
      "**/*token*/**",
      "**/*credential*",
      "**/*credential*/**",
      "**/*password*",
      "**/*password*/**",
      "**/*apikey*",
      "**/*apikey*/**",
      "**/*api-key*",
      "**/*api-key*/**",
      "**/*api_key*",
      "**/*api_key*/**",
      "**/*privatekey*",
      "**/*privatekey*/**",
      "**/*private-key*",
      "**/*private-key*/**",
      "**/*private_key*",
      "**/*private_key*/**",
      "**/*.pem",
      "**/*.key",
      "memory/identity.md",
      "memory/state.md",
      "memory/references.md",
      "memory/archive/**",
      "CLAUDE.md",
      "AGENTS.md",
      "ZYLOS.md",
      "**/*.bak",
      "**/*.backup",
      "**/*.RETIRED",
      "**/index.sqlite",
      "**/index.sqlite-*"
    ]
  },
  "embedder": {
    "provider": "local-onnx",
    "model": "Xenova/multilingual-e5-small",
    "dimension": 384
  },
  "retrieval": {
    "pipeline": ["denseRetrieve", "bm25Retrieve", "rrfFuse", "freeGates", "assemble"],
    "topK": 5,
    "bm25TopK": 10,
    "rrfK": 60,
    "bm25AdmitTopN": 2,
    "threshold": 0.35,
    "maxTotalTokens": 1500,
    "chunkTokens": 350,
    "recencyWeight": 0.05,
    "tierPenalties": {
      "session": 0.05
    }
  },
  "service": {
    "host": "127.0.0.1",
    "port": 37537,
    "timeoutMs": 1000
  },
  "freshness": {
    "enabled": true,
    "watch": true,
    "sweep": true,
    "debounceMs": 1000,
    "sweepIntervalMs": 300000
  },
  "filter": {
    "provider": "none",
    "model": "Xenova/bge-reranker-base",
    "dtype": "q8",
    "threshold": 0.5,
    "keepK": 5,
    "maxPassageTokens": 128
  }
}
```

> **Warning:** arrays in `config.json` **replace** the built-in defaults
> entirely — they are not merged. If you customize `corpus.allow` or
> `corpus.deny`, start from the complete default list (shown above for `deny`);
> omitting entries silently removes those protections. Prefer
> `zylos-recall config allow|deny add|remove` below, which always writes the
> complete list for you.

## Usage

```bash
# Print the effective defaults-merged config, or one setting.
npx zylos-recall config get
npx zylos-recall config get retrieval.topK

# Adjust safe runtime knobs without hand-editing JSON.
npx zylos-recall config set retrieval.topK 12
npx zylos-recall config set filter.provider rerank

# Edit corpus allow/deny lists one entry at a time (no JSON hand-editing).
npx zylos-recall config deny list
npx zylos-recall config deny add 'workspace/scratch/**'
npx zylos-recall config allow add 'notes/**/*.md'
npx zylos-recall config allow remove 'notes/**/*.md'

# Build or incrementally refresh the local index
npx zylos-recall index

# Smoke query the vector index
npx zylos-recall query "discord voice channel decisions"

# Run the gated retrieval pipeline and print a <retrieved-memory> block
npx zylos-recall retrieve "discord voice channel decisions"

# Deliberately search memory for a planning/review task. This prefers the warm
# service, falls back to direct local index access if needed, and prints hits
# without the hook-only <retrieved-memory> wrapper.
npx zylos-recall recall "discord voice channel decisions"
npx zylos-recall recall --top-k 15 --format json "discord voice channel decisions"

# List indexed sources from sqlite without loading the embedder.
npx zylos-recall toc
npx zylos-recall toc --tier session --full

# Audit what recall actually injected: pair each user prompt in the live
# Claude Code session transcript with the <retrieved-memory> block it received
# (or "stayed quiet"). Reads Claude's own transcript, so it reflects what truly
# reached context. Claude Code runtime only.
npx zylos-recall inspect --last 12          # summarized (sources per turn)
npx zylos-recall inspect --last 12 --full   # full injected block per turn
npx zylos-recall inspect --session <id>     # an older session
npx zylos-recall inspect --retrieval-log    # service/client retrieval.jsonl

# Start the warm local retrieval service
npm start
```

## Config CLI

`zylos-recall config get [<dot.path>]` prints the effective config after
defaults are merged. Recall config does not contain secret keys; tests assert
that stays true.

`zylos-recall config set <dot.path> <value>` updates only allowlisted runtime
knobs:

```text
enabled
retrieval.topK
retrieval.bm25TopK
retrieval.rrfK
retrieval.bm25AdmitTopN
retrieval.threshold
retrieval.maxTotalTokens
retrieval.recencyWeight
retrieval.tierPenalties.<tier>
filter.provider
filter.threshold
filter.keepK
service.timeoutMs
```

Structural settings such as the retrieval pipeline, paths, and ports are
intentionally not settable from a one-line CLI command. Values are parsed by
target type and then validated through the same config save path used by
hooks; invalid values leave the config file untouched. Writes are atomic and
create the config file with mode `0600`.

`zylos-recall config allow|deny list` prints the effective corpus list, and
`config allow|deny add|remove <pattern>` edits it one entry at a time:

```bash
npx zylos-recall config deny add 'workspace/scratch/**'
npx zylos-recall config deny remove 'workspace/scratch/**'
```

Add/remove is idempotent and order-preserving, and always writes the complete
effective list — so a partial array can never silently drop default
protections. Two consequences to know:

- **Pinning:** your first list edit stores the complete current list in
  `config.json`. Future zylos-recall releases that add new default entries will
  not auto-apply to that install; re-add them manually if you want them.
- **Guardrail:** removing a built-in secret-protection deny entry (for example
  `**/*secret*` or `**/*.pem`) is refused unless you pass `--force`, because it
  can expose credential-like files to indexing.

Corpus list changes take effect at the next reindex (freshness watch/sweep or
service restart).

Two common recipes:

```bash
# Adjust ambient candidate count.
npx zylos-recall config set retrieval.topK 12

# Toggle the gatekeeper reranker.
npx zylos-recall config set filter.provider rerank
npx zylos-recall config set filter.provider none
```

Apply semantics: the running service watches the config directory, so creating
or replacing `config.json` reloads it once after duplicate filesystem events
settle and restarts runtime. The hook client reads config each turn, so
`service.timeoutMs` affects new hook calls immediately; reranker model warmup
happens on the next service runtime start/restart. Setting `enabled` to `false`
exits the service with code 0; PM2 parks it as `waiting restart` without
relaunching it or marking it errored. Set it back to `true` and run
`pm2 start zylos-recall` to re-enable it because the parked process no longer
has a live config watcher.

The install/upgrade hooks register `src/retrieve.js` as a Claude
`UserPromptSubmit` hook. The hook client fails open and only emits
`additionalContext` when the service returns a non-empty `<retrieved-memory>`
block. C4 channel and routing envelopes are stripped before retrieval, so only
the current user message is embedded.

Retrieval uses a hybrid pipeline by default: dense vector search, FTS5 BM25
keyword search, reciprocal rank fusion, free gates, then assembly. Cosine
thresholds still gate dense-found candidates. BM25-only candidates are admitted
only from the narrow `bm25AdmitTopN` rescue set, and the rest are logged as
`bm25WeakNoDense`. Existing configs keep their configured `retrieval.pipeline`
on upgrade; add `bm25Retrieve` and `rrfFuse` manually to opt in. The BM25
index uses SQLite FTS5 `unicode61`, which does not segment CJK text well, so
dense retrieval remains the main path for Chinese/Japanese/Korean content.
Session-log chunks from `memory/sessions/current.md` are indexed as a separate
`session` tier. They pass the same gates as other chunks, but default scoring
subtracts `retrieval.tierPenalties.session` so curated memory wins equal-score
ties while strong current-session hits can still surface. Session chunks are
tagged in assembled context as session logs that may be superseded.
Skill `references/` directories are watched when the service starts; if a new
skill is installed while recall is already running, its references are still
picked up by the periodic sweep and get direct watch coverage after restart.

For deliberate agent use, `zylos-recall recall "<query>"` runs the same
configured retrieval pipeline with tool-mode defaults (`topK:10`,
`bm25TopK:15`, `maxTotalTokens:3000`) and server-side clamps (`topK` and
`bm25TopK` max 25, `maxTotalTokens` max 6000). It returns text blocks or JSON
hits shaped as `{source, section, date, scores, text}`. `zylos-recall toc`
reads the chunk table directly from sqlite, groups indexed files by metadata
tier, and stays compact by default; use `--full` to include section titles.

The service listens before model warmup/indexing finishes, so hooks fail open
instead of blocking startup while models load. Freshness is maintained by
background startup indexing, narrowly scoped filesystem watches where supported,
and a periodic corpus mtime/size sweep fallback. Retrieval drops candidates when
the source file has changed since indexing. The service reports ready only after
embedder warmup, optional reranker warmup, and the initial freshness startup
index complete. If the optional reranker fails to warm or score a turn, retrieval
continues fail-open without it. The reranker scores with a cheap pre-tokenizer
passage slice plus a tokenizer length cap (`filter.maxPassageTokens`, default
128) for latency only; stored chunks and assembled memory are unchanged.
Retrieval metadata, stage timings, tokenizer caps, per-stage candidate IDs, and
scores are appended to `~/zylos/components/recall/logs/retrieval.jsonl` without
chunk text. The hook client also appends compact `kind:"client"` outcome lines
so assembled service results can be distinguished from context actually
delivered before the timeout.

## Eval Harness

The deterministic eval harness lives in `eval/`. It builds an eval-only index
from frozen fixtures, runs golden query cases through the real retrieval path,
reports ranker-ceiling P@k/Recall@k/MRR/nDCG plus gated injection/quiet metrics,
and can sweep threshold/recency/topK without re-embedding each grid point.

```bash
node eval/build-index.js
node eval/run.js
node eval/run.js --sweep threshold=0.30:0.80:0.05
```

See [eval/README.md](./eval/README.md) for the golden-case schema and baseline
update process.

## Built by Coco

Zylos is the open-source core of [Coco](https://coco.xyz/) — the AI employee platform.

## License

[MIT](./LICENSE)
