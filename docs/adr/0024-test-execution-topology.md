# 0024. Test Execution Topology: Root Vitest Runs, Stack-Backed E2e, and Turbo's Role

**Status**: proposed
**Date**: 2026-09-04

## Problem Statement

Tests in this monorepo were run by Turbo fanning out to one Vitest process per package for each test kind, with every test task uncached. That shape had three costs that grew with the suite:

1. **CI wall-clock was decided by luck.** The e2e suite was sharded per package by Vitest's path-hash slicing, so the 13 files that start a local Supabase stack or run a Docker container (about 72% of all e2e time) landed on shards at random. Recent runs spent 7.9, 5.6, and 3.3 minutes in the three shards' test steps.
2. **Every e2e project ran files strictly serially**, a setting from the first architecture commit that no comment defended and that contradicts the repository's own flake policy, which requires tests to be correct under file-level parallelism. Serial execution meant 58 stackless CLI e2e files queued behind the stack-backed ones instead of fanning out.
3. **Configuration and scripts repeated themselves.** Seven package configs restated coverage, include globs, and export-condition resolution; each test kind reached Vitest through three layers of scripts (`test:unit` to Turbo to `test:unit:run` to Vitest), and six processes produced six interleaved reports for one repository-wide run.

Vitest 5 changed what is possible: a root config can reference package configs that declare their own `projects`, inline projects inherit their declaring config, and one process can filter, shard, and sequence across every package.

## Decision

1. **One root Vitest run is the unit of execution for unit, integration, and e2e tests.** The repo-root `vitest.config.mts` loads every package config as a nested project group named `<package> (<kind>)`. CI and the root scripts run that process with `--project` and `--shard` filters. Package configs remain runnable standalone for local work and share one preset, `vitest.shared.mts`.
2. **E2e tests that start a local stack are a distinct sub-kind, marked by the `*.stack.e2e.test.ts` suffix**, and run in their own serial `e2e-stack` test project. All other e2e files run with normal file parallelism. A file claims the stack-backed suffix when it starts a Supabase stack, Docker or native; a file that only spawns the CLI against an isolated temporary home does not.
3. **Shards are balanced by weight class, not duration data.** The root config's sequencer deals stack-backed files round-robin across shards by sorted path, then stackless files the same way. Every shard computes the same partition independently.
4. **Turbo keeps the dependency graph and nothing else in test execution.** E2e is a Turbo root task, `//#test:e2e`, that depends on `supabase#build`; live and smoke stay Turbo tasks for the same reason. Unit and integration no longer pass through Turbo. Job-level skipping is done with path rules in the workflow, not `turbo --affected`.
5. **Coverage leaves PR runs.** A develop-push workflow produces one merged root report; PR jobs run uninstrumented.

## Vocabulary

These are the canonical names for the concepts above; use them in configs, scripts, docs, and PR descriptions.

- **Test kind**: one of unit, integration, e2e, or live. Every test file belongs to exactly one kind, chosen by its file suffix and colocated with the code it covers. A kind is a promise about what the test touches: unit is pure in-process logic, integration runs handlers against mocked services, e2e drives a real CLI subprocess, live drives a real CLI subprocess against a real Supabase platform and is never part of the default loop.
- **Stack-backed e2e**: an e2e test whose file starts a local Supabase stack, Docker or native, or runs a Docker container, and so claims machine-level resources. Marked by the `*.stack.e2e.test.ts` suffix and run one file at a time. An e2e file that only spawns the CLI against an isolated temporary home is **stackless** and keeps the plain `*.e2e.test.ts` suffix.
- **Test project**: a Vitest project, a named slice of the suite with its own include pattern and runtime settings. Each package declares one per test kind it has. Always say "test project"; in this repo an unqualified "project" is a hosted Supabase project (see `ProjectConfig`, ADR 0020). From the repository root a test project is addressed as `<package> (<kind>)`, for example `supabase (unit)` or `@supabase/stack (e2e-stack)`; inside a package, by kind alone.
- **Package config**: a package's `vitest.config.ts`. It plays two roles: the run root for a standalone run, and one member of the root run's project list.
- **Standalone run**: Vitest started inside one package. Only that package's test projects are visible; run-level options come from the package config.
- **Root run**: Vitest started from the repository root. Every package config is loaded as a group of test projects, so one process can select any set of kinds or packages. Run-level options come from the root config; the package configs' copies are ignored.
- **Run-level option**: a Vitest option read only from the run's root config: coverage, reporters, `silent`, `passWithNoTests`, sequencing, and sharding among them. Package configs still set them for standalone runs.
- **Compatibility e2e suite**: the record-and-replay suite in `apps/cli-e2e`. An e2e test project like any other, but it exercises the CLI against recorded Management API traffic rather than a local stack.

## Rationale

- **Wall-clock is the objective**, agreed ahead of compute and configuration simplicity. Only a process that sees all e2e files can balance them, and only a project split can let stackless files run in parallel while stack-backed files stay serial. Vitest schedules a serial project after the parallel groups within one run, so the split needs no custom scheduling. Simulated on the measured durations, the worst shard's serial work drops from about 7.9 to about 4.5 minutes with three shards.
- **Turbo's test-specific strengths were not in use and could not be made sound cheaply.** Every test task was `cache: false`, CI had no remote cache, and `.turbo` was not persisted, so no test caching existed to lose. Making per-package test caching honest would require declaring sibling packages' sources, the built binary, Docker images, and environment as inputs. Turbo's package graph also does not know the CLI shells out to the Go sidecar (that link exists only in the task graph via `supabase#build`), so `--affected` would wrongly skip e2e on Go-only changes. Path rules cost seconds and encode the three real cases: docs-only, Go-only, everything else.
- **A filename suffix is the existing vocabulary.** Test kinds are already chosen by suffix and colocated; extending that to a sub-kind keeps the resource claim visible in the file name, greppable, and reviewable, without adopting tags or breaking colocation.
- **Weight classes over a duration manifest.** Durations range from 0.4s to 150s within the stack-backed class, so a manifest would balance better, by roughly one more minute, but it is data that drifts and needs a job to refresh. The class-based deal needs no data and can be upgraded later if imbalance persists.

## Consequences

### Positive

- E2e wall-clock is bounded by the balanced stack-backed work per shard, not by hash luck.
- One report per CI job and per local root run; `--project '*(unit)'` addresses a kind across the repo, `--project 'supabase (integration)'` a kind within a package.
- Package configs shrink to a list of projects plus genuinely local settings; scripts are one hop from any entry point to Vitest.
- The flake policy and the e2e configuration agree.

### Negative

- Run-level options (`silent`, `passWithNoTests`, coverage, sequencing) must be declared in the root config and repeated through the preset for standalone runs; Vitest never inherits them into file-referenced projects.
- The cli-e2e package's lexicographic sequencer no longer applies when its files run from the root; the root sequencer provides the equivalent tiebreak.
- Renaming stack-backed files churns blame once and adds a rule authors must know: starting a stack means taking the suffix.
- Per-package test caching is foreclosed for as long as tests run from the root. Revisit only if a remote cache arrives and test inputs can be declared honestly.

## Alternatives Considered

1. **Keep Turbo fan-out and only split e2e projects**: smallest diff, keeps package-level `--affected` for e2e, but cannot balance shards across packages and rarely skips anything on this graph because the CLI depends on every other package.
2. **Separate serial stack job and parallel stackless job**: the stack job alone is about 10.6 minutes serial, worse than today, unless it is itself sharded, which collapses into the chosen design.
3. **Vitest tags or a directory for stack-backed files**: tags hide the claim inside the file and introduce a mechanism the repo does not use; a directory breaks colocation.
4. **Committed duration manifest**: better balance for more maintenance; deferred, see above.
5. **`isolate: false` for unit tests**: about 40 test files mutate env, cwd, or globals or use `vi.mock`; a semantic change that needs an audit before any measurement exists.
6. **`turbo --affected` as the CI gate**: unsound without adding the Go sidecar to the CLI's package.json dependencies, and a gate job pays an install before any test job starts.

## Related Decisions

- ADR 0013: Live E2E Tests Bypass the Replay Server (live remains a separate, never-default kind)
- ADR 0017: Simplified Managed Stack Architecture (what a stack-backed e2e test starts)

## See Also

- `docs/superpowers/plans/2026-09-04-test-execution-topology.md` for the implementation plan and measured baseline
- Vitest 5 projects guide: https://vitest.dev/guide/projects
