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
hit/miss, and forbid violations, followed by an aggregate summary. It exits
non-zero when the summary falls below `eval/baseline.json`.

Golden case sources use the `corpus/...` prefix. The index itself is rooted at
`eval/corpus`, and the runner normalizes indexed source paths for reporting.

## Sweep

```bash
node eval/run.js --sweep threshold=0.30:0.80:0.05
node eval/run.js --sweep 'threshold=0.45:0.70:0.05,recencyWeight=0|0.05,topK=3|5'
```

Sweep mode embeds and retrieves each query's candidate pool once, then reapplies
post-embedding free gates in memory for every grid point.

Ties are sorted deterministically by score descending, then source ascending.

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
