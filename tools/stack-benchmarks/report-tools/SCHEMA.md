# Fresh campaign input schema

`render.py` accepts one JSON object and refuses to render until all required measurements exist. Numeric fields are seconds or MiB as named. Every phase should also carry `rangeSeconds`, `attempts`, `successes`, and `failures` for report prose; the renderer uses `medianSeconds`.

```json
{
  "metadata": {
    "date": "YYYY-MM-DD",
    "commit": "...",
    "legacyVersion": "...",
    "pullRequest": "6440",
    "pullRequestUrl": "https://github.com/...",
    "environment": "...",
    "artifactBarrier": "...",
    "sourceProvenance": ["relative/source.json"]
  },
  "startup": {
    "linux": {
      "legacy": { "cached": { "medianSeconds": 0 }, "cold": { "medianSeconds": 0 } },
      "legacyEager": {},
      "dockerDefault": {},
      "dockerEager": {},
      "nativeDefault": {},
      "nativeEager": {},
      "restarts": {
        "legacy": { "medianSeconds": 0, "attempts": 1, "successes": 1, "failures": 0 },
        "legacyEager": {},
        "dockerDefault": {},
        "dockerEager": {},
        "nativeDefault": {},
        "nativeEager": {}
      }
    },
    "macos": "same shape"
  },
  "processMemory": {
    "observations": { "starts": 36, "snapshots": 108, "windowSeconds": "30–40" },
    "cases": {
      "linux": {
        "legacy-default": {
          "metrics": { "rssMiB": { "median": 0, "rangeMiB": [0, 0] }, "pssMiB": { "median": 0 } }
        },
        "legacy-pooler": {},
        "docker-default": {},
        "native-default": {},
        "docker-eager": {},
        "native-eager": {}
      },
      "macos": "same case keys; rssMiB required, pssMiB optional"
    }
  }
}
```

Cold data must include both hosts and all six startup cases, including the pooler-enabled legacy eager baseline. Default comparisons use `legacy`; eager comparisons use `legacyEager`. Retained-data restarts must include actual counts, successes, failures, and ranges. No placeholder number is accepted by validation; charts are emitted only after a complete dataset is supplied.
