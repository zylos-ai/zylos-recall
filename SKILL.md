---
name: recall
version: 0.0.8
description: >
  Proactive memory retrieval (RAG) for Zylos memory. Provides the local
  Markdown corpus indexer, sqlite-vec chunk store, warm retrieval service, and
  fail-open turn-time retrieval client.
type: capability  # communication | capability | utility

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-recall
    entry: src/server.js
  data_dir: ~/zylos/components/recall
  hooks:
    configure: hooks/configure.js
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
    pre-uninstall: hooks/pre-uninstall.js
  preserve:
    - config.json
    - data/
    - index.sqlite
    - models/

# For HTTP services exposed through Zylos Caddy, prefer a root-internal app:
# - The component listens on localhost and serves internal routes at /.
# - Caddy exposes it at /recall/*, strips that prefix, and forwards
#   X-Forwarded-Prefix. Browser URLs should be relative by default and should
#   use X-Forwarded-Prefix when present.
# http_routes:
#   - path: /recall/*
#     type: reverse_proxy
#     target: localhost:3000
#     strip_prefix: /recall

upgrade:
  repo: zylos-ai/zylos-recall
  branch: main

config:
  required:
    # Values are collected by zylos and passed to lifecycle.hooks.configure as stdin JSON.
    # The configure hook decides how to store them in config.json.
    # - name: RECALL_API_KEY
    #   description: API key for recall
    #   sensitive: true
  optional:
    # - name: RECALL_DEBUG
    #   description: Enable debug mode
    #   default: "false"

dependencies: []
---

# Recall

```bash
zylos-recall index
zylos-recall query "what did Felix decide about Discord VC?"
zylos-recall retrieve "what did Felix decide about Discord VC?"
zylos-recall recall "what did Felix decide about Discord VC?"
zylos-recall toc --full
zylos-recall config get retrieval.topK
zylos-recall config set retrieval.topK 12
zylos-recall config set filter.provider rerank
zylos-recall config deny list
zylos-recall config deny add 'workspace/scratch/**'
```

The service runs the configured hybrid retrieval pipeline and emits
`<retrieved-memory>` blocks through the registered `UserPromptSubmit` hook.
Freshness is maintained by startup indexing, filesystem-change debounce where
supported, and periodic corpus sweeps.

## Deliberate Recall (Tool Face)

Use `zylos-recall recall "<query>"` when memory should be consulted on purpose,
especially at the kickoff of planning or review tasks, before concluding that
"we never documented X", for cross-session or months-old questions, and after a
session rotation when context feels thin.

Use `zylos-recall toc` first when you do not know what exists. Use
`zylos-recall recall` when you already know the topic or source shape. `toc`
reads sqlite only and does not load the embedder; compact output lists tier,
source, date, and chunk counts, while `--full` adds section titles.

`recall` prefers the warm service and falls back to direct local retrieval if
the service is unavailable. It prints plain hit blocks by default, not a
`<retrieved-memory>` wrapper. Use `--format json` for structured
`{source, section, date, scores, text}` output.

## Runtime Knobs

Use `zylos-recall config get [<dot.path>]` to inspect the effective
defaults-merged config. Use `zylos-recall config set <dot.path> <value>` for
allowlisted runtime knobs only.

Common recipes:

```bash
# Ambient candidate count
zylos-recall config set retrieval.topK 12

# Gatekeeper reranker toggle
zylos-recall config set filter.provider rerank
zylos-recall config set filter.provider none
```

Use `zylos-recall config allow|deny list` and
`config allow|deny add|remove <pattern>` to edit corpus lists one entry at a
time; edits always write the complete effective list, removing a built-in
secret-protection deny entry requires `--force`, and the first edit pins the
current list in `config.json` so future default-list additions will not
auto-apply to that install. Corpus changes take effect at the next reindex.
The retrieval pipeline, paths, and ports are intentionally not settable from
one-line commands.
The service watches the config directory, so creating or replacing
`config.json` reloads it once after duplicate filesystem events settle and
restarts runtime. The hook client reads `service.timeoutMs` each turn, so
timeout changes affect new hook calls immediately. Reranker warmup happens on
the next service runtime start/restart. Setting `enabled` to `false` stops the
PM2-managed service cleanly; set it back to `true` and run
`pm2 start zylos-recall` to re-enable it because the stopped process no longer
has a live config watcher.
