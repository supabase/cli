# Stack Runtime Rewrite Progress

**Branch:** `feat/stack-runtime-rewrite`
**Base:** `de26a30c7` (`origin/develop` on 2026-08-28)
**Design:** `docs/superpowers/specs/2026-08-28-stack-runtime-rewrite-design.md`
**Plan:** `docs/superpowers/plans/2026-08-28-stack-runtime-rewrite.md`

This tracked ledger records implementation state and rulings that may deserve user review. It is
updated in the same commit as each completed slice. Scratch review packages live outside Git under
`.superpowers/sdd/`.

## Current state

- [x] Existing Codex-managed worktree verified as an isolated linked worktree.
- [x] Local branch created directly from `origin/develop`.
- [x] Pinned pnpm dependencies installed with an unchanged lockfile.
- [x] Baseline package type checks passed for `@supabase/process-compose` and `@supabase/stack`.
- [x] Baseline targeted tests passed: process-compose dependency graph (18 tests) and stack identity
      (1 test).
- [x] Approved architecture imported as the canonical tracked design.
- [x] Layer-by-layer implementation plan completed and reviewed against the design.
- [x] Legacy process-compose package and stack implementation removed.
- [ ] Greenfield rewrite implemented through the public Effect and Promise surfaces.
- [ ] Targeted test suite green.
- [ ] Completion audit, final review, push, and pull request completed.

## Slice ledger

### Task 0 — remove legacy runtimes and establish the empty package boundary

- Baseline commit: `de26a30c7`.
- Active process-compose references at the deletion baseline (from `git grep -n` at the base) were:
  `apps/cli/AGENTS.md:393`, `apps/cli/package.json:73`,
  `apps/cli/src/legacy/commands/functions/deploy/deploy.integration.test.ts:18`,
  `apps/cli/src/legacy/commands/functions/download/download.integration.test.ts:23`,
  `apps/cli/src/legacy/commands/gen/types/types.integration.test.ts:44`,
  `apps/cli/src/next/commands/functions/download/download.integration.test.ts:27`,
  `apps/cli/src/next/main.ts:6`, `apps/cli/src/shared/functions/functions-docker.unit.test.ts:19`,
  `apps/cli/src/shared/telemetry/error-actionability-coverage.unit.test.ts:372`,
  `apps/cli/src/shared/telemetry/error-actionability.ts:18,1153`,
  `apps/cli/tests/helpers/running-stack.ts:34`, `package.json:19-20`, `.oxlintrc.json:12`,
  `knip.json:37`, `turbo.json:64`, `packages/stack/package.json:38`, and process-compose imports
  in the deleted package docs/manifest plus throughout the legacy
  `packages/stack/src/**` implementation (including `LocalStack.ts`, `Stack.ts`, `StackBuilder.ts`,
  `StackRpc.ts`, `StackServiceState.ts`, `StackStateProjection.ts`, `createStack.ts`, `effect.ts`,
  `index.ts`, `stackHandle.ts`, `RemoteStack.rpc.integration.test.ts`,
  `StackRpcHandlers.integration.test.ts`, `Stack.unit.test.ts`, and `services/**`).
- Deleted the `packages/process-compose` workspace and the legacy stack source, tests, scripts, and
  stale package docs. Added the empty `@supabase/stack` public, Effect, and testing barrels.
- Moved `mockChildProcessSpawner` to `apps/cli/tests/helpers/child-process-spawner.ts` and updated
  all active CLI imports.
- Removed active process-compose telemetry, manifest, bootstrap, lint, docs, and workspace references;
  `.repos/process-compose` and historical ADR/design references remain preserved.

## Rulings and uncertain decisions

> **Ruling:** Use `Data.TaggedError` for ordinary domain failures and pinned Effect v4
> `Schema.TaggedErrorClass` only at schema-serialized boundaries — this follows the repository rule
> while using the actual RC.111 API rather than the older `Schema.TaggedError` name — cost if wrong:
> an error crossing RPC/state may need to be promoted to a schema-backed class later.

> **Ruling:** The initial deletion commit may temporarily break `apps/cli` type-checking until its
> direct migration task — compatibility stubs would preserve the exact legacy API the greenfield
> rewrite is meant to remove — cost if wrong: intermediate commits cannot be cherry-picked or treated
> as releasable checkpoints.

> **Ruling:** Define the container activation protocol against a narrow fake host-route resolver
> before Docker/Podman adapters exist — this separates protocol authority from engine mechanics —
> cost if wrong: the engine task may require a small activation interface adjustment.

> **Ruling:** Validate `StackId` as the actual 64-character lowercase SHA-256 digest before it can
> reach identity-scoped filesystem paths — “opaque” means callers do not interpret it, not that
> arbitrary path-like strings are valid — cost if wrong: a future non-SHA identity encoding will need
> an explicitly versioned schema change.

> **Ruling:** Derive Git `workspaceId` and `checkoutId` from the canonical common Git directory and
> checkout-specific Git directory, with the full symbolic branch ref as `branchContext`; ordinary
> folders use their canonical project root and the documented ordinary-workspace marker — this avoids
> another mutable identity registry — cost if wrong: physically moving a checkout intentionally
> produces a new identity instead of reattaching its old stacks.

> **Ruling:** Hash each identity tuple field as a four-byte big-endian UTF-8 byte length followed by
> the field bytes, then SHA-256 the concatenation — this is a single unambiguous mechanism with no
> separator escaping — cost if wrong: fields larger than 4 GiB are unrepresentable, which is outside
> any valid filesystem/ref/name input.

When the design does not determine another choice, record it here as:

> **Ruling:** decision — reason — cost if wrong.

Implementation continues after recording a ruling; this file is not a question queue.

## Verification evidence

### Plan self-review — 2026-08-28

- Mapped all design sections to 15 implementation tasks: cleanup, public model, identity, compiler,
  durable state/secrets/ports, ownership, reconciliation/observability, native preparation/runtime,
  gateway/activation, Functions, container runtime, lifecycle/recovery, facades/CLI, reset session,
  and final catalog/audit.
- Removed an ordering conflict: public `StackConfig` is defined with capability Modules before the
  durable state schema consumes `StackDefinition`.
- Verified 55 executable steps, 42 balanced Markdown fences, and no placeholder patterns.
- Recorded exact baseline sources for supported settings before their deletion.
- Initialized `.repos/effect` and verified the pinned v4 source. Confirmed
  `Schema.TaggedErrorClass`, effectful Schema codecs, services/Layers, scoped acquisition, Deferred,
  Semaphore, SubscriptionRef, PubSub, Schedule, callback cancellation, platform filesystem layers,
  and Effect RPC against their actual source/tests.

### Baseline — 2026-08-28

- `pnpm install --frozen-lockfile` — passed.
- `pnpm types:check` in `packages/process-compose` — passed.
- `pnpm types:check` in `packages/stack` — passed.
- `pnpm exec vitest run src/DependencyGraph.unit.test.ts` in `packages/process-compose` — 18 passed.
- `pnpm exec vitest run --project unit src/StackIdentity.unit.test.ts` in `packages/stack` — 1 passed.

### Task 0 — 2026-08-28

- `pnpm install --lockfile-only` — passed (pnpm v11.4.0; platform warnings for unsupported binary
  wrapper workspaces only).
- `rg -n '@supabase/process-compose|packages/process-compose' package.json packages apps
--glob '!docs/superpowers/**' --glob '!docs/adr/**'` — no matches (exit 1 as expected).
- `pnpm --dir packages/stack types:check` — passed.
- The CLI type-check was not run; the accepted staging ruling allows the old CLI stack call sites to
  fail until the direct migration task. The telemetry coverage test was attempted and could not load
  the removed `@supabase/stack/managed-model` export; its adapters are part of that migration.

### Task 1 — 2026-08-28

- Added the Effect-native public model for stack identity, runtimes, capabilities, complete status
  snapshots, logs, credentials, and operation-specific tagged failures.
- `StackStatusSchema` validates that a snapshot contains exactly one status for each of the ten
  public capabilities, including disabled capabilities.
- `pnpm --dir packages/stack exec vitest run --project integration src/public/public-model.integration.test.ts`
  RED: failed before implementation with `Cannot find module './Status.ts'`; GREEN: 3 tests passed.
- `pnpm --dir packages/stack types:check` — passed.

### Task 2 — 2026-08-28

- Added read-only deterministic identity resolution for canonical Git checkouts, linked worktrees,
  detached HEADs, nested project roots, and ordinary folders. Git metadata is read through Effect
  `FileSystem`/`Path`; no registry or identity-marker writes occur during discovery.
- Added length-delimited UTF-8 tuple hashing through Effect `Crypto`; `StackIdSchema` now accepts
  only the 64 lowercase hexadecimal characters emitted by SHA-256.
- Added exact StackId-scoped state/data/log/runtime/control/temporary paths with runtime id
  validation and no path traversal; changed the public status fixture to a valid digest.
- Added real temporary Git/worktree and path-safety integration scenarios (9 tests).
- `pnpm --dir packages/stack exec vitest run --project integration src/identity/identity.integration.test.ts`
  RED before implementation: failed to import the missing `../state/Paths.ts` module.
- `pnpm --dir packages/stack exec vitest run --project integration src/identity/identity.integration.test.ts`
  GREEN: 9 tests passed.
- `pnpm --dir packages/stack exec vitest run --project integration src/public/public-model.integration.test.ts`
  GREEN: 3 tests passed.
- `pnpm --dir packages/stack types:check` — passed.
- `pnpm exec oxfmt --check packages/stack/src/identity packages/stack/src/state packages/stack/src/public/StackId.ts packages/stack/src/public/public-model.integration.test.ts` — passed.

#### Task 2 review fixes — 2026-08-28

- Preserved the supplied project-root string (including valid leading/trailing-space path names),
  while still trimming only for blankness checks; canonicalization remains filesystem-backed.
- Linked-worktree `commondir` targets are now statted and must resolve to directories. Git `HEAD`
  metadata now accepts only full `refs/...` symbolic refs or 40/64-character hexadecimal object
  ids, with malformed content failing as `InvalidStackIdentityError`.
- Reworked identity integration coverage to scoped `it.live` Effects with the Node platform layer,
  typed Git subprocess failures, symlink canonicalization, malformed metadata cases, and exact names
  for every state-path field including the temporary sibling.
- `pnpm --dir packages/stack exec vitest run --project integration src/identity/identity.integration.test.ts`
  — 13 tests passed.
- `pnpm --dir packages/stack exec vitest run --project integration src/public/public-model.integration.test.ts`
  — 3 tests passed.
- `pnpm --dir packages/stack types:check` — passed.
- `pnpm exec oxlint --config .oxlintrc.effect.json packages/stack/src/identity packages/stack/src/state/Paths.ts packages/stack/src/public/StackId.ts packages/stack/src/public/public-model.integration.test.ts` — passed with zero warnings.
- `pnpm exec oxfmt --check packages/stack/src/identity packages/stack/src/state/Paths.ts packages/stack/src/public/StackId.ts packages/stack/src/public/public-model.integration.test.ts` — passed.

### Task 3 — 2026-08-28

- Added direct closed schemas for all ten public capabilities. Settings cover the current CLI
  database, REST, Auth (providers/hooks/rate limits/MFA/email/SMS/OAuth/third-party/Web3),
  Realtime, Storage, Functions/Edge Runtime, Studio, Mail, Analytics, and Pooler fields. Public
  listeners reuse the eight `PORT_FIELDS`; migrations, seed, shadow port, and hosted metadata stay
  caller-owned or outside the stack contract.
- Added deterministic pure compilation with complete defaults and explicit `null` absences,
  Redacted secret leaves converted to stable slots, sorted canonical fingerprints, path-safe
  `functions_root`, dependency closure validation, deterministic start/stop order, semantic
  workload hashes, and runtime-selected native/container logical artifacts. Database versions use
  an explicit supported Supabase release map and fail before output when unknown.
- Private workload companions are represented for database bootstrap, storage imgproxy, studio
  pgmeta, analytics vector, and managed Edge Runtime Functions. Functions remain one capability;
  all serving is through that managed Edge Runtime.
- Added 19 integration scenarios covering each capability, defaults, unknown fields, stable record
  fingerprints, omission versus explicit selection, secret redaction, previous-definition reuse,
  version validation, runtime artifact selection, path escapes, and dependency closure.
- Red/green: the compiler scenarios were added against the empty model boundary and then turned
  green as the modules/compiler were implemented; `compiler.integration.test.ts` and the existing
  public-model integration file now pass (22 tests).
- `pnpm --dir packages/stack types:check` — passed.
- `pnpm exec oxlint --config .oxlintrc.effect.json packages/stack/src/public/Config.ts packages/stack/src/model packages/stack/src/public/Errors.ts` — passed with zero warnings.
- `pnpm exec oxfmt --check packages/stack/src/public/Config.ts packages/stack/src/model packages/stack/src/public/Errors.ts` — passed.

#### Task 3 review fixes — 2026-08-28

- Replaced the parallel version map/workload defaults with one release catalog per capability.
  Database selectors are limited to supported majors 13, 14, 15, and 17 and resolve to their
  exact Supabase Postgres releases; non-database selectors must match the current catalog bundle.
  Native and container descriptors now stay coherent for the selected release, while private
  companions retain their bundle-owned versions.
- Previous compilation reuse now carries only the persisted definition and fingerprint. An
  identical fingerprint reuses the exact definition object but rebuilds a fresh runtime plan and
  workload hashes from persisted versions/settings, rejecting unsupported persisted releases.
- Storage bucket and per-function records receive their complete defaults before materialization;
  Function slug/environment key constraints are checked before schema decoding so invalid Record
  keys cannot be silently dropped. Pooler uses the current `pool_mode` spelling.
- Added one shared `NetworkPortSchema` (integer 1..65535) for listeners, endpoints, SMTP,
  the public Functions inspector listener, and analytics vector ports. Capability/module dependencies now drive graph
  planning and missing private dependencies/cycles fail with `InvalidStackConfigError`.
- Strengthened compiler scenarios for exact tagged errors, release/artifact coherence, persisted
  plan rebuilding, record defaults, key/port validation, and secret absence from definition,
  fingerprint, plan, and formatted values. Task 4 owns the exhaustive materialized
  `StackDefinitionSchema` and round-trip state codec; Task 3 exposes concrete per-capability input
  schemas/types and release metadata without an open or generated settings bag.
- Fix-round RED: 7 new scenarios failed against `06800c953`; GREEN: compiler/public integration
  suites now pass (31 tests).
- `pnpm --dir packages/stack types:check` — passed.
- `pnpm --dir packages/stack exec vitest run --project integration src/model/compiler.integration.test.ts src/public/public-model.integration.test.ts` — 30 tests passed before final empty-release scenario (31 total expected; rerun final command below).
- `pnpm exec oxlint --config .oxlintrc.effect.json packages/stack/src/model packages/stack/src/public/Config.ts packages/stack/src/public/Status.ts packages/stack/src/public/Errors.ts` — passed with zero warnings.
- `pnpm exec oxfmt --check packages/stack/src/model packages/stack/src/public/Config.ts packages/stack/src/public/Status.ts packages/stack/src/public/Errors.ts` — passed.

### Task 4 — 2026-08-28

- Added the strict `supabase-stack-state-v1` Effect codec for complete materialized definitions,
  persisted identity/runtime/generation/lifecycle, sticky host-port assignments, and dedicated
  secret values. Unknown fields, malformed formats, invalid record keys, incomplete dynamic
  defaults, forged identity tuples, duplicate ports, and definition/fingerprint mismatches fail
  closed with tagged errors. Reads remain lock-free; writes use an owner-only root, a sibling
  exclusive temporary file, file sync, and same-directory atomic rename. Effect Platform has no
  portable directory-fsync API, so the implementation documents that file-sync/same-directory
  rename is the strongest available durability boundary.
- Added one short O_EXCL registry lock (bounded Schedule retry, exact release, no stale stealing)
  shared by state mutations and port planning; the per-stack `state.json.ports` fields remain the
  sole durable port authority. Automatic ports are sticky and exclusive across automatic/live
  assignments, exact stopped reservations may coexist, and runtime ownership/publication occurs
  after the state transaction with assignments retained on publication races.
- Added module-owned secret policies and required managed slots. Auth API credentials, Pooler
  encryption/key-base, the default JWT signing slot, and the internal database password are
  managed; other Redacted settings remain pass-through. Managed omissions generate once and reuse;
  pass-through changes/additions/removals require a stopped lifecycle. Secret bytes never enter
  definitions, fingerprints, errors, or loggable redaction output.
- RED evidence: focused state/secret/port tests initially failed to load the missing Task 4 state,
  secret, and port modules; the final integration scenarios now cover concurrent old-or-new reads,
  exact cleanup, strict dynamic/default round-trips, secret policy matrices, automatic/exact port
  conflicts, native listener handoff, host occupancy, and container publication races.
- `pnpm --dir packages/stack exec vitest run --project integration src/state/state-store.integration.test.ts src/state/secrets.integration.test.ts src/state/ports.integration.test.ts` — passed (17 tests).
- `pnpm --dir packages/stack types:check` — passed.
- Effect lint over changed Task 4 sources — passed with zero warnings.

#### Task 4 port review fixes — 2026-08-28

- Exact requests now reject ports held by another stack's automatic reservation with the canonical
  `PortAllocationError`, while exact reservations on stopped stacks continue to coexist.
- Running stacks are assignment-fenced: exact/automatic changes and enablement changes fail with
  `StackLifecycleConflictError`; an unchanged repeat is accepted without advancing generation.
- Native multi-listener acquisition is transactional in an operation-owned child `Scope`; a later
  bind failure closes earlier listeners before the failure escapes, while successful listeners remain
  owned by the caller's scope. The fork/acquire/handoff boundary is masked against interruption,
  with the actual bind effects restored to interruptible execution.
- Review RED evidence: the three new scenarios initially observed the missing automatic conflict,
  missing running-assignment fence, and leaked first native listener; all now pass.
- `pnpm --dir packages/stack exec vitest run --project integration src/state/ports.integration.test.ts` — passed (10 tests).
- `pnpm --dir packages/stack test` — passed (67 integration tests; no unit files).

#### Task 3 review fixes — round 2 — 2026-08-28

- Preserved the authoritative database major alias: selector `13` intentionally resolves to the
  current Supabase Postgres `15.8.1.085` release. This follows
  `apps/cli-go/pkg/config/config.go:825-831` and the documented fallthrough in
  `apps/cli/src/shared/services/services.shared.ts:107-116`; the legacy `pg13` constant is not
  an active runtime artifact. The native and container descriptors remain coherent for that
  selected release (and for majors 14, 15, and 17).
- Identical-fingerprint reuse now branches immediately after strict decode, Functions-root
  normalization, and fingerprint calculation. It collects only supplied Redacted slots, validates
  persisted versions and capability/workload closure, and rebuilds a fresh runtime plan from the
  persisted definition. Candidate defaults/materializers are not evaluated on this path.
- Removed duplicate Functions authorities from `edge_runtime`: capability enablement remains on
  `capabilities.functions.enabled`, and the inspector gateway port remains on the public
  `functionsInspector` listener. Functions settings persist only runtime behavior, root, secrets,
  and per-function overrides; recursive unknown-field tests reject the removed controls.
- Persisted-definition codecs remain a Task 4 responsibility; Task 3 intentionally exports concrete
  input schemas/types and release metadata without a generated or open materialized settings bag.
- Round-2 RED/GREEN: the targeted compiler/public suites pass (32 tests), including the DB13 alias,
  immediate reuse, removed Functions controls, exact tagged failures, and closure checks.
- `pnpm --dir packages/stack types:check` — passed.
- `pnpm --dir packages/stack exec vitest run --project integration src/model/compiler.integration.test.ts src/public/public-model.integration.test.ts` — passed, 32 tests.
- `pnpm exec oxlint --config .oxlintrc.effect.json packages/stack/src/model packages/stack/src/public/Config.ts packages/stack/src/public/Status.ts packages/stack/src/public/Errors.ts` — passed with zero warnings.
- `pnpm exec oxfmt --check packages/stack/src/model packages/stack/src/public/Config.ts packages/stack/src/public/Status.ts packages/stack/src/public/Errors.ts` — passed.

### Task 5 — 2026-08-28

- Added identity-scoped owner metadata and one O_EXCL `runtime/owner.lock`. Ownership is proved
  only by the lock; metadata is published after endpoint bind through a sibling temporary file,
  file sync, and same-directory rename. Reads validate the StackId directory and deterministic
  full-digest endpoint before probing. Session-fenced release never removes a replacement lock or
  metadata, and transport owns socket unlink only after a successful bind.
- Added `StackStateStore.initialize`, a registry-lock transaction that returns an existing complete
  state or writes the candidate once. This closes the concurrent equivalent-create race without a
  process-global registry.
- Added the one local control endpoint with frozen maintenance v1 and exact-release Effect RPC,
  bounded framing, identity/session/release fencing, per-request deadlines, bounded maintenance
  concurrency, and post-response quiesce completion. Maintenance stop retains the compatible owner;
  only quiesce releases it for explicit replacement.
- Added detached Supervisor launching through Effect's `ChildProcessSpawner` and fd3 readiness
  handoff. Concurrent losers join winner metadata through a pre-started filesystem watcher plus a
  bounded Schedule reread that closes the platform watch-acquisition gap. Every returned owner is
  release/session/probe validated. Readiness has a five-second deadline and terminates the exact child
  and observer on timeout, failure, or caller interruption. Owner processes outlive caller handles.
- Added managed Effect handles and observational discovery (`openStack`, `findStack`, `listStacks`,
  `inspectStack`), truthful unconfigured/stopped status, operation-specific public errors, and exact
  RPC error-tag preservation. POSIX endpoints use `/tmp` plus the complete StackId digest to remain
  below Unix socket path limits.
- Added ownership/state initialization, protocol framing/fencing, incompatible-release,
  project-filter, caller-process-exit, concurrent create, and handle lifecycle integration scenarios.
- `pnpm --dir packages/stack exec vitest run --project integration src/control/control-transport.integration.test.ts src/state/ownership.integration.test.ts src/supervisor/handles.integration.test.ts`
  — passed (22 tests).
- `pnpm --filter @supabase/stack test` — passed (89 integration tests; no unit files).
- `pnpm --dir packages/stack types:check` — passed.
- Effect lint over all Task 5 sources and tests — passed with zero warnings.
- Formatting and `git diff --check` — passed; no matching Supervisor processes or control sockets
  remained after the integration suites.

### Task 6 — 2026-08-29

- Added the exact private `RuntimeDriver` boundary and a deterministic desired-state planner. Running
  reconciliation starts in dependency order; stop, destroy, stale-generation replacement, and
  duplicate-resource cleanup quiesce active resources before removal in reverse dependency order.
  Every runtime mutation uses the full StackId, desired generation, workload id, and semantic spec
  hash.
- Added one Supervisor-local reconciliation semaphore and generation fences before and after every
  mutation and observation boundary. Independent branches continue after a workload failure, while
  the complete transitive dependent closure is blocked and any already-running descendants are
  stopped and removed child-first.
- Readiness uses a deadline and bounded `Schedule` retry policy. Exhaustion is scoped by stack,
  generation, and workload, persists across repeated running reconciliation, resets on an explicit
  stopped/destroying intent, and starts fresh for a new generation. Retry control classifies the
  complete failed `Cause` before scheduling so defects and interruption are never collapsed into an
  ordinary workload failure.
- Added complete status projections backed by `SubscriptionRef`; every watcher begins with the
  current snapshot. Added owner-only bounded retained logs with strict persisted decoding, opaque
  monotonic cursors, capability filters, exact known-secret redaction before persistence and live
  publication, and one semaphore-protected retained-to-live `PubSub` handoff without gaps or
  duplicates.
- Retained log limits reject non-finite or undersized configurations, existing log directories and
  files are repaired to `0700`/`0600`, and retained entries are re-redacted and republished
  atomically when the current known-secret set newly matches old content.
- Review RED/GREEN evidence: the first package run exposed duplicate blocked reports and a hanging
  readiness scenario; later regression coverage exposed unsafe stale-resource cleanup, restart
  budgets surviving explicit stop, and a mixed driver cause being reduced to a normal failure. The
  final implementations and observable, Deferred/TestClock-coordinated scenarios cover each case.
- `pnpm --dir packages/stack types:check` — passed.
- `pnpm --dir packages/stack test:unit:run -- Reconciler.unit.test.ts` — passed (4 tests).
- `pnpm --dir packages/stack test:integration:run -- reconciler.integration.test.ts observability.integration.test.ts`
  — passed (104 integration tests across 11 files).
- `pnpm exec oxlint -c .oxlintrc.effect.json` over the eight Task 6 source/test files — passed with
  zero warnings.
- `pnpm exec oxfmt --check` over the eight Task 6 source/test files and `git diff --check` — passed.
