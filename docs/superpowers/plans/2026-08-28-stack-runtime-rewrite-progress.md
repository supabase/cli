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

> **Ruling:** Functions have one serving path through the managed stack Edge Runtime in both native
> and container modes; `supabase functions serve` is a managed-stack client, not a separate Docker
> workflow. The caller owns migrations, schemas, and seeds. Database reset is deliberately outside
> this rewrite and reserves no API, durable state, or lifecycle variant; it will be designed in a
> separate future session from observed caller needs — cost if wrong: reset work would require an
> explicit later public-contract change rather than a placeholder in this implementation.

> **Ruling:** `supabase/slim-services` is the canonical release contract for native and container
> workloads: each supported version uses its portable archive and the GHCR image derived from that
> archive. The initial database catalog supports only PostgreSQL `17.6.1.166`; PostgreSQL 15 is added
> only after both artifacts are published, and all other selectors fail before mutation — cost if
> wrong: adding a version is a catalog change, while retaining unsupported historical selectors would
> create runtime identities that cannot be prepared.

When the design does not determine another choice, record it here as:

> **Ruling:** decision — reason — cost if wrong.

Implementation continues after recording a ruling; this file is not a question queue.

## Verification evidence

### Plan self-review — 2026-08-28

- Mapped all design sections to the implementation tasks for cleanup, public model, identity, compiler,
  durable state/secrets/ports, ownership, reconciliation/observability, native preparation/runtime,
  gateway/activation, Functions, container runtime, lifecycle/recovery, facades/CLI, complete
  catalog/platform coverage, and completion audit. Database reset is tracked outside this rewrite.
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
- Private workload companions are represented for storage imgproxy, studio
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

- **Superseded release decision:** the alias behavior recorded below is historical. The rewrite now
  accepts only PostgreSQL `17.6.1.166`; PostgreSQL 15 remains deferred until its matching native
  archive and derived image are published, and every other selector fails before mutation.
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
  release/session/probe validated. Readiness has a thirty-second deadline and terminates the exact child
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

### Task 7 — 2026-08-29

- Added an owner-only verified artifact store with canonical path containment, SHA-256 validation,
  required-runtime-path checks, executable repair, exact temporary cleanup, same-directory atomic
  publication, strict cache revalidation, and store-scoped single-flight ownership that survives an
  individual caller's interruption.
- Added the native process boundary and runtime driver. Workload commands and environments travel in
  a private inherited descriptor instead of argv; the parent-loss descriptor terminates the exact
  launcher process tree. Start is shared, readiness and log persistence are typed startup gates,
  stop/remove target the exact generation/workload/spec identity, and a stopped identity can start a
  fresh process without retaining its completed `Deferred` or closed scope.
- Database bootstrap is a post-probe readiness phase on the real database workload, never a private
  companion workload. The generic runner validates an ordered release plan, creates its tracking
  schema under a transaction-scoped advisory lock, applies and records one revision atomically, and
  reconciles `Redacted` role credentials outside SQL text. Concrete per-release revision catalogs
  remain Task 13 work; gateway listener ownership/transfer remains Task 8 work with the gateway
  contract.
- Added integration coverage for verified cache/download behavior, corruption and containment,
  concurrent publisher convergence, caller/store-scope cancellation, native readiness/logging/
  restart/identity ownership, owner-loss process-tree termination, and ordered/concurrent/retried
  bootstrap behavior without secret disclosure.
- Ruling: the two-store publication test intentionally uses separate `ArtifactStore` instances in one
  process. Those instances share no in-memory single-flight state and therefore exercise the atomic
  filesystem rename/revalidation race that also coordinates separate processes. A child-process-only
  duplicate of that scenario would add subprocess scaffolding without testing another invariant.
- `pnpm --dir packages/stack types:check` — passed.
- Focused Task 7/compiler integration suite — passed (57 tests across 4 files).
- `pnpm --dir packages/stack test` — passed (4 unit and 132 integration tests).
- Effect lint over all Task 7 source/test files — passed with zero warnings.
- Formatting over all Task 7 source/test files and `git diff --check` — passed.
- Independent re-review found no Critical or Important findings; all earlier lifecycle, bootstrap,
  credential, logging, cleanup, and cancellation findings are closed.

### Task 8 — 2026-08-29

- Added internal HTTP, WebSocket, and transparent TCP gateways with injected capability routes and
  private backend resolution. HTTP owns CORS, forwarding headers, health/status dormancy, and
  503/502 mapping; TCP preserves opaque PostgreSQL, TLS, SMTP, POP3, STARTTLS, backpressure, and
  half-close behavior.
- Added mandatory one-way lazy activation per desired generation. Concurrent callers join one
  owner-scoped activation fiber, dependency closures activate once, successful results remain live,
  failed attempts may retry, waiter interruption does not cancel shared work, and owner-scope
  closure interrupts it exactly.
- Added the container activation-only protocol: bounded exact-schema frames, 16-request concurrency,
  TestClock-verifiable five-second deadlines, capability/StackId/generation/gateway/session fences,
  generic wire errors, and a high-entropy Redacted capability. The owner-only activation file uses
  exact decoding, pre/post-read size bounds, atomic publication, immediate temporary cleanup, and
  fenced finalization that cannot delete a rotated successor.
- Native port reservations now carry the exact pre-bound HTTP/TCP listener into the gateway. TCP
  transfer requires `allowHalfOpen: true`; shutdown is single-flight, closes retained keep-alive and
  tunnel sockets, invokes the listener release, and never performs a bind-close-rebind. A failed or
  interrupted final generation fence closes the operation-owned listener scope before returning.
- Review fixes added partial gateway-acquisition rollback, complete foreign-callback listener
  cleanup, connection-before-listener race removal, post-header backend failure handling, adopted
  listener ownership, idle keep-alive cleanup, deterministic deadline coverage, large-stream
  transfer coverage, and final-fence listener cleanup. Final independent re-review found no Critical
  or Important findings.
- RED evidence: both gateway suites initially failed because the new modules did not exist; added
  lifecycle and protocol regressions failed against the first implementation before each fix.
- `pnpm --dir packages/stack types:check` — passed.
- Focused gateway, activation, port, and reconciler suite — passed (45 tests across 5 files).
- `pnpm --dir packages/stack test` — passed (4 unit and 156 integration tests).
- Effect/generic lint over all Task 8 sources and tests, formatting, and `git diff --check` — passed.
- Concrete capability route catalogs remain Task 13; Functions discovery, container engine routing,
  and full Supervisor lifecycle composition remain Tasks 9, 10, and 11 respectively.

### Task 9 — 2026-08-29

- Added request-time FunctionsRoot containment and canonical one-mount descriptors. Every function,
  entrypoint, import-map, static pattern, shared path, and symlink target is checked against the
  live root; filesystem edits become visible on the next discovery without a watcher or state write.
- Added closed FunctionDiscovery settings/defaults, custom entrypoint/static/import-map descriptors,
  Redacted environment values, disabled/not-found and typed path failures, generic module resolution,
  and Functions gateway preparation (`/functions/v1/:slug`) that captures the exact invocation in a
  typed backend-dispatch closure and avoids activation on 404/503.
- Added integration coverage for live create/edit/delete, config-only overrides, root and category
  symlink escapes, path traversal/absolute values, shared modules, canonical mounts, gateway
  preflight activation fencing, and HTTP/WebSocket dispatch descriptor handoff.
- RED evidence: the first functions integration run failed because the new discovery modules were
  absent; subsequent gateway preflight coverage initially exposed eager activation construction.
- A parallel full-package run exposed a 512 KiB TCP response truncation: normal target close could
  destroy the source before its buffered response drained. The tunnel now distinguishes normal EOF
  from abrupt close and registers half-close listeners before connect; 48 concurrent targeted runs
  passed after the fix.
- `pnpm --dir packages/stack types:check`, focused Functions/gateway integration, full package
  integration (163 tests), Effect lint, formatting, and `git diff --check` passed.

### Task 10 — 2026-08-29

- Added independent, closed Docker and Podman CLI codecs plus one narrow container-engine contract
  for only the probe, image, resource-list, network, volume, and container lifecycle operations the
  runtime consumes. Commands use exact argv and bounded stdout/stderr, decoders admit only the
  required scalar label fields, nonzero/malformed responses remain typed failures, and automatic
  selection falls back from Docker to Podman only when the Docker executable is genuinely missing.
- Added production engine resolution for new container identities. The selected adapter must pass
  its routing preflight before state mutation, and the concrete `docker`/`podman` result is persisted.
  Existing identities reuse that engine without probing; conflicting explicit preferences fail
  before probing. Native identities never consult a container resolver.
- Added the strict `ContainerRuntime`: native artifacts fail before engine access; workload
  containers remain private; exact StackId/owner/generation/workload/spec-hash resources are adopted;
  same-owner stale containers are stopped and removed before recreation; foreign and sanitized-name
  collisions fail before image pulls or mutation; concurrent starts serialize; readiness cleanup
  preserves and combines the original and cleanup Causes.
- Persistent container storage is deliberately one volume per workload. The runtime accepts only a
  target/read-only request and derives the physical name from the full StackId and workload id,
  excluding generation so it survives restart. Volumes are identity-scoped, reused after container
  removal, and retained until destroy. This is the smallest unambiguous model supported by the
  current catalog labels.
- The real process runner now fails on the first output chunk beyond its bound, interrupts sibling
  reads/exit waiting, and performs an interruptible SIGTERM wait followed by exact SIGKILL fallback.
  A hostile child that remains alive and ignores SIGTERM proves both fail-fast overflow and reaping.
- Fixed the native launcher/readiness race uncovered by the combined runtime suite. Inherited owner
  and payload descriptors now use `node:net` sockets rather than filesystem streams, avoiding a
  blocked libuv threadpool shutdown; one cached exit-code Effect is shared by readiness and the
  watcher, and native runtime rejects container artifacts before process resolution. The exact
  diagnostic parent/launcher processes created while minimizing this failure were terminated and
  verified absent.
- Gateway-container lifecycle composition and stopped-stack ephemeral network cleanup remain Task 11. During running intent, a single workload readiness failure intentionally retains the shared
  private network and persistent volume for retries and other workloads; the failed newly-created
  workload container itself is stopped and removed.
- RED/GREEN review closed two Important findings: global caller-supplied volume names and output
  overflow waiting for EOF. Independent closure review found no remaining Critical or Important
  finding.
- `pnpm --dir packages/stack types:check` — passed.
- Focused container runtime, native runtime, and managed-handle integration suite — passed (43 tests
  across 3 files).
- Generic and Effect lint over all Task 10 sources/tests, formatting over sources/tests/docs, and
  `git diff --check` — passed.

### Task 11 — 2026-08-29

- Added one Effect-native lifecycle controller over durable state and an injected runtime backend.
  Start materializes and commits complete intent before reconciliation, reuses omitted configured
  input, treats identical running input as reconciliation, and rejects changed running input with
  explicit restart guidance. Stop retains durable state and reruns idempotent cleanup after a failed
  attempt; restart is generation-fenced so a concurrent stop wins; destroy retains the destroying
  fence until exact runtime/data cleanup succeeds and can be retried.
- Added running-only runtime recovery and exact stopped cleanup. Container recovery adopts only one
  exact current-generation workload/network, removes stale and duplicate owned resources plus every
  stale gateway, retains persistent volumes and foreign stacks, and never starts missing work.
  Native recovery similarly adopts only exact local resources without starting them. Stopped and
  unconfigured recovery use cleanup, so no current-generation ephemeral network is retained.
- Composed recovery, lifecycle, reconciliation, lazy activation, status, status watching, and logs
  in the Supervisor. Recovery completes before owner readiness; a persisted running intent recovers
  exact resources but reports the new owner stopped and never auto-starts after reboot. Lazy
  capabilities remain dormant until explicit activation, then activate their dependency closure and
  remain active for the generation. Actual phase is independent from durable desired intent, and
  complete status snapshots are published only at observable transitions.
- Maintenance quiesce releases ownership only after successful cleanup. Public Effect handles pass
  log options and expose scoped status/log streams. Expected lifecycle/runtime failures retain their
  exact RPC error tags instead of collapsing into a generic reconciliation error.
- The owner entrypoint intentionally has no concrete runtime factory yet. Its unavailable default
  makes a production start fail closed; Task 13 must wire the exhaustive native/container artifact,
  route, preparation, activation, and log-store catalogs before end-to-end stack startup can work.
  Credentials and prepare remain explicit unavailable stubs for the same later composition slice.
- Review RED/GREEN closed the stopped-recovery network ambiguity by making `recover` accept only a
  running desired lifecycle; stopped/unconfigured states must call `cleanup`. Independent review
  found no further Critical or Important lifecycle, recovery, lazy-activation, status/log, RPC, or
  quiesce defect, and separately identified the deliberately deferred production runtime wiring
  above.
- Focused lifecycle/runtime/reconciliation/Supervisor/handle/control verification passed (90 tests
  across 8 integration files), followed by the stack type-check. Generic and Effect lint over all 14
  changed TypeScript files, formatting, and `git diff --check` passed.

### Task 12 — 2026-08-29

- Added the Promise facade as a mechanical outer adapter over the authoritative Effect handle. Each
  Promise handle owns a private scope, closes idempotently without implicit destruction, unwraps every
  Redacted leaf to plain strings, maps absent Options to `undefined`, and exposes cancellation-safe
  AsyncIterables without an async-dispose symbol.
- Added `createTestStack` as the sole AsyncDisposable resource. It creates a unique temporary identity,
  starts and waits for readiness, and on disposal or startup failure destroys only its owned identity and
  removes its exact temporary root.
- Migrated CLI stack consumers to `@supabase/stack/effect` and current descriptors/status projections.
  `start` and managed Functions serving load `CliConfig` and translate the complete closed `StackConfig`,
  including listener/security settings, Functions root, and recursively redacted secret leaves. Both
  Functions serving command paths use the managed stack Functions capability and log stream.
- Retained non-stack command behavior (link, update, services, branch switch, and Functions list/new)
  while removing obsolete manager/daemon/version/transport compatibility helpers and stale fixtures.
  Running start-input changes retain explicit restart guidance; legacy start's integrated Edge Runtime
  channel remains intentionally outside this slice by ruling.
- RED/GREEN evidence: facade integration (`promise.integration.test.ts`, `testing.integration.test.ts`)
  passed 3 tests; migrated CLI integration scenarios passed 36 tests across 12 files. Stack and CLI type
  checks passed; generic and Effect lint, oxfmt, and `git diff --check` passed.

#### Fix round 1/5 evidence — 2026-08-29

- Canonical JSON schema decoding now covers nested Promise secret leaves; stream close and
  `createTestStack` cleanup preserve primary failures while finalizing exact owned resources.
- CLI Functions serving maps loaded config/manifest/env-file and managed readiness/API/logs; roots are
  project-relative, JWKS signing paths are emitted, and both top-level and `stack` restart commands
  provide explicit restart guidance.
- Post-fix focused verification: stack facade integration 2 files/7 tests; CLI integration 13 files/40
  tests; CLI units 4 files/10 tests; both workspace types; generic/Effect lint, formatting, and diff
  checks passed.

#### Fix round 2/5 evidence — 2026-08-29

- Closed Functions inspector mode/main settings preserve `run`/`brk`/`wait` and `--inspect-main` for
  both serve registrations without eager activation. Test-resource readiness is now derived from
  supplied config (disabled capabilities/listeners are exempt), with exact cleanup on close failure.
- Added natural/post-close Promise stream coverage, start changed-running `supabase restart` guidance,
  restart exclusion preservation, and honest linked/unlinked update output.
- Focused verification: stack facade/model/compiler 3 files/40 tests; CLI Functions/start/restart/update
  5 files/9 tests plus legacy/config units 2 files/9 tests; both workspace types; lint/format/diff checks
  passed.

#### Fix round 3/5 evidence — 2026-08-29

- Test-resource readiness now treats the public `disabled` capability state as terminal-ready even for
  default-disabled capabilities such as pooler. The ordinary isolated-stack fixture models pooler as
  disabled and resolves successfully; explicit disabled Functions/API coverage remains intact.
- Focused testing integration (5 tests), stack types, Effect/generic lint, formatting, and diff checks
  passed.

### Task 13A — 2026-08-29 (foundation)

| Capability           | Native/container artifacts                                                             | Settings/dependencies                                                         | Ports/routes/probes                                                              | Secrets/logs/activation                                           | Evidence                                           |
| -------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| database             | `postgres` slim release `17.6.1.166`; `ghcr.io/supabase/cli/postgres:17.6.1.166` image | database settings and bootstrap workload                                      | database TCP readiness                                                           | managed database password; eager                                  | compiler + runtime integration                     |
| rest                 | `postgrest`; `postgrest/postgrest`                                                     | REST settings/env; database dependency                                        | API HTTP route; private HTTP readiness                                           | passthrough settings; lazy activation                             | compiler + workload-runtime                        |
| auth                 | `auth`; `supabase/auth`                                                                | Auth settings/env and managed key slots; database dependency                  | API HTTP route; private `/health` readiness                                      | managed JWT/key slots; lazy activation                            | compiler + workload-runtime                        |
| realtime             | `realtime`; `supabase/realtime`                                                        | Realtime settings/env; database dependency                                    | API HTTP route; private `/api/ping` readiness                                    | passthrough settings; lazy activation                             | compiler + workload-runtime integration            |
| storage (+ imgproxy) | `storage`/`imgproxy`; storage-api/imgproxy images                                      | Storage settings/env and volume; image transformation selects companion       | API route/readiness; companion private HTTP endpoint                             | passthrough settings; lazy activation                             | catalog conditional + workload-runtime integration |
| functions            | Edge Runtime slim artifact/container                                                   | functions root, policy, inspector, per-function env                           | `/functions/v1/*` route; request-time activation and private `/_internal/health` | functionsRoot is the sole read-only `/__supabase_functions` mount | catalog + workload-runtime + container-runtime     |
| studio (+ pgmeta)    | studio/pgmeta slim artifacts; studio/pg-meta images                                    | Studio settings/env; REST/analytics deps                                      | Studio HTTP route; private profile/health probes                                 | passthrough settings; eager activation                            | compiler + workload-runtime integration            |
| mail                 | mailpit slim artifact/container                                                        | Mail settings/env                                                             | mail UI/SMTP/POP3 listeners; private `/readyz` probe                             | passthrough settings; eager activation                            | compiler + workload-runtime integration            |
| analytics (+ vector) | logflare/vector slim artifacts; Logflare/vector images                                 | Analytics settings/env; vector selected by `vector_port`; database dependency | API route/readiness; vector private HTTP endpoint                                | passthrough settings; lazy activation                             | catalog conditional + workload-runtime integration |
| pooler               | `supavisor` slim release `v2.9.12`; matching image                                     | Pooler settings/env and database dependency                                   | pooler TCP route/readiness; private transaction endpoint                         | managed pooler key slots; eager activation                        | compiler + catalog + workload-runtime integration  |

Common Task 13A source/test coverage: `model/WorkloadCatalog.ts` is the exhaustive slim-services identity table
with darwin-arm64, linux-amd64, and linux-arm64 target validation; `ExecutionPlan` materializes optional
companions from persisted settings; `runtime/WorkloadRuntimeSpec.ts` resolves every workload's command, args,
cwd, environment, private endpoint and readiness metadata; container specs carry env/commands and
Docker/Podman serializers emit them. `preparation/SlimServicesSource.ts` verifies manifest/checksum metadata,
decompresses and safely extracts archives, and composes with the atomic `ArtifactStore`; tests inject transport
and archive bytes and never access the network. Task 13B still owns Supervisor/RuntimeFactory production
composition, owner-scoped `StackGateway` lifecycle, exact private/public port allocation, credentials, and
redacting runtime logs. Functions remains stack-owned Edge Runtime; `functions serve` remains a client.

Narrow rulings and cost if wrong: Task 13A keeps transport and process/engine boundaries injectable so tests
remain offline and deterministic. Task 13B must preserve the native/container identity split and make
private-port reservation plus gateway ownership atomic with accepted lifecycle generations.

#### Task 13A fix round 1 — artifact and runtime hardening (2026-08-29)

- Native slim identities now match release archives for Realtime (`bin/server`), Analytics (`bin/logflare`),
  and Supavisor (`bin/server`, `bin/supavisor`, `bin/migrate`); catalog tests pin executable and required paths.
- `SlimServicesSource` uses injected Effect process tar list/link/extract boundaries, validates member/link
  traversal (including relative links), verifies SHA256SUMS and compressed bytes before extraction, and
  validates extracted realpaths. Tests cover internal links, PAX long names, malformed archives, and
  interruption without publication.
- Runtime specs flatten nested settings with service-recognized aliases, use native loopback versus the
  container `supabase-database` network alias, expose `containerResolutionFor`, and mount Functions' sole
  `functionsRoot` at `/__supabase_functions` read-only with aligned `--main-service` arguments.
- Docker/Podman serializers accept only owned env-file paths (never secret `NAME=value` argv) and serialize
  exact network aliases. Compiler integration proves the managed database password slot is persisted once
  and reused. Task 13B still owns env-file creation, gateway/port lifecycle, and production composition.

#### Task 13A fix round 2 — complete workload execution contracts (2026-08-29)

- Every catalog workload now has one stable container DNS alias, reused by private endpoints and
  intra-stack URLs (`supabase-database`, `supabase-pgmeta`, `supabase-imgproxy`, and companions).
  Studio's host-owned API URL and Analytics credentials use explicit owner-resolved inputs; no engine
  hostname or host-file path is guessed in this layer.
- Native Node workloads carry artifact-root-relative executable, script arguments, and working-directory
  metadata. Vector's native command targets the shipped `share/doc/vector/config/vector.yaml`; container
  resolution retains its separate `/etc/vector/vector.yaml` contract. Functions remains one Edge Runtime
  workload with its sole read-only `/__supabase_functions` mount and aligned `--main-service` argument.
- Runtime settings now include Realtime's IPv4/IPv6 `ERL_AFLAGS` and resolved JWKS input, Auth's exact
  SMS/double-confirm/password semantics, Mailpit fallback SMTP, Storage's imgproxy alias, Studio's
  pg-meta/analytics aliases, and BigQuery's read-only service-account mount. Optional values are omitted
  rather than emitted as blank service environment values.
- Database bootstrap credentials use the seven managed login roles from `schema.sql` and one Redacted
  `secret:database.internal.password`; integration coverage verifies all roles and no password leakage.
- Slim artifact decompression is an owned transform stream that is destroyed on interruption; checksum,
  manifest, safe archive extraction, and atomic publication remain injected/offline-testable.
- Fix-round evidence: catalog/compiler/database-bootstrap/runtime/slim/container integration tests pass
  (80 targeted tests in the latest run); Task 13B still owns env-file materialization, gateway/port
  lifecycle, credentials wiring, and production composition.

#### Task 13A fix round 3 — close remaining workload contract gaps (2026-08-29)

- PostgREST now selects the managed symmetric JWT secret or owner-resolved JWKS according to the
  persisted signing/third-party mode; typed resolution validation rejects missing JWKS and template
  base inputs before process/container creation.
- Auth mailer templates and enabled notifications use the legacy `GOTRUE_MAILER_TEMPLATES_*`,
  `SUBJECTS_*`, and notification suffixes with owner-resolved gateway URLs and file extensions.
- Third-party Auth issuer derivation is a closed pure mapping (Firebase/Auth0/Cognito/Clerk/WorkOS),
  with compiler validation for required fields and one-provider exclusivity.
- Studio native entrypoint cwd is the artifact `app`; Vector requires its shipped config; Postgres
  slim artifacts receive a contained `init-scripts` alias for the current archive layout.

#### Task 13A fix round 4 — provide Edge Runtime JWT material (2026-08-29)

- Functions validation now treats the stack-owned Edge Runtime as a JWT consumer, requiring owner-
  resolved JWKS material for `jwks-file` and third-party Auth modes before container/process creation.
- Edge Runtime receives the same `SUPABASE_INTERNAL_JWT_SECRET` managed Auth slot as GoTrue plus a
  valid `SUPABASE_JWKS` document (owner-resolved when available, otherwise the empty-key fallback);
  integration coverage exercises symmetric, jwks-file, and Firebase third-party paths.

#### Task 13B1 — unify ingress and private ports (2026-08-29)

- Persisted stack state now requires `privatePorts`, identifying every workload endpoint by the
  `(workloadId, binding)` pair. State decoding rejects duplicate bindings, duplicate ports, and any
  overlap between public and private assignments; omitted state fields fail closed without a migration.
- `PortCoordinator` allocates sticky private loopback ports from `30000–39999` and public host ports
  from `40000–65535` in one registry-lock transaction. Claims are scanned across every stack,
  retained while stopped, and returned as complete public/private assignment sets.
- Public host listeners use one `bindHost`/`HostListener` path for native and container stacks and are
  returned for direct adoption by the Supervisor-owned gateway. Container workloads publish only
  exact `127.0.0.1:<private>:<internal>` endpoints; Docker/Podman reject malformed or non-loopback
  publications before daemon mutation.
- The obsolete gateway container, activation server, activation file, and wire protocol were removed;
  lazy activation remains a direct in-process Supervisor call in both runtime modes.
- Focused ports/state, container-runtime/recovery, and gateway integration coverage passes. Production
  Supervisor/RuntimeFactory lifecycle wiring and credentials/log integration remain Task 13B's next slice.

#### Task 13B2a — complete private routing contracts (2026-08-29)

- Workloads expose a closed binding catalog: ordinary services use `primary`, while Mailpit declares
  `ui`/`smtp`/`pop3`. `privateBindingIntentsFor` derives every reservation from the execution plan;
  runtime resolution validates durable assignments and returns loopback container publications with
  fixed internal ports.
- `StackGateway` now owns maps of HTTP/TCP listeners keyed by `PortField`, rolling back all acquired
  listeners on failure and closing them once. `RouteCatalog` covers enabled API prefixes plus direct
  Studio/Mail/Functions inspector and database/pooler/SMTP/POP3 routes.
- Gateway forwarding supports route and prepared-route upstream path transforms. Legacy service roots
  are represented explicitly (GraphQL `/rpc/graphql`, Realtime `/socket/websocket` and `/api`, Storage
  S3 `/s3`), with query strings preserved. Functions requests rewrite `/functions/v1/<slug>` to the
  Edge Runtime `/<slug>` path for both HTTP and WebSocket forwarding.
- Evidence: workload-runtime (7), gateway (10), route-catalog (1), and the broader catalog/compiler,
  preparation/artifact, container, bootstrap, runtime, and gateway integration set (100 tests) pass;
  stack types, Effect/generic lint, formatting, and diff checks pass. Task 13B2b still owns production
  listener allocation/reconciliation and Edge Runtime bootstrap composition.

#### Task 13B2a review fix — gateway request transforms (2026-08-29)

- Gateway routes and prepared routes can transform upstream headers after hop-by-hop filtering for both
  HTTP and WebSocket forwarding. Internal `x-forwarded-*` values are rewritten from the accepted client
  connection, so client-supplied overrides cannot spoof them; WebSocket handshake headers are restored by
  the gateway after transformation.
- `routeCatalogFor` accepts owner-resolved API material and maps matching publishable/secret API keys to
  the corresponding anonymous/service JWT. REST/Auth/Realtime/Storage/GraphQL use `Authorization`,
  Functions use `sb-api-key`, GraphQL enforces `Content-Profile: graphql_public`, Storage S3 preserves
  AWS Authorization, and Realtime WebSocket `apikey` query mapping preserves unrelated parameters.
- No authentication is performed in the gateway and no API material is logged or included in failures.
  Focused gateway/route integration tests cover transforms, spoof removal, key mappings, S3/GraphQL/
  Realtime behavior, query preservation, Functions, and HTTP/WebSocket forwarding. Task 13B production
  composition still owns the resolved material source and listener lifecycle.

#### Task 13A fix round 5 — unify local JWT signing material (2026-08-29)

- Symmetric JWT configuration now has one canonical managed `secret:auth.settings.jwt_secret` slot;
  top-level `security.jwt.signing.secret` is accepted as an alias, equal dual declarations are
  deduplicated, and conflicting values fail typed before lifecycle mutation.
- JWKS-file and third-party modes retain Auth's local JWT secret for GoTrue, Edge Runtime, Realtime,
  Storage, and Supavisor while PostgREST consumes owner-resolved JWKS material where required.
- Compiler, runtime, and secret-store integration coverage verifies default/one-sided/equal/mismatch
  inputs, no duplicate slot, internal JWT consumers, and JWKS/third-party resolution semantics.

#### Task 13A fix round 6 — generate valid managed API credentials (2026-08-29)

- Managed Auth omissions now use slot-aware lifecycle generation: publishable and secret keys receive
  cryptographically random `sb_publishable_`/`sb_secret_` values, while the canonical JWT secret
  receives 32 random bytes encoded as base64url. Existing persisted or explicit values remain sticky.
- Omitted anonymous and service-role keys are legacy-shaped JWTs (`iss: supabase-demo`, role, expiry)
  signed with the canonical local secret in symmetric mode or the first supported private ES256/RS256
  JWK in `security.jwt.signing.path`. JWK files are read only during secret resolution, with
  project-root containment and redacted typed failures for malformed/public-only material.
- Compiler carries only private generator descriptors; no generated bytes or signing-file reads enter
  preparation or the durable definition. Secret-store integration covers entropy/prefixes, sticky and
  explicit values, HS256/ES256 signatures, and invalid/escaping signing files.

#### Task 13B2b1 — production runtime preparation primitives (2026-08-29)

- `RuntimeArtifacts` resolves native catalog artifacts and published checksums into one validated
  `ArtifactRequest`/`ArtifactStore` operation, while container preparation probes and inspects the
  persisted Docker/Podman engine and pulls only the exact missing image (never create/start).
- `RuntimeEnvFile` owns generation/workload container env files below the stack runtime directory,
  using atomic owner-only writes, deterministic encoded workload names, validation before writing,
  and exact idempotent generation/all cleanup. Native workloads continue to use fd4 env transport.
- `ReadinessProbe` provides cancellation-safe HTTP/TCP probes with bounded Effect Schedule retries;
  requests and sockets are destroyed on interruption and failures are typed without carrying secret
  material. Focused integration evidence covers native/container artifact outcomes, env permissions,
  validation/cleanup, readiness success/failure, and interruption.

#### Task 13B2c — stack-owned Edge Runtime functions bootstrap (2026-08-29)

- The offline-bundled Edge Runtime main service now belongs to `@supabase/stack`; the CLI imports
  the stack bundler rather than maintaining a second template. Request-time discovery reads the
  mounted functions root on every request, uses persisted overrides or complete defaults, and
  creates workers with `forceCreate`/no module cache so new, edited, and deleted functions are
  reflected without restarting the stack. Root containment and realpath checks fail closed for
  traversal and symlink escapes.
- Functions workloads use a private stack-owned generation bootstrap (`0700` directory/`0600`
  file). Containers retain one read-only functions-root bind and copy the bootstrap into `/root`
  after create and before start; adopted containers are never recopied. Native launchers receive
  the owner-resolved bootstrap directory through runtime inputs. Docker and Podman copy commands
  use argv only, with no shell or secret-bearing arguments. The published package exports the
  stack-owned bundler/template directly, and the generated runtime environment keeps the resolved
  `functionsRoot`, `SUPABASE_INTERNAL_FUNCTIONS_ROOT`, and JWT/API host-port material in the exact
  workload env contract without duplicating CLI helpers.
- Focused stack bundler/bootstrap/workload/container and CLI function tests pass; stack package
  type-checking now passes after the lifecycle/secret-store Clock follow-up.
- The published package metadata contains only the stack-owned bootstrap entrypoint and template;
  resolved function environments include the exact `SUPABASE_INTERNAL_PUBLISHABLE_KEY`,
  `SUPABASE_INTERNAL_SECRET_KEY`, `SUPABASE_INTERNAL_JWT_SECRET`, and
  `SUPABASE_INTERNAL_HOST_PORT` values consumed by Edge Runtime.

#### Task 13B2b1 correction — harden managed credential generation (2026-08-29)

- Managed ES256/RS256 API-key JWTs now derive their ten-year expiry from the injected Effect Clock,
  while the legacy HS256 path retains its fixed `1_983_812_996` expiry and exact claim shape.
- JWK signing resolves canonical project-root and file realpaths before reading, rejecting symlink
  escapes with the existing redacted typed error. Header/payload construction is explicitly typed;
  focused coverage uses TestClock and a temp-directory symlink escape.

#### Task 13B2b2a — Supervisor-owned ingress lifecycle foundation (2026-08-29)

- `SupervisorRuntime` may provide one cohesive ingress owner. Accepted running generations reserve
  sticky public/private ports and bind host listeners before eager workload reconciliation; the
  gateway is opened only after reconciliation succeeds. Same-generation starts reuse the exact
  listener/server identity, while restart/stop/destroy close ingress before runtime cleanup.
- Persisted-running recovery adopts runtime resources, starts missing eager workloads (lazy routes
  remain dormant), then acquires and opens ingress before the owner reports readiness. Reconcile,
  gateway, and listener failures close newly acquired resources while preserving the original typed
  cause for recovery retry.
- Production ingress composes `PortCoordinator`, `privateBindingIntentsFor`, `routeCatalogFor`, and
  `makeGateway`; API forwarding material is read only from persisted key/JWT slots. The host listener
  binder uses `node:http` for HTTP fields and half-open `node:net` for TCP fields, with interruption-
  safe, scope-owned close and typed occupied-port failures. Focused host-listener integration tests
  cover HTTP/TCP binding, adoption metadata, and occupied exact ports.

#### Task 13B2b2a correction — generation-fenced port materialization (2026-08-29)

- Persisted state now records `portsGeneration` explicitly (`null` until public/private assignments are
  materialized). Running acquisition keeps the prior marker through assignment writes and advances it only
  after every listener binds and the final generation fence succeeds; failed binds leave the old marker so
  recovery can retry the same accepted generation. Stopped plans mark assignments materialized immediately.
- Running listener/private intent fences use marker equality rather than assignment-array length, including
  generations with no listeners or private bindings. Focused state/ports tests cover null/number round trips,
  empty-set fencing, sticky retry after bind failure, deterministic final-fence cleanup, and stopped markers.

#### Task 13B2b3 — initial database bootstrap runtime (2026-08-29)

- The slim Postgres artifact remains the owner of bundled init scripts and migrations. Stack runtime
  bootstrap does not enumerate or reapply artifact SQL; after database readiness it reconciles the
  `_realtime` schema owner, all seven managed login-role passwords, and `app.settings.jwt_secret` /
  `app.settings.jwt_exp` under the bootstrap advisory lock.
- Both native and container database workloads run the same one-shot bootstrap through the persisted
  loopback private database port. PostgreSQL access uses the scoped Effect SQL client; role and setting
  statements are built by parameterized `format()` calls so generated secret SQL is never exposed in
  mapped errors. A bootstrap failure cleans up new resources and stops an adopted database container
  without removing it, allowing an idempotent retry on the next reconciliation.
- Initial runtime settings are intentionally distinct from caller-driven database migrations and seeds.
  Database reset is outside this rewrite and will be tackled in a separate future session.

#### Task 13B2b4 — production runtime composition (2026-08-29)

- The real Supervisor entrypoint now composes one runtime factory from the persisted runtime choice. Native
  stacks construct only the slim-artifact/native driver path; container stacks construct only their selected
  Docker or Podman engine and never probe or prepare the opposite runtime.
- Every workload operation re-reads persisted state before resolving artifacts, private endpoints, env, and
  bootstrap inputs. Immutable preparation is cached per workload identity, container env remains in owned
  `0600` generation files, native env remains on fd4, and database bootstrap runs only after a real loopback
  readiness probe for both new and recovered workloads.
- Database and Storage use disjoint identity-scoped persistent roots. Container volumes survive stop and are
  removed only on destroy; native paths remain under `<stack>/data/database` and `<stack>/data/storage`.
  Functions bootstrap files and container env files are exact stack-owned runtime resources and are removed
  on stop/destroy even when process/engine cleanup also fails, with both typed causes preserved.
- The runtime exposes the same loopback private endpoint to lazy gateway activation in native and container
  modes. Runtime logs re-read current secret slots before every append/read/stream operation, so secrets
  materialized after factory creation are redacted before persistence and in retained output.
- Review corrections removed eager native construction in container mode, added container readiness on start
  and recovery before database bootstrap, and made runtime-file cleanup independent of engine cleanup.
- Fresh evidence: production-runtime, container-runtime, runtime-artifact, and functions-bootstrap integration
  suites pass (32 tests), and `@supabase/stack` type-checking passes. Complete container log attachment,
  public `credentials`/`prepare` handlers, and owner-resolved service file inputs remain later Task 13 slices.

#### Milestone Fable review — committed rewrite components (2026-08-29)

- Ran six independent Fable reviews over the committed model/state, ownership/lifecycle, artifact/runtime,
  gateway/Functions, production/database/logging, and public facade/CLI milestones. Active implementation
  work was paused so the review snapshot contained only committed code.
- Accepted findings were triaged against the design and reduced to demonstrated lifecycle ownership,
  production lazy activation, explicit routed workloads, gateway/Functions correctness, runtime startup and
  persistence contracts, compiler/state error invariants, facade boundaries, and minimal CLI coverage.
- Rejected speculative work includes database reset placeholders, cross-release RPC migrations before a
  second released protocol exists, alternate artifact trust roots, archive/cache framework expansion, and
  broad aesthetic refactors. The implementation remains greenfield and exact-use-case scoped.

#### Task 13B2b5 — service startup contracts (2026-08-29)

- Native workloads now use one strict process plan: sequential scoped service-owned startup one-shots, then
  the long-lived process and readiness. Fast process exit does not cancel stdout/stderr draining, failures
  prevent the main process, and interruption kills only the exact owned child.
- Auth, Storage, Realtime, Analytics, and Pooler use their audited slim-services migration/startup commands.
  Auth and Storage container command chains compensate for their intentionally empty image entrypoints;
  Realtime, Analytics, and Pooler retain their derived-image entrypoints. Mailpit uses only `MP_*` environment
  configuration.
- Storage owns one `/mnt` volume and imgproxy mounts the same volume read-only with `/mnt` as its filesystem
  root. Native and container persistence contracts now match.
- Initial commit `a0c127637`; fix commit `81edf9969` removed the obsolete direct-process resolver fallback.
  Independent review then found no Critical or Important issue. Targeted native/workload/recovery integration
  verification passed 37 tests with stack type-check, lint, formatting, and diff checks green.

#### Task 13B2b6 — stack-owned runtime inputs (2026-08-29)

- Added one Effect-native owner for contained project files, all local private signing JWKs and public JWKS,
  injected third-party OIDC discovery, Auth template mappings, Analytics `gcp_jwt_path`, atomic owner-only
  Pooler tenant generation files, and materialized Functions secret names/values.
- Project paths must be relative regular files whose canonical path remains under the canonical project root.
  Functions rejects reserved `SUPABASE_*` names and all C0/DEL control characters. OIDC error labels remove
  userinfo, query, and fragment data while network requests retain the configured URL.
- JWT material is resolved only when at least one of REST, Auth, Realtime, Storage, or Functions is enabled;
  disabling Auth alone does not omit material still required by another consumer.
- Initial commit `ff02f4181`; fix commit `a77c0e013` closed the enabled-consumer and diagnostic-redaction review
  findings. Independent re-review was clean; focused input/secret integration verification passed 27 tests
  with stack type-check, lint, formatting, and diff checks green. Production and gateway wiring remain the
  next slice.

#### Task 13B2b7 — lifecycle/Fable correction (2026-08-31)

- Supervisor lifecycle, activation, and recovery work now runs in one owner-scoped FiberSet behind a serialized
  execution lane. Equivalent starts use an Effect-encoded, canonical SHA-256 request digest (including transient
  redacted values only for identity); distinct secret values cannot join. Lazy activation commits success once per
  generation, retries failures, and invalidates on a generation change.
- Supervisor construction no longer observes the runtime engine before owner control/readiness publication. The
  entrypoint publishes the endpoint and fd3 readiness first, then runs deferred recovery; blocked or failed recovery
  leaves the owner attachable and retains a supervisor error log. Control maintenance waiters may time out without
  cancelling accepted stop work.
- Destroy shutdown is transport-owned: the exact owner session is signalled only after a successful destroy response
  write. Focused supervisor/control/handle/lifecycle verification passed 69 integration tests with stack type-check,
  Effect lint, formatting, and diff checks green.

#### Task 13B2b7 correction — lifecycle/Fable follow-up (2026-08-31)

- Persisted plan rebuilding is deferred until owner-scoped recovery, after control endpoint and fd3 readiness;
  malformed persisted material leaves an attachable owner and recovery failures are visible as stopped/failed status.
  Explicit start/restart clears the failure marker and remains retryable.
- Quiesce keeps accepted stop work in the Supervisor FiberSet. Normal maintenance signals shutdown after the response
  is written, while an interrupted waiter starts an owner-scoped join that signals only after successful quiesce.
  Ordinary stop does not shut down the owner. Destroy callbacks require a connected client; stale request IDs are
  removed through a single-consumer disconnect proxy queue.
- Start/restart identity uses compiler-normalized definitions and effective secret values in a canonical SHA-256 digest;
  equivalent defaults join, distinct transient secrets remain isolated. Focused supervisor/control/handle/lifecycle
  verification passed 74 integration tests with stack type-check, Effect lint, formatting, and diff checks green.

#### Task 13B2b7 correction round 2 — owned interruption and recovery guards (2026-08-31)

- Owned lifecycle waiters now retain and pass the exact accepted Deferred to interruption continuations;
  quiesce and destroy therefore complete terminal shutdown after waiter timeout/disconnect without re-evaluating
  the operation. Activation rejects while persisted recovery is failed and resumes only after explicit recovery.
- Client reset read/close errors are treated as normal per-connection completion while open/write failures remain
  visible. A real handles flow persists an unsupported plan, observes failed status after fd3/control readiness,
  probes the same owner, and restores state for scoped cleanup.
- Supervisor readiness uses a bounded thirty-second local deadline to accommodate real subprocess startup; the
  subprocess-backed handles suite carries the same test guard. Focused lifecycle/control/handles verification is
  green with stack type-check, Effect lint, formatting, and diff checks.

#### Task 13B2b7 correction round 3 — terminal transport handoffs (2026-08-31)

- Destroy request disconnects are held until the accepted RPC exit is processed. A successful response write is the
  post-response handoff even if the client closes immediately afterward; a disconnected or failed write uses the
  explicit abandoned-destroy path, and failed destroy exits never signal owner shutdown.
- Quiesce retains its Supervisor-owned exact-operation continuation for interrupted waiters and adds a transport
  abandoned path for successful responses interrupted before normal completion. Maintenance stop/probe remain
  non-terminal, and raw client reset read/close errors complete only that connection.
- Focused supervisor/control/handle/lifecycle verification passed 80 integration tests with stack type-check,
  Effect lint, formatting, and diff checks green.

#### Task 13B2b7 Fable delta — freshness and atomic handoffs (2026-08-31)

- Accepted Fable findings 1.1–1.4 and the generation-bump regression from 1.5; deferred the duplicate candidate
  materialization and classifier/test-scaffolding refactors as disproportionate to this minimal slice.
- Deferred recovery now re-reads persisted state after acquiring execution. Superseded generation/lifecycle/input
  becomes a no-op owned by the newer lifecycle operation, while generation adoption refuses stale backward moves.
  A restart-before-recovery regression preserves running status, generation, and credentials.
- Owned waiter acceptance and continuation registration are now masked atomically, restoring interruption only for
  the Deferred wait. Maintenance response classification is attached before operation evaluation and guarded so
  normal completion cannot be forked twice.
- Launcher owner rereads now derive their 25ms schedule budget from the bounded 30-second readiness deadline.
  Focused lifecycle/control/handle verification passed 81 integration tests with stack type-check, Effect lint,
  formatting, and diff checks green.

#### Task 13B2b7 Fable delta — completion witness and recovery retry (2026-08-31)

- Accepted Fable findings 1.1, 1.2, and cleanup 3.1; deferred the duplicate-suppression test and classifier
  refactor as disproportionate to this minimal slice.
- Maintenance completion callbacks now fork into the owner-scoped FiberSet and publish their completion witness
  inside one uninterruptible handoff, so an interruption before the fork remains recoverable while a completed fork
  cannot be classified twice.
- Recovery now has an explicit same-generation fail-then-retry regression: the first attempt exposes stopped/failed
  status, the second succeeds without changing generation, and the driver is invoked exactly twice. Removed the
  unused recovery gate from the shared fixture.
- Focused lifecycle/control/handle verification passed 81 integration tests with stack type-check, Effect lint,
  formatting, and diff checks green.

#### Task 14 — runtime-input and startup-contract corrections (2026-08-31)

- Tightened persisted runtime inputs: PostgreSQL remains pinned to `17.6.1.166`; native/container Pooler
  endpoints derive from persisted runtime state and private database assignments, tenant settings are persisted,
  and tenant bootstrap updates existing Supavisor tenants idempotently with Elixir interpolation escaped.
- The owner now performs generation/state single-flight with owner-scoped Fibers, retries failed resolutions,
  invalidates exact generations, and publishes atomic `0600` Pooler files only after Functions-secret validation.
  Project files remain live canonical paths; OIDC diagnostics redact userinfo/query/fragment data while requests
  retain configured URLs. Signing JWKS rejects mixed invalid files, preserves all private keys, and publishes
  symmetric verification metadata. Auth material is resolved only when a JWT consumer is enabled.
- Startup contracts set imgproxy's filesystem root to `/`, require Storage's migration artifact, and pass native
  Supavisor artifact paths as quoted positional arguments. Focused owner/secret/workload/catalog integration tests
  pass 55 cases with stack type-check, Effect lint, formatting, and diff checks green. Production wiring remains
  the next slice; `RuntimeInputOwner.resolve(state, generation)` now derives runtime from persisted state and the
  owner requires an ambient `Scope` for its FiberSet.
