# Full stack benchmark report automation

Run the complete serial 72-cell macOS and Ubuntu 22.04 ARM64 cold/hot matrix
and build the report from the resulting sanitized data:

```sh
SBR_GO=1 python3 tools/stack-benchmarks/run.py \
  --ref 95c5ab8be71988d244dfa4537db8e454a0bf2e84 \
  --vm orb \
  --output /tmp/stack-benchmarks-run-2026-09-07
```

Run this from the repository root. `--ref`, `--vm`, and `--output` identify
the source revision, the SSH alias for the Linux VM, and a new run directory.
The package resolves its runner, harness, report tools, renderer, and source
checkout relative to this repository; no machine-specific temporary paths or
user names are required. Use `--dry-run` to print the matrix without setup or
timing. `SBR_GO=1` is the explicit gate for a timed campaign.

The host must be macOS ARM64 with Git, Bun, pnpm, GitHub CLI, SSH, SCP, and
Python. The VM must be an OrbStack Ubuntu 22.04 ARM64 environment reachable
through the SSH alias, with Docker/containerd, Bun, pnpm, and passwordless
`sudo`. OrbStack must expose macOS `/Users` and `/private/tmp` at the same
paths in the VM and resolve `host.docker.internal`; the setup preflight checks
these mounts before timing. Other generic SSH VMs are not supported by this
harness. The coordinator copies the runner and harness into an isolated remote
run root and records all paths in `run.json`.

Source and legacy CLI checkouts have isolated `node_modules` directories, while
pnpm uses its normal content-addressed package store so repeated setup does not
duplicate packages. Native artifact homes and private Docker/containerd stores
remain fresh and isolated for each benchmark run.

Cold cells use isolated preparation and caches. Hot cells retain the shared
project/cache state, but each sample performs its own warmup before collecting
restart and memory measurements. Both phases include the plain legacy baseline,
the pooler-enabled legacy eager baseline, and four new-stack cases; eager
comparisons use the pooler-enabled baseline. Failed product cells remain
counted as failed attempts, while setup failures are retained separately. No
missing measurement is replaced with an inferred number.

The run writes `run.json`, raw `campaign/` cell data, sanitized
`benchmark-data.json`, and `report/`. Raw logs, commands, credentials, and
container snapshots are never passed to the report builder. The command never
pushes or publishes Git state.

Resume an interrupted run after checking its exact run directory:

```sh
SBR_GO=1 python3 tools/stack-benchmarks/run.py \
  --resume /tmp/stack-benchmarks-run-2026-09-07
```

Resume verifies the resolved commit, runner manifest, VM configuration, and
catalog/artifact provenance before reusing completed cells. To rebuild a
report without setup or timing, render saved canonical data directly:

```sh
python3 tools/stack-benchmarks/run.py \
  --render /tmp/stack-benchmarks-run-2026-09-07/benchmark-data.json \
  --output /tmp/stack-benchmarks-run-2026-09-07/report
```

The renderer uses the pinned `@resvg/resvg-js` 2.6.2 dependency and lockfile
under `render/`; the first render installs that isolated package when needed.
