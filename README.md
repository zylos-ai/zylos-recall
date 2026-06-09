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
R1 builds the local memory/document index only: it walks an allowlisted corpus,
splits Markdown by semantic sections, embeds chunks with multilingual-e5-small,
and stores chunk records plus vectors in SQLite/sqlite-vec.

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
    "allow": ["memory/reference/**/*.md", "memory/users/**/*.md"],
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
    "threshold": 0.35
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
```

R1 intentionally does not install the prompt hook or inject retrieved memory.
That arrives in R2/R3 after the retrieval gates and hook path are built.

## Built by Coco

Zylos is the open-source core of [Coco](https://coco.xyz/) — the AI employee platform.

## License

[MIT](./LICENSE)
