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
      "http/public/pages/**/*.md",
      ".claude/skills/*/SKILL.md",
      "workspace/*.md",
      "workspace/**/README.md",
      "workspace/**/DESIGN.md",
      "workspace/**/CHANGELOG.md"
    ],
    "deny": ["**/.env", "**/node_modules/**", "memory/sessions/**"]
  },
  "embedder": {
    "provider": "local-onnx",
    "model": "Xenova/multilingual-e5-small",
    "dimension": 384
  },
  "retrieval": {
    "pipeline": ["denseRetrieve", "freeGates", "assemble"],
    "topK": 5,
    "threshold": 0.35,
    "maxTotalTokens": 1500,
    "chunkTokens": 350,
    "recencyWeight": 0.05
  },
  "service": {
    "host": "127.0.0.1",
    "port": 37537,
    "timeoutMs": 800
  },
  "freshness": {
    "enabled": true,
    "watch": true,
    "sweep": true,
    "debounceMs": 1000,
    "sweepIntervalMs": 300000
  },
  "filter": { "provider": "none" }
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

# Start the warm local retrieval service
npm start
```

The install/upgrade hooks register `src/retrieve.js` as a Claude
`UserPromptSubmit` hook. The hook client fails open and only emits
`additionalContext` when the service returns a non-empty `<retrieved-memory>`
block. C4 channel and routing envelopes are stripped before retrieval, so only
the current user message is embedded.

The service listens before model warmup/indexing finishes, so hooks fail open
instead of blocking startup while the model loads. Freshness is maintained by
background startup indexing, narrowly scoped filesystem watches where supported,
and a periodic corpus mtime/size sweep fallback. Retrieval drops candidates when
the source file has changed since indexing. The service reports ready only after
warmup and the initial freshness startup index complete. Retrieval metadata is
appended to `~/zylos/components/recall/logs/retrieval.jsonl` without chunk text.

## Eval Harness

The deterministic eval harness lives in `eval/`. It builds an eval-only index
from frozen fixtures, runs golden query cases through the real retrieval path,
reports P@k/Recall@k/MRR/nDCG, and can sweep threshold/recency/topK without
re-embedding each grid point.

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
