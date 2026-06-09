# Recall Eval Harness

The eval harness runs the real recall indexer and retriever against a frozen,
checked-in corpus under `eval/corpus/`. It never reads live memory or writes the
live recall index.

## Build

```bash
node eval/build-index.js
```

`build-index.js` rebuilds `eval/index.sqlite` from scratch on every run. This
keeps eval state deterministic and avoids stale local rows while tuning.

## Run

```bash
node eval/run.js --build
node eval/run.js
```

The runner prints per-case Precision@k, Recall@k, MRR, nDCG@k, injection
recall/precision, quiet status, and forbid violations, followed by an aggregate
summary. Ranking metrics are reported over should-hit cases only; expect-empty
cases are scored by quiet accuracy. It exits non-zero when the summary falls
below `eval/baseline.json`.

The checked-in baseline is measured from the green run at the live threshold
(`0.65`) on the curated 18-case golden set. It allows the two known
channel-distractor leaks in `envelope-strip-rationale` pending the R4 usefulness
gate; tighten it as retrieval improves.

Golden case sources use the `corpus/...` prefix. The index itself is rooted at
`eval/corpus`, and the runner normalizes indexed source paths for reporting.

## Sweep

```bash
node eval/run.js --sweep threshold=0.30:0.80:0.05
node eval/run.js --sweep 'threshold=0.45:0.70:0.05,recencyWeight=0|0.05,topK=3|5'
```

Sweep mode embeds and retrieves each query's candidate pool once, then reapplies
post-embedding free gates in memory for every grid point. The sweep objective is
gated-set behavior: injected recall, injected precision/F1, quiet accuracy, and
zero forbid violations. Pre-gate P@k/Recall@k/MRR/nDCG are the static ranker
ceiling and are not used as the threshold objective.

Ties are sorted deterministically by score descending, then source ascending.
Multiple chunks from the same source are deduped by source before file-level
metrics are computed.

Fixture files can include `date: YYYY-MM-DD` or prose like `dated YYYY-MM-DD`.
`build-index.js` applies those dates to fixture mtimes before indexing. Fixtures
without an explicit date are stamped to `2026-01-01`, so every eval mtime is
deterministic across checkouts while dated supersession pairs remain ordered.

## Add A Case

Add a fixture under `eval/corpus/`, rebuild the eval index, then add an entry to
`eval/golden/golden.json`:

```json
{
  "id": "short-stable-id",
  "query": "what should recall find",
  "context": null,
  "expect": [{ "source": "corpus/preferences.md", "grade": 3 }],
  "forbid": ["corpus/noise-france.md"],
  "notes": "why this case exists"
}
```

Grades are `3=ideal`, `2=good`, and `1=acceptable`. `context` is currently
forward-compatible metadata for future query-side summarizer evaluation; the
deterministic baseline uses the bare query.
