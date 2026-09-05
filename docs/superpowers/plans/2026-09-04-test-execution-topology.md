# Test execution topology: Turbo + Vitest 5

Status: agreed 2026-09-04, implementation in three PRs (A: #6472, B: #6473, C: stacked on B). Vocabulary and the decisions worth keeping after this plan is done live in
ADR 0024.

## Goals and how ties break

1. **PR CI wall-clock** is the objective. Compute is a soft budget (roughly
   1.5x today's runner minutes is acceptable when it shortens the longest job).
2. **Local dev loop** second: one hop from any script to Vitest, filter by kind
   or package from anywhere, quiet output from passing tests.
3. **Configuration simplicity** is a constraint, not a goal in itself.

## Measured baseline (develop, 2026-09-03)

| Job                | Setup | Work               | Notes                                                                                         |
| ------------------ | ----- | ------------------ | --------------------------------------------------------------------------------------------- |
| Unit               | 1.5m  | 1.8m               | six Turbo-launched Vitest processes; CLI package is 73s of the 74s                            |
| Integration        | 1.3m  | 4.0m               |                                                                                               |
| E2e shard 1/2/3    | ~1.5m | 7.9m / 5.6m / 3.3m | 889s total; 13 stack-backed files (develop) are about 633s of it; every e2e project is serial |
| Check code quality | 1.9m  | 0.4m               |                                                                                               |

Turbo's cache is cold on every CI run (no remote cache, `.turbo` not persisted)
and every test task is `cache: false`, so no test caching or `--affected`
skipping exists today.

## Decisions

| #   | Decision                  | Chosen                                                                                                                                                                                                                                                               |
| --- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Tie-breaker between goals | PR CI wall-clock                                                                                                                                                                                                                                                     |
| 2   | Compute budget            | Soft; wall-clock wins within ~1.5x minutes                                                                                                                                                                                                                           |
| 3   | Unit/integration runner   | One root Vitest process; Turbo drops out of unit/integration                                                                                                                                                                                                         |
| 4   | E2e parallelism           | Stackless e2e files run in parallel; stack-backed files stay serial                                                                                                                                                                                                  |
| 5   | Stack-backed marker       | File suffix `*.stack.e2e.test.ts`                                                                                                                                                                                                                                    |
| 6   | E2e CI topology           | One root Vitest run per shard, as Turbo root task `//#test:e2e` depending on `supabase#build`                                                                                                                                                                        |
| 7   | Shard balance             | Durations from the develop run (`develop-tests.yml` merges shard JSON reports into `.vitest/shard-weights.json`, cached); the PR gate job publishes them as a run artifact; the sequencer assigns largest-first per class and deals by count when the file is absent |
| 8   | Unit/integration CI shape | One root run over both kinds, `--shard=N/2`, matrix of two jobs                                                                                                                                                                                                      |
| 9   | Coverage                  | Removed from PR runs; develop-push workflow produces one merged root report                                                                                                                                                                                          |
| 10  | Job gating                | Path rules: docs/release-notes only skips all tests; Go-only skips unit/integration, keeps e2e; `.github` or any TS workspace runs everything                                                                                                                        |
| 11  | Scripts                   | Packages: direct Vitest, one hop, no `:run` layer. Root: `test`, `test:unit`, `test:integration` are root Vitest; `test:e2e`, `test:live` stay Turbo tasks                                                                                                           |
| 12  | Runtime tuning            | `fsModuleCache` on, `node_modules/.vitest-cache` restored in CI, one `vitest doctor` run recorded; no isolation or pool changes                                                                                                                                      |
| 13  | Delivery                  | Three PRs; Vitest-4-safe work first because Vitest 5.0.0 is firewall-quarantined                                                                                                                                                                                     |

Considered and rejected: per-package Turbo test caching (test inputs span
sibling packages, the built binary, Docker, and env; CI cache is cold anyway);
`turbo --affected` as the job gate (Turbo's package graph does not know the CLI
depends on the Go sidecar, and a gate job would add ~1.3m install to every PR);
a committed duration manifest for sharding (data that drifts, for about one
more minute); `isolate: false` (about 40 test files depend on per-file
isolation).

## PR A: e2e split and job gating (Vitest 4, land now)

Independent of the Vitest 5 upgrade. Expected effect: worst e2e shard test step
from ~7.9m toward ~5m even with today's per-package hash sharding, because the
58 stackless CLI files stop queueing behind stack-backed ones.

1. Rename the 10 CLI files and 3 stack-package files that start a local stack to
   `*.stack.e2e.test.ts` (`git mv`, no content changes). The list is in
   `apps/cli/src/**` (`start`, `stop`, `status`, `db start`, `db diff
declarative`, `db schema declarative sync`, `shadow-cache`,
   `serve-main-offline`) and `packages/stack/tests/createStack*`.
2. In `apps/cli/vitest.config.ts`, split the `e2e` project: `e2e` includes
   `**/*.e2e.test.ts`, excludes `**/*.stack.e2e.test.ts`, and drops
   `fileParallelism: false` and `maxWorkers: 1`; new `e2e-stack` includes only
   the stack suffix and keeps them. `packages/stack` becomes `e2e-stack` only.
   `apps/cli-e2e` stays `e2e`. Both keep the existing global setup and
   timeouts.
3. Extend `vitest.shared.mts` (or, on Vitest 4, the inline configs) so the kind
   list knows `e2e-stack`; update the kind table in `AGENTS.md` and the e2e
   section of `CONTRIBUTING.md`.
4. Add the path-rule gate to `.github/workflows/test.yml`: a `changes` job using
   a paths filter with three outputs (`ts`, `go`, `ci`); `test-unit` and
   `test-integration` need `ts || ci`; `test-e2e` needs `ts || go || ci`; the
   summary jobs treat skipped as success (they already do). Keep `check` always
   on.
5. Measure: per-shard test-step time on the next three develop merges.

## PR B: Vitest 5 and the shared preset (when the firewall clears)

This is the content of #6457 rebased onto develop after PR A: Vitest 5, the
coverage-provider bump, the `@effect/vitest` peer rule, the knip root plugin
change, `.gitignore`, and `vitest.shared.mts` with `definePackageConfig` and
`testProject`. Re-run `pnpm install --frozen-lockfile` in CI as the readiness
check; the blocker is `firewall.depthfirst.com` returning 451 for the 5.0.0
tarballs.

## PR C: root runs, balanced shards, one-hop scripts (after PR B)

1. **Balanced sequencer** in `vitest.config.mts`: subclass `BaseSequencer`;
   `shard()` partitions specs by `project.name.endsWith("(e2e-stack)")`, sorts
   each partition by `moduleId`, and takes every `count`-th file starting at
   `index - 1`; `sort()` keeps Vitest's default and breaks ties
   lexicographically, replacing the cli-e2e package's own sequencer.
2. **Turbo root task** `//#test:e2e` in `turbo.json`: `dependsOn:
["supabase#build"]`, `cache: false`, `passThroughEnv: ["*"]`. Root script
   `test:e2e:run`: `bun --bun vitest run --project '*(e2e*)'`. Delete the three
   per-package `test:e2e:run` Turbo entries and their `supabase#build`
   dependencies. `test:live` and `test:smoke` are unchanged.
3. **Root scripts**: `test` = `vitest run --project '*(unit)' --project
'*(integration)'`; `test:unit`, `test:integration` filter by kind; `test:e2e`
   = `turbo run //#test:e2e --`. Delete `test:vitest`. Remove the
   `test:unit:run` and `test:integration:run` Turbo tasks.
4. **Package scripts**: `test` runs unit and integration standalone;
   `test:unit`, `test:integration`, `test:e2e` are single Vitest calls with
   `--project`; delete every `:run` script and the Turbo wrappers. Go stays
   package-local as today.
5. **CI**: unit and integration become one matrix job, `shard: [1, 2]`, running
   the root `test` script with `--shard`; the existing summary job keeps the
   required check name. The e2e step becomes `pnpm exec turbo run //#test:e2e
--shard=N/3`. Add `actions/cache` for `node_modules/.vitest-cache` keyed on the
   lockfile plus a version salt. Remove `--coverage.enabled` from PR jobs.
6. **Coverage on develop**: root `coverage` config (istanbul, include
   `{apps,packages}/*/src/**/*.ts`, the CLI's exclude list prefixed with
   `apps/cli/`), enabled only by a develop-push workflow that uploads the merged
   lcov as an artifact.
7. **fsModuleCache**: `fsModuleCache: true` in the preset and root config.
8. **Doctor**: run `vitest doctor` against `supabase (unit)` once and paste the
   output into the PR description; act on nothing that changes isolation or
   pool.
9. **Docs**: `AGENTS.md` Package Structure and Testing sections,
   `CONTRIBUTING.md` test commands, `apps/cli-e2e/AGENTS.md` sequencer note,
   `packages/config/AGENTS.md` run instructions. Update the ADR 0024 vocabulary if any
   term shifts.
10. Measure the same table as the baseline on three develop merges. Expected:
    unit/integration jobs ~4.4m each, e2e shards ~4.5m test step each, plus
    whatever `fsModuleCache` returns.

## Follow-ups explicitly out of scope

- More e2e shards (cheap to add if the balanced result still shows skew).
- Duration-aware sharding from real data.
- `isolate: false` for unit projects after auditing env/cwd/global/`vi.mock`
  users.
- Turbo remote cache; revisit per-package test caching only if it arrives.
