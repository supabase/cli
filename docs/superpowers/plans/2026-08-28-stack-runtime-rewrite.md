# Stack Runtime Greenfield Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `@supabase/process-compose` and the existing `@supabase/stack` implementation with
one minimal Effect v4 managed-stack runtime implementing the approved native/container architecture.

**Architecture:** Public APIs name stacks and capabilities; private capability Modules compile a
fully materialized definition into workloads. One detached Supervisor owns durable intent,
reconciliation, private runtime resources, the public gateway, and a single control endpoint. The
Effect API is authoritative; Promise and CLI surfaces mechanically adapt it.

**Tech Stack:** TypeScript 7, Effect v4 RC pinned by the workspace catalog, Effect Platform for Bun
and Node, Effect RPC, Vitest with `@effect/vitest`, pnpm/Turbo, native subprocesses, Docker/Podman.

**Spec:** `docs/superpowers/specs/2026-08-28-stack-runtime-rewrite-design.md`

**Progress:** `docs/superpowers/plans/2026-08-28-stack-runtime-rewrite-progress.md`

## Global constraints

- Greenfield implementation: delete obsolete APIs, tests, adapters, and compatibility scaffolding.
- Managed stacks only. Ordinary handles use explicit `close()`; only `createTestStack` supports
  `await using` and destroys its unique identity on disposal.
- Core code is Effect-native. Promises exist only at public non-Effect entrypoints and foreign leaf
  adapters; production code must not use TypeScript casts to silence type errors.
- Consult `.repos/effect/` before choosing an Effect construct. Use `Data.TaggedError` by default and
  the pinned v4 `Schema.TaggedErrorClass` only when the error itself needs a Schema; use services and
  Layers, Scope/acquireRelease, Deferred or shared Fibers for single-flight, Semaphore for lifecycle
  serialization, SubscriptionRef for snapshot state, PubSub for retained/live logs, Schedule for
  retry, and Effect RPC for the exact-release protocol.
- Never allocate reusable mutable ownership state while constructing an Effect. Build it inside
  `Effect.gen`, `Effect.suspend`, or scoped acquisition.
- Native and container workloads never mix in one identity. Every catalog workload has both native
  and container artifacts; unsupported platform/runtime mappings fail before durable mutation.
- Persist complete materialized definitions including defaults. Persist secret bytes and concrete
  port assignments exactly once in their dedicated state fields.
- Lazy activation is mandatory in both runtimes and has no idle eviction.
- Functions are served only through the stack Edge Runtime. `functionsRoot` is the sole host root and
  container mount; reject traversal, absolute, and symlink escapes.
- Use the portable archive and image from the same qualified `supabase/slim-services` release for
  each workload. Initially accept only PostgreSQL `17.6.1.166`; add PostgreSQL 15 only after its
  matching archive and image are published.
- The caller owns migrations, declarative schemas, and seeds. Database reset is outside this rewrite;
  do not add a reset API, state, lifecycle variant, or compatibility placeholder.
- Tests follow strict red-green-refactor and exercise consumed behavior. Prefer integration tests;
  unit-test only pure compiler/planner/state-machine logic. No arbitrary sleeps, released-port reuse,
  global process scans, or broad cleanup.
- Use only targeted tests during implementation. Do not run unrelated e2e suites.
- Every completed task updates the tracked progress ledger and lands as one focused commit.

## Component map

```text
packages/stack/src
├── public/       schemas, errors, Effect contract, Promise adapter
├── identity/     project/worktree identity and StackId
├── model/        capability Modules, catalog, materialized compiler, execution graph
├── state/        paths, atomic document, secret slots, ports, ownership
├── control/      stable maintenance framing, exact-release RPC, clients
├── supervisor/   owner session, desired state, reconciler, status/log publication
├── preparation/  verified native/container artifacts
├── runtime/      common contract, native driver, container driver/engine adapters
├── gateway/      Supervisor-owned HTTP/TCP ingress and direct activation
├── functions/    safe live function discovery
└── entrypoints/  Node/Bun Supervisor and gateway programs
```

Each file owns one responsibility. Public modules never export workload ids, execution plans,
artifact keys, state schemas, drivers, or control protocols.

---

### Task 0: Remove the legacy implementations and establish the empty package boundary

**Files:**

- Delete: `packages/process-compose/**`
- Delete: legacy `packages/stack/src/**`, `packages/stack/tests/**`, `packages/stack/scripts/**`, and
  stale `packages/stack/docs/**`
- Create: `packages/stack/src/public/index.ts`, `packages/stack/src/index.ts`,
  `packages/stack/src/effect.ts`, `packages/stack/src/testing.ts`
- Replace: `packages/stack/package.json`, `packages/stack/README.md`, `packages/stack/vitest.config.ts`
- Modify: `package.json`, `.oxlintrc.json`, `knip.json`, `turbo.json`, `apps/cli/package.json`,
  `apps/cli/src/next/main.ts`, CLI tests importing the old process mock, telemetry coverage,
  `AGENTS.md`, `CONTRIBUTING.md`, `pnpm-lock.yaml`

**Interfaces:**

- Produces a private ESM `@supabase/stack` workspace with only `.`, `./effect`, and `./testing`
  exports and no runtime behavior yet.
- Moves the generic `mockChildProcessSpawner` test utility to
  `apps/cli/tests/helpers/child-process-spawner.ts`; this is test infrastructure, not a runtime API.

- [ ] **Step 1: Record the deletion baseline**

  Add the base commit and the exact active process-compose references to the tracked progress file.

- [ ] **Step 2: Delete both legacy implementations before writing replacement runtime code**

  Keep only package configuration, the empty public barrels, and the approved tracked design. Do not
  copy orchestration implementation into the new tree.

- [ ] **Step 3: Remove workspace and CLI process-compose coupling**

  Remove manifest/config/lockfile entries, process-compose self-dispatch in the CLI bootstrap, old
  telemetry adapters, and active documentation references. Preserve `.repos/process-compose` and
  historical design/ADR references because those are source history, not the deleted workspace.

- [ ] **Step 4: Regenerate the lockfile and verify the empty boundary**

  ```bash
  pnpm install --lockfile-only
  rg -n '@supabase/process-compose|packages/process-compose' package.json packages apps \
    --glob '!docs/superpowers/**' --glob '!docs/adr/**'
  pnpm --dir packages/stack types:check
  ```

  Expected: install and stack type-check exit 0; the search finds no active reference.

- [ ] **Step 5: Commit**

  ```bash
  git add -A
  git commit -m "refactor(stack): remove legacy stack runtimes"
  ```

### Task 1: Public schemas, tagged failures, and stable status snapshots

**Files:**

- Create: `packages/stack/src/public/StackId.ts`, `Runtime.ts`, `Capability.ts`, `Status.ts`,
  `Logs.ts`, `Credentials.ts`, `Errors.ts`
- Create: `packages/stack/src/public/public-model.integration.test.ts`
- Modify: `packages/stack/src/public/index.ts`, `packages/stack/src/index.ts`

**Interfaces:**

- Produces the common public model from the spec: `StackId`, `StackRuntime`,
  `StackRuntimePreference`, ten `CapabilityName` values, `StackStatus`, `LogCursor`, `StackLogEntry`,
  descriptors/inspection, credentials, and operation-specific error unions. Task 3 adds the closed
  capability configuration after every Module owns its settings schema.
- Promise secret-bearing types contain `string`; Effect secret-bearing types contain
  `Redacted.Redacted<string>`.

- [ ] **Step 1: Write decoding and snapshot-contract integration tests**

  ```ts
  it.effect("decodes a complete status snapshot", () =>
    Schema.decodeUnknownEffect(StackStatusSchema)(STATUS_FIXTURE).pipe(
      Effect.map((status) => expect(status.capabilities).toHaveLength(10)),
    ),
  );
  ```

  Assert with public predicates or error matching rather than Effect runtime fields.

- [ ] **Step 2: Run RED**

  ```bash
  pnpm --dir packages/stack exec vitest run --project integration src/public/public-model.integration.test.ts
  ```

  Expected: failure because the schemas do not exist.

- [ ] **Step 3: Implement schemas and errors with Effect v4 APIs**

  Use `Data.TaggedError` for ordinary domain failures and pinned v4 `Schema.TaggedErrorClass` only for
  failures that cross a schema-serialized boundary. Decode through `Schema.decodeUnknownEffect`;
  never throw expected validation failures.

- [ ] **Step 4: Verify and commit**

  ```bash
  pnpm --dir packages/stack exec vitest run --project integration src/public/public-model.integration.test.ts
  pnpm --dir packages/stack types:check
  git add packages/stack docs/superpowers/plans/2026-08-28-stack-runtime-rewrite-progress.md
  git commit -m "feat(stack): define the greenfield public model"
  ```

### Task 2: Deterministic identity and safe state paths

**Files:**

- Create: `packages/stack/src/identity/Identity.ts`, `GitIdentity.ts`, `FolderIdentity.ts`
- Create: `packages/stack/src/state/Paths.ts`
- Create: `packages/stack/src/identity/identity.integration.test.ts`
- Modify: `packages/stack/src/public/StackId.ts`, `public-model.integration.test.ts`
- Modify: `packages/stack/package.json`, `pnpm-lock.yaml` to add the concrete Node platform test layer;
  core identity/path functions retain visible `FileSystem` and `Path` requirements

**Interfaces:**

- Produces `resolveStackIdentity({ projectRoot, name })`, `deriveStackId(identity)`, and
  exact identity-scoped paths beneath the user-local stack state root.
- `StackIdSchema` accepts exactly the 64 lowercase hexadecimal characters produced by SHA-256; path
  APIs accept only this decoded branded value.
- Path construction accepts only validated `StackId` values and cannot address a parent, sibling, or
  another identity.

- [x] **Step 1: Write real filesystem/worktree and path-safety tests and verify RED**

  Cover repeat identity, named isolation, sibling worktrees, detached checkout, nested project roots,
  branch changes, invalid ids, and exact path containment.

  ```bash
  pnpm --dir packages/stack exec vitest run --project integration \
    src/identity/identity.integration.test.ts
  ```

- [x] **Step 2: Implement identity without a registry daemon**

  Canonicalize the project root, derive the tuple documented by the spec, and hash length-delimited
  UTF-8 components into an opaque lowercase digest. Discovery performs no writes.

- [x] **Step 3: Implement exact state-path derivation with platform services**

  Keep `FileSystem` and `Path` requirements visible. Validate identity before joining path segments;
  expose stack root, state document, data, logs, control metadata, and temporary sibling paths without
  performing lifecycle mutation.

- [x] **Step 4: Verify and commit**

  Run the targeted identity file and package type-check, update progress, then commit:

  ```bash
  git add packages/stack pnpm-lock.yaml \
    docs/superpowers/plans/2026-08-28-stack-runtime-rewrite.md \
    docs/superpowers/plans/2026-08-28-stack-runtime-rewrite-progress.md
  git commit -m "feat(stack): add identity and safe state paths"
  ```

### Task 3: Closed capability Modules and the materialized compiler

**Files:**

- Create: `packages/stack/src/model/CapabilityModule.ts`, `ExecutionPlan.ts`, `Compiler.ts`
- Create: `packages/stack/src/public/Config.ts`
- Create: `packages/stack/src/model/capabilities/{database,rest,auth,realtime,storage,functions,studio,mail,analytics,pooler}.ts`
- Create: `packages/stack/src/model/compiler.integration.test.ts`
- Create: targeted pure planner tests beside `Compiler.ts` only for fingerprint and graph branches

**Interfaces:**

- Produces the exact closed `StackConfig` and listener/security schemas from the design.
- Each Module owns its exhaustive settings Schema, defaults, validation, secret classification,
  dependencies, workload definitions, readiness, routes, and both artifact mappings.
- Produces `compileStack(input, previous?)` returning non-secret `StackDefinition`, non-secret
  `InputFingerprint`, resolved secret-slot inputs, and private `ExecutionPlan`.
- Workload ids and concrete artifact keys remain private.

- [x] **Step 1: Write one public compiler scenario per capability and verify RED**

  Each scenario supplies non-default values accepted by current CLI configuration and asserts they
  survive in the materialized definition. Add cross-cutting scenarios for all defaults persisted,
  unknown fields rejected, secret bytes absent, exact unsupported versions rejected before output,
  both runtime mappings present, and functions path normalization.

- [x] **Step 2: Implement the ten direct closed schemas**

  Use direct `Schema.Struct` declarations owned by each Module; do not add a code generator or open
  property bags. Port the actual supported fields from `CliConfig` and from the baseline sources at
  `de26a30c7:packages/stack/src/StackConfig.ts` and `ServiceCatalog.ts`, updating consumers in the
  same task rather than preserving the old shapes.

- [x] **Step 3: Implement pure compilation**

  Canonicalize non-secret input for the fingerprint, preserve explicit omission versus selection,
  apply every default, convert secret leaves to generated slots, validate dependency closure, and
  derive semantic workload-spec hashes. Reuse the persisted definition on identical fingerprints.

- [x] **Step 4: Verify and commit**

  Run only `compiler.integration.test.ts`, adjacent pure planner tests, and stack type-check. Commit:

  ```bash
  git add packages/stack docs/superpowers/plans/2026-08-28-stack-runtime-rewrite-progress.md
  git commit -m "feat(stack): compile closed capability definitions"
  ```

### Task 4: Atomic durable state, sticky secrets, and port coordination

**Files:**

- Create: `packages/stack/src/state/StackState.ts`, `StackStateStore.ts`, `SecretStore.ts`,
  `PortRegistry.ts`, `PortCoordinator.ts`
- Create: `packages/stack/src/state/state-store.integration.test.ts`, `secrets.integration.test.ts`,
  `ports.integration.test.ts`

**Interfaces:**

- Produces `StackStateStore`, `resolveSecrets(candidate, persisted, lifecycle)`, and scoped
  `PortCoordinator.planAndReserve(stackId, listenerIntents)`.
- `PersistedStackState` has one format identifier, identity, concrete runtime, generation, desired
  lifecycle, optional materialized definition/fingerprint, ports, and secret values. Reads are
  lock-free; writes atomically replace one complete owner-only document.
- Automatic assignments are globally exclusive while stopped/running; stopped exact assignments may
  coexist and are validated only on start. Assignments stay sticky after bind races.

- [ ] **Step 1: Write state, secret, and port scenarios first**

  Test atomic old-or-new reads, corrupt-state fail-closed behavior, exact-identity cleanup, managed
  generation/reuse/mismatch, stopped-only pass-through replacement, no secret bytes in fingerprints/
  log messages, automatic sticky exclusivity, exact stopped coexistence, live exact conflicts,
  unchanged assignment reuse, native socket transfer, and container bind-race retention.

- [ ] **Step 2: Verify RED, then implement atomic state and scoped acquisition**

  Encode/decode through Effect Schema; atomically replace owner-only state through a sibling temporary
  file and required fsync operations. Reserve complete candidate sets under the short registry lock
  and state generation fence. Own native sockets with `Effect.acquireRelease`; use an engine-
  authoritative publish result for containers. Never bind-release-rebind an automatic native port.
  The first release reads and writes only `supabase-stack-state-v1`; add no migration framework.

- [ ] **Step 3: Verify and commit**

  Run the three targeted integration files plus stack type-check and commit:

  ```bash
  git add packages/stack docs/superpowers/plans/2026-08-28-stack-runtime-rewrite-progress.md
  git commit -m "feat(stack): persist state secrets and sticky ports"
  ```

### Task 5: One owner endpoint, Supervisor launch, and managed handles

**Files:**

- Create: `packages/stack/src/state/Ownership.ts`
- Create: `packages/stack/src/control/MaintenanceProtocol.ts`, `StackRpc.ts`, `ControlClient.ts`
- Create: `packages/stack/src/supervisor/Supervisor.ts`, `OwnerSession.ts`, `Launcher.ts`
- Create: `packages/stack/src/entrypoints/supervisor-{node,bun}.ts`
- Create: `packages/stack/src/public/EffectStack.ts`
- Create: `packages/stack/src/supervisor/handles.integration.test.ts`

**Interfaces:**

- Produces Effect `createStack`, `openStack`, `findStack`, `listStacks`, and `inspectStack`, plus the
  complete `EffectStack` handle contract: status, credentials, prepare, start, restart, stop, destroy,
  close, status snapshots, and logs. Later tasks connect those methods to their runtime components.
- One atomic ownership primitive and endpoint carries frozen bounded-JSON maintenance operations plus
  exact-release Effect RPC. Ordinary handles are scoped/closeable; owner work outlives handles.

- [ ] **Step 1: Write multi-process handle scenarios and verify RED**

  Cover create without config/start, same identity joining one owner, open-only behavior, read-only
  discovery, closing/caller exit survival, concurrent equivalent create, incompatible owner failure,
  and stable maintenance stop.

- [ ] **Step 2: Implement ownership and protocols**

  Use one endpoint, random owner session, bounded framing, typed decode failures, and Effect RPC for
  exact-release operations. Register all callback listeners before starting I/O, resume at most once,
  and remove every owned listener/socket in the cancellation Effect.

- [ ] **Step 3: Implement shared launch/attachment**

  Represent launch with a cached Effect/shared Fiber or `Deferred<Exit<...>>`; never a boolean plus
  polling. Waiter interruption must not cancel owner launch or cleanup. Supervisor state is allocated
  inside its scoped Effect execution.

- [ ] **Step 4: Verify and commit**

  Run `handles.integration.test.ts`, stack type-check, update progress, and commit:

  ```bash
  git add packages/stack docs/superpowers/plans/2026-08-28-stack-runtime-rewrite-progress.md
  git commit -m "feat(stack): add supervisor ownership and managed handles"
  ```

### Task 6: Reconciler, status snapshots, and retained/live logs

**Files:**

- Create: `packages/stack/src/supervisor/Reconciler.ts`, `DesiredState.ts`, `StatusHub.ts`, `LogStore.ts`
- Create: `packages/stack/src/runtime/RuntimeDriver.ts`
- Create: `packages/stack/src/supervisor/reconciler.integration.test.ts`, `observability.integration.test.ts`
- Create: `packages/stack/src/supervisor/Reconciler.unit.test.ts` for deterministic graph planning

**Interfaces:**

- `RuntimeDriver` observes, starts, stops, and removes exact private workloads.
- `Reconciler` compiles a deterministic plan from durable generation + observed snapshot.
- `status`/`watchStatus` publish complete projections; logs have bounded storage, opaque cursors,
  exact known-secret redaction, and atomic retained-to-live handoff.

- [ ] **Step 1: Write failure-isolation and concurrency scenarios**

  Cover dependency ordering, reverse stop, independent branch survival, blocked dependents, readiness
  deadlines, bounded restart budgets, caller cancellation, generation fences, one reconciliation at a
  time, first watch snapshot, no duplicate/gap log handoff, and capability-only public attribution.

- [ ] **Step 2: Implement with Effect coordination primitives**

  Use one `Semaphore` for lifecycle serialization, `SubscriptionRef` for current snapshot and change
  stream, `PubSub` for live logs, `Deferred` for activation/readiness handoff, and `Schedule` for retry.
  Do not recreate waiter arrays, boolean gates, or sleep-based propagation.

- [ ] **Step 3: Verify and commit**

  Run the two integration files and the focused pure planner test, then commit:

  ```bash
  git add packages/stack docs/superpowers/plans/2026-08-28-stack-runtime-rewrite-progress.md
  git commit -m "feat(stack): reconcile workloads and publish observability"
  ```

### Task 7: Artifact preparation, native execution, and database bootstrap

**Files:**

- Create: `packages/stack/src/preparation/ArtifactStore.ts`, `Integrity.ts`
- Create: `packages/stack/src/runtime/NativeRuntime.ts`, `NativeProcess.ts`
- Create: `packages/stack/src/model/DatabaseBootstrap.ts`
- Create: `packages/stack/src/preparation/artifacts.integration.test.ts`
- Create: `packages/stack/src/runtime/native-runtime.integration.test.ts`

**Interfaces:**

- `prepare` verifies and atomically publishes selected native/container artifacts without state,
  ports, network, secrets, or workload mutation.
- `NativeRuntime` implements `RuntimeDriver` with exact process-tree ownership. Database bootstrap is
  a post-probe readiness phase on the real database workload, not a synthetic workload. Task 7 defines
  the release-plan resolver and PostgreSQL runner; Task 13 supplies each supported release's concrete
  ordered revision catalog. Applied revisions live inside PostgreSQL only and gate every database
  dependent on completion. Gateway listener ownership and native transfer belong to Task 8, where the
  gateway contract is implemented; Task 7 does not add a speculative listener interface.

- [x] **Step 1: Write preparation/native behavior tests and verify RED**

  Cover cached/downloaded outcomes, integrity failure cleanup, Supervisor-local single-flight,
  concurrent Supervisor duplicate safety, cancellation, process readiness/failure, exact process-tree
  termination, parent-loss termination, and bootstrap-before-dependent readiness.

- [x] **Step 2: Implement leaf foreign boundaries**

  Wrap foreign Promise/callback APIs once with cancellation signals and typed errors. Publish downloads
  by atomic rename. Run native subprocesses through Effect Platform; attach output to `LogStore` and
  termination to Scope.

- [x] **Step 3: Verify and commit**

  Run the two targeted files and stack type-check, then commit:

  ```bash
  git add packages/stack docs/superpowers/plans/2026-08-28-stack-runtime-rewrite-progress.md
  git commit -m "feat(stack): prepare artifacts and run native workloads"
  ```

### Task 8: Gateway and mandatory lazy activation

**Files:**

- Create: `packages/stack/src/gateway/Gateway.ts`, `HttpGateway.ts`, `TcpGateway.ts`
- Create: `packages/stack/src/gateway/gateway.integration.test.ts`
- Delete after production composition replaces the provisional split path:
  `packages/stack/src/gateway/ActivationServer.ts`, `ActivationFile.ts`,
  `packages/stack/src/gateway/activation.integration.test.ts`

**Interfaces:**

- Gateway is the only public ingress and routes HTTP/WebSocket and transparent TCP listeners.
- The Supervisor-owned in-process gateway calls Supervisor activation directly in both runtime
  modes. Container workloads expose only loopback-bound private backend ports to it.

- [x] **Step 1: Write observable protocol scenarios and verify RED**

  Cover HTTP routes/CORS/forwarding/WebSocket, PostgreSQL/TLS/SMTP/POP3/STARTTLS byte transparency,
  backpressure/half-close, 503 activation failure, 502 backend failure, dormant health probes,
  dependency-closure activation, generation/session fences, concurrent activation joining, and no
  idle eviction.

- [x] **Step 2: Implement ingress and activation**

  Use stream/socket platform APIs with scoped cancellation. Keep the gateway in the Supervisor so
  both runtime modes share the same direct activation path. Do not introduce a gateway artifact,
  activation server, capability file, or second control protocol.

- [x] **Step 3: Verify and commit**

  Run both gateway integration files and stack type-check, then commit:

  ```bash
  git add packages/stack docs/superpowers/plans/2026-08-28-stack-runtime-rewrite-progress.md
  git commit -m "feat(stack): add gateway and lazy activation"
  ```

### Task 9: Live Functions through the managed Edge Runtime

**Files:**

- Create: `packages/stack/src/functions/FunctionsRoot.ts`, `FunctionDiscovery.ts`
- Modify: `packages/stack/src/model/capabilities/functions.ts`, gateway routing, native runtime
- Create: `packages/stack/src/functions/functions.integration.test.ts`

**Interfaces:**

- Produces request-time slug discovery under one `functionsRoot` with closed persisted overrides.
- Native and container execution use the stack Edge Runtime; no separate functions-serving workflow.

- [x] **Step 1: Write safe live-edit scenarios and verify RED**

  Cover create/edit/delete visible on next request, shared modules, import maps/static files, disabled
  override not-found behavior, and rejection of traversal, absolute paths, and symlink escapes.

- [x] **Step 2: Implement safe resolution**

  Canonicalize and realpath every resolved entry/import/static/symlink target before opening it; prove
  membership beneath `functionsRoot`. Container mode mounts only the whole root read-only at one stable
  path. Do not add a watcher or desired-state mutation for code edits.

- [x] **Step 3: Verify and commit**

  Run `functions.integration.test.ts` in native fixtures, stack type-check, and commit:

  ```bash
  git add packages/stack docs/superpowers/plans/2026-08-28-stack-runtime-rewrite-progress.md
  git commit -m "feat(stack): serve live functions through edge runtime"
  ```

### Task 10: Strict container runtime and engine adapters

**Files:**

- Create: `packages/stack/src/runtime/ContainerEngine.ts`, `DockerEngine.ts`, `PodmanEngine.ts`,
  `ContainerRuntime.ts`
- Modify: gateway backend routing and Supervisor composition
- Create: `packages/stack/src/runtime/container-runtime.integration.test.ts`

**Interfaces:**

- Docker and Podman adapters create exact identity/generation-labeled private networks, workloads,
  persistent volumes, loopback-only private backend publications, read-only config files, and exact
  cleanup.
- No native process is started for a container identity and no container is created for native.

- [x] **Step 1: Write controlled engine integration scenarios and verify RED**

  Cover platform alias selection (`host.docker.internal`, Linux host-gateway,
  `host.containers.internal`), unsupported routing preflight, no public workload publication,
  loopback-only private backend endpoints, engine bind races, semantic-hash adoption, stale removal,
  persistent volumes, strict runtime split, and lazy Functions edits through the mounted root.

- [x] **Step 2: Implement the smallest engine contract**

  Model only inspect/pull/create/start/stop/remove/network/volume operations actually used by the
  execution plan. Parse exact structured engine output and map failures at the leaf boundary. Do not
  build a general container SDK.

- [x] **Step 3: Verify and commit**

  Run `container-runtime.integration.test.ts` against controlled Docker and Podman adapters, stack
  type-check, and commit:

  ```bash
  git add packages/stack docs/superpowers/plans/2026-08-28-stack-runtime-rewrite-progress.md
  git commit -m "feat(stack): run strict container stacks"
  ```

### Task 11: Start/stop/restart/destroy and crash recovery

**Files:**

- Modify: public Effect stack, Supervisor, Reconciler, owner/control, state, both runtime drivers
- Create: `packages/stack/src/supervisor/lifecycle.integration.test.ts`
- Create: `packages/stack/src/supervisor/recovery.integration.test.ts`

**Interfaces:**

- `start` applies config only at unconfigured/stopped boundaries and returns current status for an
  identical running input. Changed running input fails and suggests explicit restart.
- `restart` preflights, quiesces through stable maintenance, may apply allowed stopped-time changes,
  and loses to concurrent stop. Destroy removes exact data; stop retains state/data/logs/artifacts.

- [x] **Step 1: Write the complete lifecycle matrix and verify RED**

  Cover identical/changed fingerprints, pass-through-only changes, version rules, initialized database
  immutability, concurrent calls, stop winning restart, owner replacement failure, reboot no-autostart,
  native owner loss, container fail-closed, exact adoption fences, corrupt state, and explicit exact
  destructive cleanup.

- [x] **Step 2: Implement durable transitions**

  Commit validated complete intent before reconciliation. Use stable maintenance only for stop/quiesce;
  protocol mismatch is an upgrade signal. Keep replacement interruptible outside the narrow
  acquisition-to-registration mask and preserve unrecognized Causes.

- [x] **Step 3: Verify and commit**

  Run both targeted lifecycle files and stack type-check, then commit:

  ```bash
  git add packages/stack docs/superpowers/plans/2026-08-28-stack-runtime-rewrite-progress.md
  git commit -m "feat(stack): complete managed lifecycle and recovery"
  ```

### Task 12: Promise facade, test resource, and CLI migration

**Files:**

- Create: `packages/stack/src/public/PromiseStack.ts`, `packages/stack/src/public/Testing.ts`
- Modify: root/effect/testing exports and Node/Bun platform entrypoints
- Modify: all `apps/cli` imports/callers of the deleted stack API, start/stop/status/functions commands,
  CLI bootstrap, telemetry adapters, and relevant integration helpers/tests
- Create: `packages/stack/src/public/promise.integration.test.ts`
- Create: `packages/stack/src/public/testing.integration.test.ts`

**Interfaces:**

- Root Promise facade exposes create/open/find/list/inspect with plain-string secrets and
  AsyncIterable status/log streams. Handles have explicit `close()` and no async-dispose symbol.
- `createTestStack` is an `AsyncDisposable` wrapper that creates, starts, waits, and destroys only its
  unique temporary identity.
- CLI translates `CliConfig` to `StackConfig`; `supabase functions serve` starts/opens the managed
  stack Functions capability and streams its logs through Edge Runtime.

- [x] **Step 1: Write facade ownership tests and CLI handler integration tests first**

  Cover plain-string credentials/config, `Option` to `undefined`, stream cancellation, explicit handle
  close survival, test-wrapper disposal cleanup/startup failure cleanup, CLI start/restart guidance,
  complete status rendering, stop/destroy, and managed Functions serving/live edits.

- [x] **Step 2: Implement mechanical adapters**

  Give each Promise handle one private Scope closed by `close()`. Unwrap `Redacted` only at the outer
  boundary and preserve tagged errors. Implement the test wrapper as the sole `AsyncDisposable`.

- [x] **Step 3: Migrate CLI consumers to the new API**

  Update call sites directly; do not recreate `daemonLayer`, `foregroundLayer`, managed manager,
  launch metadata, old port/version helpers, or compatibility subpaths. Move configuration translation
  into the CLI and use new descriptors/status projections.

- [x] **Step 4: Verify and commit**

  Run both stack facade integration files plus only changed CLI handler integration files, then stack
  and CLI type-checks. Commit:

  ```bash
  git add packages/stack apps/cli docs/superpowers/plans/2026-08-28-stack-runtime-rewrite-progress.md
  git commit -m "feat(stack): expose facades and migrate the CLI"
  ```

### Task 13: Complete catalog and platform coverage

**Files:**

- Modify: every capability Module and catalog mapping
- Create: only the integration fixtures needed to exercise missing native/container mappings

**Interfaces:**

- Completes all ten capabilities with exhaustive settings and real native/container artifacts.
- Does not add new public lifecycle concepts or a second Functions-serving path.

- [ ] **Step 1: Audit capability and platform coverage**

  Build the requirement-to-source/test table in the tracked progress document. For every capability,
  identify exhaustive settings coverage, exact native and container artifacts, dependency edges,
  ports, secrets, routes, probes, and activation behavior.

- [ ] **Step 2: Fill only demonstrated gaps test-first**

  Exercise at least one native and one container preparation/execution mapping per capability. Keep
  Functions exclusively on the managed Edge Runtime and reject unsupported exact artifacts before
  durable or runtime mutation.

- [ ] **Step 3: Verify and commit**

  Run only the affected catalog/compiler/runtime integration files and stack type-check. Commit:

  ```bash
  git add packages/stack docs/superpowers/plans/2026-08-28-stack-runtime-rewrite-progress.md
  git commit -m "feat(stack): complete the workload catalog"
  ```

Database reset is deliberately not an implementation task in this plan. It will be designed from
observed caller needs in a separate session after this rewrite is complete.

### Final documentation and completion audit

**Files:**

- Modify: package README and architecture docs, tracked progress, public export metadata, and CLI
  docs/help affected by the new lifecycle
- Create: a small set of stack/CLI e2e smoke files only where real compiled subprocess/container
  boundaries are not covered by integration tests

**Interfaces:**

- Confirms all ten capabilities, limits public exports to `.`,
  `./effect`, and `./testing`, and leaves no process-compose or legacy stack surface.

- [ ] **Step 1: Audit every spec requirement against authoritative evidence**

  Build a requirement-to-test/source table in the tracked progress document. Missing or indirect
  evidence is incomplete work, not a pass.

- [ ] **Step 2: Fill audit gaps test-first**

  Treat any missing catalog/platform evidence as incomplete Task 13 work. Add the smallest compiled
  CLI smoke for start/status/stop and managed Functions serving.

- [ ] **Step 3: Run final targeted verification**

  ```bash
  pnpm --dir packages/stack types:check
  pnpm --dir packages/stack exec vitest run --project unit
  pnpm --dir packages/stack exec vitest run --project integration
  pnpm --dir apps/cli types:check
  pnpm exec oxlint --config .oxlintrc.json packages/stack apps/cli/src/next apps/cli/src/shared/telemetry
  pnpm exec oxlint --config .oxlintrc.effect.json packages/stack
  pnpm exec oxfmt --config .oxfmtrc.json --check packages/stack \
    docs/superpowers/specs/2026-08-28-stack-runtime-rewrite-design.md \
    docs/superpowers/plans/2026-08-28-stack-runtime-rewrite.md \
    docs/superpowers/plans/2026-08-28-stack-runtime-rewrite-progress.md
  pnpm exec knip-bun --workspace packages/stack
  ```

  Run only the named new e2e smoke files, not an unrelated e2e suite.

- [ ] **Step 4: Whole-branch review and one fix wave**

  Review the full merge-base diff against the design and progress rulings. Fix every load-bearing
  finding, re-run affected targeted checks, and record any adjudicated non-blocking ruling.

- [ ] **Step 5: Commit, push, and open the PR against develop**

  ```bash
  git add -A
  git commit -m "docs(stack): finalize the managed runtime rewrite"
  git push -u origin feat/stack-runtime-rewrite
  gh pr create --base develop --title "feat(stack): rewrite the managed stack runtime" \
    --body $'## Summary\n\nReplaces the legacy stack and process-compose implementations with the managed Effect v4 stack runtime described in the tracked architecture.'
  ```

  The PR description explains what and why, includes no test-plan section, and links/supersedes an
  issue or PR only when authoritative repository evidence identifies one.
