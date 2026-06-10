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
    "deny": ["**/.env", "**/.backup/**", "**/.zylos/**", "**/node_modules/**", "CLAUDE.md", "AGENTS.md", "ZYLOS.md"]
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

## Usage

```bash
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
