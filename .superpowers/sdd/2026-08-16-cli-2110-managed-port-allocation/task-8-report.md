# Task 8 report — managed port contract and parallel verification

## Outcome

Task 8 contract, concurrency coverage, cleanup, and ownership documentation are implemented.

## Changes

- Added the `ports.stopped-siblings-with-shared-exact-config-coexist` fixture (inventory: 104) and
  memory/SQLite lifecycle coverage for exact sibling coexistence and later occupying conflict.
- Added Deferred-gated managed-service concurrency scenarios for sibling identities (disjoint
  automatic assignments) and same-identity starts (convergent assignment), using isolated Git
  worktrees and both repository adapters.
- Simplified managed port policy: derive defaults from the catalog, remove the persisted-assignment
  alias, and narrow coordinator retry classification.
- Strengthened direct `createStack` integration handoffs with dynamically reserved exact API/DB pairs
  and bounded retries only for nested `EADDRINUSE`; corrected the Bun SQLite coordinator fixture.
- Documented exact/automatic ownership, stopped/failed behavior, runtime-only fields, child-process
  coordinator ownership, and unmanaged direct/daemon boundaries in the architecture docs and ADR.

## Verification

- `pnpm --filter @supabase/config check:all`: pass.
- `pnpm --filter @supabase/config test:core`: pass (7 files, 130 tests).
- `pnpm --filter @supabase/stack check:all`: pass.
- `pnpm nx run @supabase/stack:test:unit`: pass (32 files, 323 tests, 5.41s).
- Focused managed/direct/daemon/coordinator group: pass (5 files, 13 tests; 230 skipped; 29.39s).
- Focused fixture/concurrency scenarios: pass (6 tests; 29.14s).
- SQLite coordinator claim scenario: pass (1 test; 208ms).
- `git diff --check`: pass.

## Deviations

The first full integration target completed with 585/612 tests passing (27 failures), including
deterministic managed-discovery/managed-resolve identity assertions and a Bun `node:sqlite` import;
the latter is fixed here. A subsequent three-file identity run reproduced 24 deterministic
identity mismatches (409 passing), which are outside this Task 8 port/docs surface and are owned by
the identity-fix workstream. Per orchestration, the two required full integration runs were not
restarted while that workstream was active. No fixed ports, probe-close helpers, file-parallelism
limits, or worker caps were introduced.

