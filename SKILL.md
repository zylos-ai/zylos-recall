---
name: recall
version: 0.1.0
description: >
  Proactive memory retrieval (RAG) for Zylos memory. R1 provides the local
  Markdown corpus indexer and sqlite-vec chunk store; turn-time retrieval and
  hook injection arrive in later slices.
type: capability  # communication | capability | utility

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-recall
    entry: src/index.js
  data_dir: ~/zylos/components/recall
  hooks:
    configure: hooks/configure.js
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
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
```

R1 is indexer-only. It does not register `UserPromptSubmit`, run turn-time
retrieval, or inject `<retrieved-memory>` blocks yet.
