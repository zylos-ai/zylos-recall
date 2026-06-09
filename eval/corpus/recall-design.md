# Recall Design

Status: current, dated 2026-06-09.

## Embedder Choice

Recall uses the multilingual-e5-small embedder through the ONNX-compatible
Xenova artifact. The driver applies the required e5 prefixes: query text is
embedded with a `query:` prefix and indexed memory passages are embedded with a
`passage:` prefix. This keeps query and passage vectors aligned.

## Retrieval Pipeline

The current deterministic retrieval path is dense retrieval followed by free
gates and assembly. The v1 ranker uses sqlite-vec scores, deduplication,
recency weighting, token budget trimming, and source-tagged retrieved-memory
assembly.

## Live Hook Behavior

The hook strips C4 routing envelopes before embedding. Only the user's current
message should become the retrieval query; reply-via commands and channel
transport vocabulary must not influence memory ranking.

