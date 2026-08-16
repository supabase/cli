# `@supabase/stack` Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the managed stack control plane with deterministic environment identity, one detached supervisor, control-endpoint lifecycle ownership, and an internal per-stack JSON store while retaining the approved runtime and port behavior.

**Architecture:** The existing stack runtime stays intact. New internal store, identity, lock, and control modules are introduced test-first, then the managed manager and daemon composition switch to them in one direction; the SQLite repository, operation protocol, recovery state machine, duplicate daemon, and fixture DSL are deleted after the replacement path owns every caller.

**Tech Stack:** TypeScript, Effect v4, `@effect/platform-node`, `@effect/platform-bun`, Vitest/`@effect/vitest`, Node/Bun IPC and loopback HTTP/SSE, pnpm/Nx.

**Spec:** `docs/superpowers/specs/2026-08-16-stack-simplification-design.md`

## Global Constraints

- Preserve the ten port invariants in the spec verbatim, including exact-first planning, sticky automatic ownership, stopped exact coexistence, running drift, removed-key conversion, and disabled-service intent retention.
- Direct `createStack()` remains ephemeral and never reads or writes managed state.
- Keep `ServiceCatalog`, `StackBuilder`, `StackPreparation`, `LocalStack`, `ApiProxy`, `Stack`, `RemoteStack`, and `@supabase/process-compose` ownership intact unless a compile-only call-site adjustment is required.
- All new runtime code is Effect-native. Promise conversion is allowed only at public Promise facades and process entrypoints.
- Production code may not use TypeScript `as` casts to silence typing errors.
- Every behavior change follows red-green-refactor; tests use real temporary files, Git worktrees, and sockets and assert observable results.
- No migration or compatibility layer for the unreleased SQLite registry.
- No secrets in managed JSON documents, control addresses, logs, or rendered decode errors.
- Managed files live below `<stateRoot>/stacks/<stackId>/`; control endpoints use deterministic
  loopback addresses and never expose a user-facing service port.
- The store is internal. Do not export a repository interface or add a second persistence adapter.
- Use `pnpm` scripts and discover Nx targets before cross-project checks.
- Do not run unrelated e2e suites; run only the targeted stack e2e files named by this plan.

---

### Task 1: Internal stack document store

**Files:**
- Create: `packages/stack/src/managed/document.ts`
- Create: `packages/stack/src/managed/store.ts`
- Create: `packages/stack/src/managed-store.integration.test.ts`
- Modify: `packages/stack/src/managed/paths.ts`

**Interfaces:**
- Produces: `ManagedStackDocument`, `ManagedStackListing`, `StackStore`, and `makeStackStore(stateRoot)`.
- Consumes: `ManagedPortAssignment`, existing managed path safety checks, and Effect `FileSystem`, `Path`, and `Schema`.
- Later tasks rely on `StackStore.read`, `StackStore.list`, `StackStore.write`, and `StackStore.remove` being internal Effect interfaces with no public entrypoint export.

- [ ] **Step 1: Write the failing file-store integration scenarios**

  Add tests using a real temporary state root. The production mutations each test would catch are: a non-atomic or wrong-path write and one corrupt document poisoning the registry.

  ```typescript
  it.live("persists and replaces one complete stack document atomically", () =>
    Effect.gen(function* () {
      const store = yield* makeTempStackStore();
      yield* store.write(document({ lifecycle: "starting" }));
      yield* store.write(document({ lifecycle: "running" }));
      expect(yield* store.read(STACK_ID)).toMatchObject({ lifecycle: "running" });
    }),
  );

  it.live("lists a corrupt stack beside healthy stacks", () =>
    Effect.gen(function* () {
      const store = yield* makeTempStackStore();
      yield* store.write(document({ id: HEALTHY_ID }));
      yield* writeRawStackDocument(store.stateRoot, CORRUPT_ID, "not-json");
      expect(yield* store.list()).toEqual([
        expect.objectContaining({ id: CORRUPT_ID, status: "corrupt" }),
        expect.objectContaining({ id: HEALTHY_ID, status: "healthy" }),
      ]);
    }),
  );

  ```

- [ ] **Step 2: Run the new integration file and verify RED**

  Run: `pnpm exec vitest run --project integration src/managed-store.integration.test.ts`

  Expected: FAIL because `document.ts` and `store.ts` do not exist.

- [ ] **Step 3: Implement the schema and atomic file store**

  Define the exact document fields from the spec with `format: "supabase-stack"` and
  `formatVersion: 1`. Implement secret-free encode/decode, deterministic stack paths, sibling
  temporary-file write plus rename, lock-free reads, sorted listing, per-document corrupt results,
  and recursive removal constrained to the validated UUID/hash-derived stack root.

  `StackStore.write` must replace the whole document; partial field writers are forbidden.

- [ ] **Step 4: Run focused tests and package checks**

  Run:

  ```bash
  pnpm exec vitest run --project integration src/managed-store.integration.test.ts
  pnpm types:check
  pnpm lint:check
  pnpm fmt:check
  ```

  Expected: all commands exit 0.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/stack/src/managed/document.ts packages/stack/src/managed/store.ts packages/stack/src/managed-store.integration.test.ts packages/stack/src/managed/paths.ts
  git commit -m "refactor(stack): add internal managed file store"
  ```

### Task 2: Deterministic environment identity and explicit repair classification

**Files:**
- Create: `packages/stack/src/managed/environment.ts`
- Create: `packages/stack/src/managed-environment.integration.test.ts`
- Modify: `packages/stack/src/managed/identity.ts`
- Modify: `packages/stack/src/managed/git.ts`
- Modify: `packages/stack/src/managed/paths.ts`
- Leave settlement/observation modules in place until Task 6 if the legacy service still needs them
  to compile; Task 2 must not recreate or extend those state machines.

**Interfaces:**
- Produces: `EnvironmentIdentity`, `WorkspaceDiscovery`, `RepairRequest`, `deriveStackId(identity, name)`, `discoverEnvironment(path)`, `ensureEnvironment(path)`, and `validateEnvironmentRepair(request)`.
- Consumes: `StackStore` from Task 1, current Git config and marker primitives, and real Git workspace metadata.
- `deriveStackId` hashes four length-prefixed UTF-8 values with SHA-256 and returns 64 lowercase hexadecimal characters.

- [ ] **Step 1: Write failing real-workspace scenarios**

  Use the existing Git workspace helper but assert only user-relevant identity behavior:

  ```typescript
  it.live("returns to the same stack after leaving and revisiting a branch", () =>
    withGitWorkspace((workspace) =>
      Effect.gen(function* () {
        const main = yield* ensureEnvironment(workspace.primary);
        yield* workspace.checkoutNewBranch("feature");
        const feature = yield* ensureEnvironment(workspace.primary);
        yield* workspace.checkout("main");
        const mainAgain = yield* discoverEnvironment(workspace.primary);
        expect(deriveStackId(main.identity, "default")).toBe(
          deriveStackId(mainAgain.identity, "default"),
        );
        expect(feature.identity.contextId).not.toBe(main.identity.contextId);
      }),
    ),
  );

  it.live("isolates the same branch in two worktrees by checkout identity", () =>
    withGitWorkspace((workspace) =>
      Effect.gen(function* () {
        const sibling = yield* workspace.addWorktree("sibling", "main", { force: true });
        const first = yield* ensureEnvironment(workspace.primary);
        const second = yield* ensureEnvironment(sibling);
        expect(first.identity.contextId).toBe(second.identity.contextId);
        expect(first.identity.checkoutId).not.toBe(second.identity.checkoutId);
        expect(deriveStackId(first.identity, "default")).not.toBe(
          deriveStackId(second.identity, "default"),
        );
      }),
    ),
  );

  it.live("requires explicit repair when a checkout identity appears at a new path", () =>
    withMovedGitWorkspace((workspace) =>
      Effect.gen(function* () {
        const report = yield* discoverEnvironment(workspace.movedPath);
        expect(report.state).toBe("needsRepair");
        expect(report.reason).toBe("moved");
        const repair = yield* validateEnvironmentRepair(report.repair);
        expect(repair).toEqual(report.repair);
        expect((yield* discoverEnvironment(workspace.movedPath)).state).toBe("needsRepair");
      }),
    ),
  );
  ```

- [ ] **Step 2: Run the new identity integration file and verify RED**

  Run: `pnpm exec vitest run --project integration src/managed-environment.integration.test.ts`

  Expected: FAIL because `managed/environment.ts` and deterministic derivation do not exist.

- [ ] **Step 3: Implement deterministic identity and three-state discovery**

  Reuse the low-level atomic marker and Git storage operations, but implement only `healthy`,
  `unregistered`, and `needsRepair`. New branch/worktree registration is the normal `ensureEnvironment`
  path. Moved and duplicated checkout evidence returns a typed repair request and performs no
  mutation during discovery. Do not retain adoptable/orphaned states from the registry design.

- [ ] **Step 4: Validate explicit repair without applying it**

  Validation must prove the request still matches current discovery and preserve project, checkout,
  and context IDs, but it performs no marker or stack-document write. Task 4 acquires a deterministic
  environment-repair control endpoint, refuses repair while any affected stack owner is live, then
  applies the marker and document updates. Duplicate evidence remains a refusal until an explicit
  ownership decision exists; do not add that decision to this task.

- [ ] **Step 5: Retire settlement-only imports where the new identity path replaces them**

  Remove any now-unused imports from the new identity path. If the legacy managed service still
  imports `workspace-settlement*` or `discovery-observation*`, leave those modules unchanged until
  Task 6 deletes the legacy service and its state machines in one compile-safe step.

- [ ] **Step 6: Run focused tests and package checks**

  ```bash
  pnpm exec vitest run --project integration src/managed-environment.integration.test.ts
  pnpm types:check
  pnpm lint:check
  pnpm fmt:check
  ```

  Expected: all commands exit 0.

- [ ] **Step 7: Commit**

  ```bash
  git add packages/stack/src/managed packages/stack/src/managed-environment.integration.test.ts
  git commit -m "refactor(stack): simplify managed environment identity"
  ```

### Task 3: Control endpoint as lifecycle ownership and reattachment seam

**Files:**
- Create: `packages/stack/src/managed/control.ts`
- Create: `packages/stack/src/managed-control.integration.test.ts`
- Modify: `packages/stack/src/DaemonProtocol.ts`
- Modify: `packages/stack/src/DaemonServer.ts`
- Modify: `packages/stack/src/RemoteStack.ts`
- Modify: `packages/stack/src/platform-node.ts`
- Modify: `packages/stack/src/platform-bun.ts`

**Interfaces:**
- Produces: `ControlEndpoint`, `ControlOwnership`, `controlEndpointPath(runtimeRoot, stackId)`, `acquireControl(input)`, and protocol owner states `starting | running | stopping | deleting | failed` with `protocolVersion: 1`.
- Consumes: existing validated daemon HTTP/SSE transport and a deterministic loopback address
  derived from the stack ID.
- Only `ControlOwnership` holders may call later stack-document mutation and allocation functions.

- [ ] **Step 1: Write failing socket ownership scenarios**

  Tests use real loopback listeners on every platform:

  ```typescript
  it.live("attaches a concurrent caller to the live owner", () =>
    withControlOwner((owner) =>
      Effect.gen(function* () {
        const contender = yield* acquireControl(owner.input);
        expect(contender._tag).toBe("Attached");
        expect(yield* contender.ownerStatus).toMatchObject({ protocolVersion: 1 });
      }),
    ),
  );

  it.live("binds after a killed owner releases the address", () =>
    withKilledControlOwner((input) =>
      Effect.gen(function* () {
        const next = yield* acquireControl(input);
        expect(next._tag).toBe("Owned");
      }),
    ),
  );

  it.live("waits for graceful close instead of unlinking a live generation", () =>
    withClosingControlOwner((input) =>
      Effect.gen(function* () {
        const next = yield* acquireControl(input);
        expect(next._tag).toBe("Owned");
        expect(next.acquiredAfterClose).toBe(true);
      }),
    ),
  );
  ```

- [ ] **Step 2: Run the control integration file and verify RED**

  Run: `pnpm exec vitest run --project integration src/managed-control.integration.test.ts`

  Expected: FAIL because `managed/control.ts` and owner-status protocol do not exist.

- [ ] **Step 3: Implement deterministic endpoint paths and scoped acquisition**

  Bind `127.0.0.1` before any managed mutation, using port
  `49152 + (twoDigestBytes % 16384)`. On `EADDRINUSE`, connect and decode owner status. A listener that
  does not speak the expected protocol yields a typed address-conflict error; never unlink or kill
  it. Normal close waits for Node/Bun server shutdown before rebinding. Node and Bun use the exact
  same host, port derivation, and endpoint metadata.

- [ ] **Step 4: Extend the management transport**

  Add versioned owner/readiness status to the same bound `HttpServer` that serves the existing Stack
  lifecycle routes; do not create a sidecar owner listener. A protocol mismatch returns a typed error
  with the expected and observed versions. `RemoteStack` continues to map that one validated
  transport to the existing `Stack` interface.

- [ ] **Step 5: Run focused transport tests and checks**

  ```bash
  pnpm exec vitest run --project integration src/managed-control.integration.test.ts src/DaemonServer.integration.test.ts src/RemoteStack.integration.test.ts src/UnixSocketSse.integration.test.ts
  pnpm types:check
  pnpm lint:check
  pnpm fmt:check
  ```

  Expected: all commands exit 0.

- [ ] **Step 6: Commit**

  ```bash
  git add packages/stack/src/managed/control.ts packages/stack/src/managed-control.integration.test.ts packages/stack/src/DaemonProtocol.ts packages/stack/src/DaemonServer.ts packages/stack/src/RemoteStack.ts packages/stack/src/platform-node.ts packages/stack/src/platform-bun.ts
  git commit -m "refactor(stack): use control endpoints for ownership"
  ```

### Task 4: Simplified managed manager and port transaction

**Files:**
- Create: `packages/stack/src/managed/manager.ts`
- Create: `packages/stack/src/managed-manager.integration.test.ts`
- Modify: `packages/stack/src/managed/port-plan.ts`
- Modify: `packages/stack/src/managed/port-intent.ts`
- Modify: `packages/stack/src/managed/repository.ts` (reduce to pure conflict functions, then rename if clearer)
- Modify: `packages/stack/src/managed/model.ts`
- Modify: `packages/stack/src/managed.ts`
- Modify: `packages/stack/src/managed/create-service.ts`

**Interfaces:**
- Produces: internal `ManagedStackManager`, `managedStackManagerLayer({ stateRoot })`, minimal Promise facade, `allocateManagedPorts(ownership, request)`, and lean listing/repair/delete results.
- Consumes: `StackStore`, deterministic environment identity, `ControlOwnership`, existing port intent/planning, and `reservePortSet`.
- Removes from the public interface: repository access/injection, owner PID, publication timing, liveness callbacks, initialization callbacks, runtime-inspection callbacks, operation reconciliation, transition abandonment, prune, and individual adopt/rebind methods.

- [ ] **Step 1: Write the lean real-world manager scenarios first**

  The test file contains only the following scenario groups, parameterized where the same observable
  behavior needs both Promise and Effect coverage:

  ```typescript
  describe("managed stack journeys", () => {
    it.live("restarts the same environment with the same automatic ports", scenarioRestartSticky);
    it.live("runs sibling worktrees with independent automatic ports", scenarioSiblingWorktrees);
    it.live("allows stopped exact siblings and rejects a live owner", scenarioExactOwnership);
    it.live("keeps automatic ports exclusive while stopped", scenarioAutomaticOwnership);
    it.live("reports running drift and applies it after stop", scenarioRunningDrift);
    it.live("preserves removed-key and disabled-service intent", scenarioRetiredIntent);
    it.live("repairs a moved workspace without changing stack id or ports", scenarioRepair);
    it.live("lists corrupt and healthy stacks together", scenarioCorruptListing);
  });
  ```

  Setup returns `{ layer, stateRoot, runtime, workspace }`; assertions target returned projections,
  persisted documents, and bound ports. Do not assert repository calls or internal ordering.

- [ ] **Step 2: Run the manager integration file and verify RED**

  Run: `pnpm exec vitest run --project integration src/managed-manager.integration.test.ts`

  Expected: FAIL because `managed/manager.ts` and the lean interface do not exist.

- [ ] **Step 3: Implement the manager over the real store**

  Compose discovery, resolution, listing, repair, and deletion without exposing storage. Require
  `ControlOwnership` for stack mutations. `repairWorkspace` first acquires an environment-repair
  control endpoint, validates the plan, then updates the checkout marker and affected stopped stack
  documents. Deletion writes `deleting`, derives cleanup identity from
  stack ID, removes data, and removes `stack.json` last. A left-behind `deleting` document is
  completed by the next owner.

- [ ] **Step 4: Move port allocation into the owner process**

  Scan healthy stack documents, run the unchanged pure conflict matrix, plan exact fields first,
  then reserve every automatic field and every active exact field before atomically writing the
  accepted assignment. If a concurrent allocator wins a reservation, release the partial set,
  reread the documents, and replan with a bounded Effect `Schedule`. Return the scoped lease directly
  to the caller in the same Effect scope. Delete candidate-policy injection and synthetic
  allocation-request recovery. No lease handoff or acquisition-release mode remains.

- [ ] **Step 5: Shrink the public Effect and Promise interfaces**

  Export the manager and platform layer/facade but not `StackStore` or any repository. Keep method
  failure unions specific. Replace individual recovery methods with `repairWorkspace`.

- [ ] **Step 6: Run focused scenarios and checks**

  ```bash
  pnpm exec vitest run --project integration src/managed-manager.integration.test.ts src/managed-effect.integration.test.ts
  pnpm types:check
  pnpm lint:check
  pnpm fmt:check
  ```

  Expected: all commands exit 0.

- [ ] **Step 7: Commit**

  ```bash
  git add packages/stack/src/managed packages/stack/src/managed.ts packages/stack/src/managed-manager.integration.test.ts packages/stack/src/managed-effect.integration.test.ts
  git commit -m "refactor(stack): deepen the managed stack manager"
  ```

### Task 5: One Effect-native detached supervisor

**Files:**
- Create: `packages/stack/src/supervisor.ts`
- Create: `packages/stack/src/supervisor.integration.test.ts`
- Modify: `packages/stack/src/daemon-bun.ts`
- Modify: `packages/stack/src/daemon-node.ts`
- Modify: `packages/stack/src/layers.ts`
- Modify: `packages/stack/src/effect.ts`
- Modify: `packages/stack/src/effect-bun.ts`
- Modify: `packages/stack/src/effect-node.ts`
- Modify: `packages/stack/src/managed-bun.ts`
- Modify: `packages/stack/src/managed-node.ts`
- Modify: `packages/stack/src/PortAllocator.ts`
- Delete: `packages/stack/src/daemon.ts`
- Delete: `packages/stack/src/managed-daemon.ts`
- Delete: `packages/stack/src/managed-daemon-bun.ts`
- Delete: `packages/stack/src/managed-daemon-node.ts`
- Delete: `packages/stack/src/managed-daemon-test-bun.ts`

**Interfaces:**
- Produces: one `runSupervisor(platform)` Effect program and one serializable start protocol carrying managed identity/paths, stack config, and port intents.
- Consumes: `ManagedStackManager`, `ControlOwnership`, foreground stack layers, `DaemonServer`, and existing fork/self-dispatch platform hooks.
- `managedDaemonLayer` and ordinary `daemonLayer` both spawn this program; managed/unmanaged changes input policy, not entrypoint topology.

- [ ] **Step 1: Write failing supervisor lifecycle scenarios**

  ```typescript
  describe("detached supervisor journeys", () => {
    it.live("keeps every reservation until its service binds", reservationsSurviveStartup);
    it.live("attaches the loser of a concurrent managed start", concurrentStartAttaches);
    it.live("recovers after the owner is killed during start", killedStartRecovers);
    it.live("completes deletion after the owner is killed during delete", killedDeleteRecovers);
    it.live("reattaches from a later manager process and stops", laterProcessReattaches);
  });
  ```

  Use an explicit test mode in the start input; never derive behavior from socket-path substrings.
  Spawn real child processes and real control sockets, but substitute only external service startup.

- [ ] **Step 2: Run the supervisor integration file and verify RED**

  Run: `pnpm exec vitest run --project integration src/supervisor.integration.test.ts`

  Expected: FAIL because the unified supervisor does not exist.

- [ ] **Step 3: Implement the Effect-native supervisor**

  Model IPC receipt, control binding, manager acquisition, port reservation, foreground layer
  construction, readiness publication, signal interruption, and shutdown as one scoped Effect.
  `Effect.runPromise` appears only in the thin runtime entrypoint. Do not use bare `await` on an
  Effect, `Promise.race` for lifecycle, duplicate signal waiters, or `.catch(() => {})` finalizers.

- [ ] **Step 4: Remove port lease handoff**

  Delete `PortLease.handoff`, `releaseAcquisition`, and handoff state. The supervisor scope owns the
  reservation map until services release individual fields or the scope closes.

- [ ] **Step 5: Point every detached layer at the supervisor and delete daemon variants**

  Preserve compiled Bun self-dispatch with one environment marker. Node and Bun files provide only
  platform layers and call the shared program. Keep `RemoteStack` as the reattachment adapter.

- [ ] **Step 6: Run focused daemon and supervisor tests**

  ```bash
  pnpm exec vitest run --project integration src/supervisor.integration.test.ts src/DaemonServer.integration.test.ts src/RemoteStack.integration.test.ts
  pnpm exec vitest run --project unit src/entrypoints.unit.test.ts src/PortAllocator.unit.test.ts
  pnpm types:check
  pnpm lint:check
  pnpm fmt:check
  ```

  Expected: all commands exit 0.

- [ ] **Step 7: Commit**

  ```bash
  git add packages/stack/src packages/stack/package.json
  git commit -m "refactor(stack): unify detached supervision"
  ```

### Task 6: Delete the managed state machine and replace the oversized test suite

**Files:**
- Delete: `packages/stack/src/managed/sqlite.ts`
- Delete: `packages/stack/src/managed/sqlite-bun.ts`
- Delete: `packages/stack/src/managed/sqlite-node.ts`
- Delete: `packages/stack/src/managed/repository-memory.ts`
- Delete or reduce to pure rules: `packages/stack/src/managed/repository.ts`
- Delete: `packages/stack/src/managed/service.ts`
- Delete: `packages/stack/src/managed/stack-lifecycle.ts`
- Delete obsolete claim/recovery models from: `packages/stack/src/managed/model.ts`
- Delete: `packages/stack/src/managed-stack-contract.ts`
- Delete: `packages/stack/src/managed-stack-contract-validation.ts`
- Delete: `packages/stack/src/managed-stack-contract.integration.test.ts`
- Delete: `packages/stack/src/managed-stack-contract-worktrees.integration.test.ts`
- Delete: `packages/stack/src/managed-service.integration.test.ts`
- Delete: `packages/stack/src/managed-discovery.integration.test.ts`
- Delete: `packages/stack/src/managed-resolve-stack.integration.test.ts`
- Delete: `packages/stack/src/managed-port-coordinator.integration.test.ts`
- Delete: `packages/stack/src/managed-daemon.integration.test.ts`
- Modify: `packages/stack/src/testing.ts`
- Modify: `packages/stack/src/entrypoints.unit.test.ts`
- Modify: `packages/stack/package.json`

**Interfaces:**
- Consumes: the passing replacement manager, environment, store, control, and supervisor scenarios from Tasks 1-5.
- Produces: a lean package with no SQLite dependency, no public repository/testing adapter, and no duplicate fixture language.

- [ ] **Step 1: Inventory scenario coverage before deletion**

  Map every spec-required integration journey to an existing replacement test name. Add a missing
  failing scenario to `managed-manager.integration.test.ts` or `supervisor.integration.test.ts`, run
  it RED, and implement the missing behavior before deleting its old coverage. Do not translate tests
  whose only failure mode is an internal call, record shape, ordering choice, exact error string, or
  fixture count.

- [ ] **Step 2: Delete persistence adapters and operation/recovery state**

  Remove SQLite, memory repository, claims, owner records, operation tokens, pending publication,
  polling options, tombstones, reconciliation, settlement, and their error codes. Retain only pure
  port conflict rules that the new manager consumes.

- [ ] **Step 3: Delete the fixture DSL and obsolete integration matrices**

  Remove contract data, validator, conformance drivers, adapter matrices, state-machine branch
  tests, and test-only public exports. Keep only direct journey tests listed in the spec and focused
  pure-rule tests.

- [ ] **Step 4: Make entrypoints and dependencies match the reduced interface**

  Remove `bun:sqlite` / `node:sqlite` reachability and old daemon entries. Update exports without
  snapshotting an exhaustive list of export keys; type-check real consumer imports instead.

- [ ] **Step 5: Run the entire unit and integration suite**

  Run: `pnpm test:core`

  Expected: exit 0 with only the lean replacement scenarios and retained runtime tests.

- [ ] **Step 6: Run package quality checks**

  Run: `pnpm check:all`

  Expected: exit 0, including knip proving removed modules/exports are gone.

- [ ] **Step 7: Record the size reduction and commit**

  Run:

  ```bash
  find src -type f -name '*.ts' -print0 | xargs -0 wc -l | tail -1
  ```

  Record baseline and result in the implementation report, not a production assertion test.

  ```bash
  git add packages/stack
  git commit -m "refactor(stack): remove managed coordination machinery"
  ```

### Task 7: Update CLI consumers, documentation, ADRs, and targeted e2e coverage

**Files:**
- Modify: `apps/cli/src/shared/telemetry/error-actionability.ts`
- Modify: `apps/cli/src/shared/telemetry/error-actionability-coverage.unit.test.ts`
- Modify callers found by `rg '@supabase/stack/(managed|managed-model)' apps/cli`
- Modify: `packages/stack/README.md`
- Modify: `packages/stack/docs/architecture.md`
- Modify: `packages/stack/docs/detach-mode.md`
- Modify: `docs/adr/0015-managed-stack-contract-fixtures.md`
- Create: `docs/adr/0017-simplified-managed-stack-ownership.md`
- Modify or create targeted e2e files under `packages/stack/tests/` for detached lifecycle and parallel worktrees only.

**Interfaces:**
- Consumes: final managed error codes and public interfaces from Tasks 4-6.
- Produces: compiling CLI consumers, current architecture documentation, superseded ADR-0015, a replacement ADR, and no more than three targeted stack e2e journeys.

- [ ] **Step 1: Write or update targeted consumer tests first**

  Update telemetry exhaustiveness to the reduced managed error union. Add only these subprocess
  journeys when not already protected by an equivalent retained e2e test:

  ```typescript
  test("detached stack can be started, reattached, inspected, and stopped", detachedLifecycle);
  test("sibling worktrees run independent managed stacks", parallelWorktrees);
  test("selected runtime starts one real stack", runtimeSmoke);
  ```

  Run the changed consumer/unit file and targeted e2e file before implementation and verify the
  expected compile or assertion failure caused by removed interfaces.

- [ ] **Step 2: Update CLI consumers to the reduced model**

  Remove classifications for deleted claim/reconciliation errors and add actionable guidance for
  ownership, corrupt document, protocol mismatch, port conflict, and repair-required failures.

- [ ] **Step 3: Replace architecture documentation**

  Rewrite the managed sections to describe deterministic identity, file documents, OS-owned control
  ownership, reservation-fenced allocation, one supervisor, reattachment, and lean tests. Remove historical descriptions of
  SQLite transactions, memory adapters, operation claims, polling, tombstones, and fixture authority.

- [ ] **Step 4: Supersede ADR-0015 and add the replacement decision**

  Mark ADR-0015 `superseded` and link ADR-0017. ADR-0017 records why real integration journeys,
  internal files, and OS lifecycle ownership replace repository conformance and declarative fixtures.

- [ ] **Step 5: Run targeted e2e tests only**

  Discover the exact Nx target first:

  ```bash
  nx show project @supabase/stack --json
  ```

  Then run only the detached lifecycle, parallel worktree, and selected runtime smoke files. Expected:
  all targeted files pass.

- [ ] **Step 6: Run fresh final verification**

  ```bash
  cd packages/stack && pnpm test:core && pnpm check:all
  cd ../../apps/cli && pnpm test:core && pnpm check:all
  ```

  If `apps/cli` exposes different scripts, use its `package.json` as the source of truth and run its
  unit/integration plus `types:check`, `lint:check`, and `fmt:check` targets through Nx.

- [ ] **Step 7: Commit**

  ```bash
  git add apps/cli packages/stack docs/adr
  git commit -m "docs(stack): record simplified managed architecture"
  ```

## Plan self-review

- Spec coverage: Tasks 1-7 cover store, lock, identity, ownership, supervisor, ports, public interface,
  deletion, lean tests, CLI consumers, documentation, and ADR replacement.
- Type consistency: `stackId` is a 64-character lowercase SHA-256 string throughout; document and
  control protocol versions are both exactly `1`; only `ControlOwnership` permits mutation.
- Test consistency: every new production module first appears in a named failing integration test;
  pure unit coverage is limited to deterministic derivation, port rules, and decoding failures.
- Scope: runtime catalog/topology remains untouched; no unrelated CLI command redesign is included.
- Placeholder scan: the plan contains no deferred implementation steps; platform behavior not
  executable on macOS is covered by production path derivation plus CI/runtime-specific tests.
