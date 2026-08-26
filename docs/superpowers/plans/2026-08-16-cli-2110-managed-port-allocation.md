# CLI-2110 Managed Port Allocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Honor exact config ports and allocate unique, sticky omitted config ports while keeping
keyless runtime ports relocatable and the unmanaged stack runtime independent from managed state.

**Architecture:** A typed catalog describes every host port and separates durable config-addressable
assignments from runtime-only keyless fields. A managed coordinator runs in the runtime process,
binds a complete selected-field lease, atomically claims durable assignments through the managed
repository, and hands concrete ports plus the lease to runtime initialization. Direct `createStack()`
and the ordinary daemon retain their independent ephemeral allocator.

**Tech Stack:** TypeScript, Effect V4, Node TCP listeners, Bun/Node SQLite adapters, Vitest, pnpm/Nx.

**Spec:** `docs/superpowers/specs/2026-08-16-managed-port-allocation-design.md`

## Global Constraints

- Base is PR #6216 commit `3c2fbf106824b9990c5196c43491417ac82390aa` on branch
  `juliengoux/cli-2110-state-honor-explicit-config-ports-and-allocate-sticky-ports`.
- `packages/stack` and managed state are unpublished. Replace internal APIs and the fresh-create
  schema directly; do not add migrations, compatibility readers, or optional bypasses.
- Presence in the effective pre-default document is the only exact/automatic signal. Never infer
  intent from a decoded default and never add an `auto` sentinel or CLI override.
- Stopped exact assignments may coexist. Sticky automatic assignments are exclusive across all
  non-tombstoned stacks, and exact assignments may not take a sticky automatic number.
- Keyless internal ports are selected by managed orchestration but are runtime-only and relocatable.
- Managed allocation executes in the process that owns runtime leases, including the detached child.
- Direct `createStack()` and the ordinary daemon never read or receive managed reservations.
- Do not wire `apps/cli` commands or choose a Docker/native runtime here; CLI-2114 and CLI-2124 own
  those policies. This issue exposes and verifies the managed package path they will consume.
- New tests must run with Vitest's default file parallelism: no fixed ports, shared Git/config/state
  roots, process-wide cwd or environment mutation, sleeps, global listeners, or sequential files.
- Use pnpm commands. Run unit and integration suites, not the full e2e target.
- Production code remains Effect-native with typed failures and no TypeScript casts used to silence
  type errors.

## File and Responsibility Map

- `packages/config/src/lib/env.ts` — report paths whose winning values came from environment
  interpolation.
- `packages/config/src/io.ts` — retain effective path-level value origins across remote merge and
  interpolation.
- `packages/stack/src/PortCatalog.ts` — exhaustive port-field metadata and config-key/persistence
  classification.
- `packages/stack/src/PortAllocator.ts` — low-level selected-field socket binding and independent
  unmanaged selection policy.
- `packages/stack/src/managed/port-intent.ts` — pure effective-document intent resolution and drift.
- `packages/stack/src/managed/port-plan.ts` — pure sticky/exact/runtime-only candidate planning.
- `packages/stack/src/managed/port-coordinator.ts` — scoped bind, repository claim, retry, and typed
  conflict orchestration.
- `packages/stack/src/managed/repository.ts` — intent-sensitive ownership contract and atomic start
  claim.
- `packages/stack/src/managed/{repository-memory,sqlite}.ts` — equivalent transactional adapters.
- `packages/stack/src/managed/{stack-lifecycle,service,create-service}.ts` — managed start, drift,
  failure settlement, and public Effect/Promise surfaces.
- `packages/stack/src/{daemon,layers}.ts` — reusable runtime boot primitive and unchanged ordinary
  daemon composition.
- `packages/stack/src/managed-daemon.ts` plus platform entrypoints — child-owned managed start and
  leases.

---

### Task 1: Preserve Effective Config Value Origins

**Files:**

- Modify: `packages/config/src/lib/env.ts`
- Modify: `packages/config/src/io.ts`
- Modify: `packages/config/src/index.ts`
- Test: `packages/config/src/io.unit.test.ts`

**Interfaces:**

- Produces `CliConfigValueSource`, `CliConfigValueOrigin`, and
  `LoadedCliConfig.valueOrigins`.
- Environment wins over remote as the immediate value source for a remote-provided `env(NAME)`.

- [ ] **Step 1: Write failing loader tests**

Add scenarios using the existing temporary config and injected `projectEnv` helpers:

```ts
expect(originAt(loaded, ["api", "port"])).toBe("local");
expect(originAt(envLoaded, ["api", "port"])).toBe("environment");
expect(originAt(remoteLoaded, ["db", "port"])).toBe("remote");
expect(originAt(remoteEnvLoaded, ["db", "port"])).toBe("environment");
expect(originAt(omittedLoaded, ["studio", "port"])).toBeUndefined();
```

The remote-env fixture selects a remote whose `db.port` is `env(REMOTE_DB_PORT)` and injects the
number through `projectEnv`; it proves provenance is captured during resolution rather than rebuilt
from the final number.

- [ ] **Step 2: Run the focused test and confirm RED**

Run from the repository root:

```bash
pnpm --filter @supabase/config exec vitest run src/io.unit.test.ts
```

Expected: assertions fail because `valueOrigins` and `originAt` do not exist.

- [ ] **Step 3: Add generic origin types and lookup**

Add to `io.ts` and export from `index.ts`:

```ts
export type CliConfigValueSource = "environment" | "local" | "remote";

export interface CliConfigValueOrigin {
  readonly path: ReadonlyArray<string>;
  readonly source: CliConfigValueSource;
}

export const cliConfigValueSourceAt = (
  loaded: Pick<LoadedCliConfig, "valueOrigins">,
  path: ReadonlyArray<string>,
): CliConfigValueSource | undefined =>
  loaded.valueOrigins?.find(
    (origin) =>
      origin.path.length === path.length &&
      origin.path.every((segment, index) => segment === path[index]),
  )?.source;
```

Extend `LoadedCliConfig` with:

```ts
readonly valueOrigins?: ReadonlyArray<CliConfigValueOrigin>;
```

- [ ] **Step 4: Capture winning remote and environment paths**

Extend the env interpolation options with an observer:

```ts
readonly onResolvedEnv?: (path: ReadonlyArray<string>) => void;
```

Have `applyRemoteOverride` return the leaf paths contributed by the selected remote. Run the
validation-only interpolation without the observer; collect environment paths only during the
post-merge interpolation of the effective document. Build origins for final effective leaves in
this precedence order:

1. local parsed leaf;
2. selected remote leaf replaces local origin with `remote`;
3. successful env substitution replaces either origin with `environment`.

Only retain origins whose paths still exist in `normalizedForDecode`.

- [ ] **Step 5: Run GREEN and workspace checks**

```bash
pnpm --filter @supabase/config exec vitest run src/io.unit.test.ts
pnpm --filter @supabase/config check:all
pnpm --filter @supabase/config test:unit
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/config/src/lib/env.ts packages/config/src/io.ts packages/config/src/index.ts packages/config/src/io.unit.test.ts
git commit -m "feat(config): retain effective value origins"
```

---

### Task 2: Add the Exhaustive Port Catalog and Selected-Field Binder

**Files:**

- Create: `packages/stack/src/PortCatalog.ts`
- Modify: `packages/stack/src/PortAllocator.ts`
- Modify: `packages/stack/src/ServiceCatalog.ts`
- Modify: `packages/stack/src/ServicePorts.ts`
- Modify: `packages/stack/src/StackConfig.ts`
- Modify: `packages/stack/src/StackConfigResolver.ts`
- Modify: `packages/stack/src/StackMetadata.ts`
- Modify: `packages/stack/src/StateManager.ts`
- Modify: `packages/stack/src/createStack.ts`
- Modify: `packages/stack/src/daemon.ts`
- Modify: `packages/stack/src/effect.ts`
- Test: `packages/stack/src/PortAllocator.unit.test.ts`
- Create: `packages/stack/src/PortAllocator.integration.test.ts`
- Test: `packages/stack/src/Stack.unit.test.ts`
- Test: `packages/stack/src/StackBuilder.unit.test.ts`
- Test: `packages/stack/src/StateManager.integration.test.ts`
- Test: `packages/stack/src/StateManager.unit.test.ts`
- Create: `packages/stack/src/createStack.integration.test.ts`
- Test: `packages/stack/src/createStack.unit.test.ts`

**Interfaces:**

- Produces `PORT_CATALOG`, `PortField`, `ConfigPortKey`, `AllocatedPorts`, `ResolvedPorts`, their
  schemas, `stickyPortFields`, and `runtimeOnlyPortFields`.
- Produces `allocatePortSet(requests, options): Effect<ResolvedPorts, PortAllocationError>` and
  `reservePortSet(requests, options): Effect<PortLease, PortAllocationError>`.
- Produces `portFieldsForConfigInput(config): ReadonlyArray<PortField>` as the single pre-resolution
  service-activation classifier.
- Changes resolved/runtime port collections to `ResolvedPorts`, a typed partial set containing only
  active fields.
- Keeps direct `createStack()` on an independent ephemeral selection policy.

- [ ] **Step 1: Write failing consumed-surface tests**

Move the existing real-socket lease cases from `PortAllocator.unit.test.ts` into
`PortAllocator.integration.test.ts`, leaving only the injected pure candidate-selection algorithm in
the unit file. Add a selected-binding scenario that requests two dynamically chosen fields,
verifies both are held, verifies an unrequested field was never allocated, releases one field,
re-reserves it through the lease, releases the scope, and verifies both numbers can be rebound.

Extend `StateManager.integration.test.ts` and the new `createStack.integration.test.ts` to verify
that disabled-service fields are absent from resolved and persisted state rather than populated with
unused numbers. The pure intent cases in Task 3 and managed service scenarios in Task 6 exercise
every config-key mapping; do not add a separate unit test that merely restates the catalog.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
pnpm --filter @supabase/stack exec vitest run src/PortAllocator.unit.test.ts
pnpm --filter @supabase/stack exec vitest run --project integration src/PortAllocator.integration.test.ts src/StateManager.integration.test.ts src/createStack.integration.test.ts
```

- [ ] **Step 3: Create the complete catalog**

Define entries for all fields. Config-addressable entries use `persistence: "sticky"`; keyless
entries use `persistence: "runtime"`.

```ts
export interface PortCatalogEntry {
  readonly field: PortField;
  readonly configKey?: ConfigPortKey;
  readonly preferred?: number;
  readonly service?: ServiceName;
  readonly persistence: "runtime" | "sticky";
}
```

Represent the catalog as an object satisfying an exhaustive mapped type keyed by `PortField`, then
derive `PORT_FIELDS` and filtered sticky/runtime lists from that object. Missing and duplicate
fields are therefore compile errors rather than test assertions.

The field classification is:

```ts
apiPort                    -> api.port                         sticky
dbPort                     -> db.port                          sticky, postgres
authPort                   -> keyless                          runtime, auth
postgrestPort              -> keyless                          runtime, postgrest
postgrestAdminPort         -> keyless                          runtime, postgrest
edgeRuntimePort            -> keyless                          runtime, edge-runtime
edgeRuntimeInspectorPort   -> edge_runtime.inspector_port      sticky, edge-runtime
realtimePort               -> keyless                          runtime, realtime
storagePort                -> keyless                          runtime, storage
imgproxyPort               -> keyless                          runtime, imgproxy
mailpitPort                -> local_smtp.port                  sticky, mailpit
mailpitSmtpPort            -> local_smtp.smtp_port             sticky, mailpit
mailpitPop3Port            -> local_smtp.pop3_port             sticky, mailpit
pgmetaPort                 -> keyless                          runtime, pgmeta
studioPort                 -> studio.port                      sticky, studio
analyticsPort              -> analytics.port                   sticky, analytics
poolerPort                 -> db.pooler.port                   sticky, pooler
poolerApiPort              -> keyless                          runtime, pooler
```

Move `AllocatedPorts`, `ResolvedPorts`, their schemas, `PortField`, `PORT_FIELDS`, and conventional
preferred values out of `PortAllocator.ts` so `ServiceCatalog.ts`, state encoding, and the allocator
all depend on `PortCatalog.ts` without a runtime cycle.

- [ ] **Step 4: Implement the low-level selected-field lease**

```ts
export type PortSelection =
  | { readonly kind: "exact"; readonly port: number }
  | { readonly kind: "automatic"; readonly preferred?: number };

export interface PortReservationRequest {
  readonly field: PortField;
  readonly selection: PortSelection;
}

export interface PortLease {
  readonly ports: ResolvedPorts;
  readonly reserve: (fields: ReadonlyArray<PortField>) => Effect.Effect<void, PortAllocationError>;
  readonly release: (fields: ReadonlyArray<PortField>) => Effect.Effect<void>;
  readonly releaseAll: Effect.Effect<void>;
}
```

`reservePortSet` binds only its unique request fields, excludes the supplied reserved numbers and
numbers acquired earlier in the same set, and releases the partial set on failure or interruption.
`allocatePortSet` shares candidate selection but closes its probes before returning. Define
`ResolvedPorts` as `Readonly<Partial<AllocatedPorts>>` with a matching partial schema. `reserve`
rejects a field absent from `ports`; lazy services only request fields present in their resolved
service configuration. Delete the obsolete all-field `allocatePorts`, `reservePorts`, and
`reserveAllocatedPorts` entrypoints and update the package exports directly.

Refactor `resolveConfig` and `resolveDaemonConfig` to derive active fields through
`portFieldsForConfigInput` before selection, build direct exact/preferred/random requests only for
those fields, and use `requiredPort(ports, field)` while constructing an enabled service config.
Update runtime-state encoding to persist only the active resolved set.

- [ ] **Step 5: Preserve direct unmanaged behavior**

Keep `createStack()` and ordinary `runDaemon()` calling the direct ephemeral selection policy;
neither accepts managed reservations. Add a lazy-start `createStack()` integration scenario using
mock platform and child-process layers; construct and dispose the handle with no
`ManagedStackRepository` or managed state root in the environment. Update imports and
`allocatedPortFieldsForConfig` to consume the catalog while preserving exact inputs and automatic
fallback behavior for active fields.

- [ ] **Step 6: Run GREEN and commit**

```bash
pnpm --filter @supabase/stack exec vitest run src/PortAllocator.unit.test.ts
pnpm --filter @supabase/stack exec vitest run --project integration src/PortAllocator.integration.test.ts src/StateManager.integration.test.ts src/createStack.integration.test.ts
pnpm --filter @supabase/stack check:all
git add packages/stack/src/PortCatalog.ts packages/stack/src/PortAllocator.ts packages/stack/src/ServiceCatalog.ts packages/stack/src/ServicePorts.ts packages/stack/src/StackConfig.ts packages/stack/src/StackConfigResolver.ts packages/stack/src/StackMetadata.ts packages/stack/src/StateManager.ts packages/stack/src/createStack.ts packages/stack/src/daemon.ts packages/stack/src/effect.ts packages/stack/src/PortAllocator.unit.test.ts packages/stack/src/PortAllocator.integration.test.ts packages/stack/src/Stack.unit.test.ts packages/stack/src/StackBuilder.unit.test.ts packages/stack/src/StateManager.integration.test.ts packages/stack/src/StateManager.unit.test.ts packages/stack/src/createStack.integration.test.ts packages/stack/src/createStack.unit.test.ts
git commit -m "refactor(stack): add selected-field port leases"
```

---

### Task 3: Resolve Port Intent and Plan Sticky Versus Runtime Assignments

**Files:**

- Modify: `packages/stack/src/managed/model.ts`
- Create: `packages/stack/src/managed/port-intent.ts`
- Create: `packages/stack/src/managed/port-plan.ts`
- Test: `packages/stack/src/managed/port-intent.unit.test.ts`
- Test: `packages/stack/src/managed/port-plan.unit.test.ts`

**Interfaces:**

- Produces `ManagedPortIntentDocument`, `ManagedPortRequest`, `ManagedPortDrift`,
  `resolvePortIntents`, and `planManagedPorts`.

- [ ] **Step 1: Write failing pure tests**

Cover explicit template defaults, omitted automatic keys, environment and remote sources, inactive
services, preservation of disabled persisted rows, exact-key removal, and keyless runtime fields.

```ts
expect(resolvePortIntents(document)).toContainEqual({
  field: "apiPort",
  key: "api.port",
  intent: "exact",
  port: 54321,
  source: "local",
});
expect(resolvePortIntents(document)).toContainEqual({
  field: "dbPort",
  key: "db.port",
  intent: "automatic",
  source: "omitted",
});
```

The planner test verifies:

- persisted automatic values remain pinned;
- persisted exact changed to omitted keeps its number and changes intent to automatic;
- inactive config-addressable rows are preserved without a socket request;
- keyless active fields produce runtime-only automatic requests; and
- exact requests never receive a fallback candidate.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
pnpm --filter @supabase/stack exec vitest run src/managed/port-intent.unit.test.ts src/managed/port-plan.unit.test.ts
```

- [ ] **Step 3: Add discriminated managed types**

```ts
export type ManagedPortSource = "environment" | "local" | "omitted" | "remote";

export interface ManagedPortIntentDocument {
  readonly activeFields: ReadonlyArray<PortField>;
  readonly document?: Readonly<Record<string, unknown>>;
  readonly valueOrigins?: ReadonlyArray<{
    readonly path: ReadonlyArray<string>;
    readonly source: Exclude<ManagedPortSource, "omitted">;
  }>;
}

export type ManagedPortRequest =
  | {
      readonly field: PortField;
      readonly key: ConfigPortKey;
      readonly intent: "exact";
      readonly port: number;
      readonly source: Exclude<ManagedPortSource, "omitted">;
    }
  | {
      readonly field: PortField;
      readonly key: ConfigPortKey;
      readonly intent: "automatic";
      readonly source: "omitted";
    };
```

`ManagedPortDrift` includes actual and configured intent plus optional numbers, so removing an exact
key while keeping the same number is visible:

```ts
export interface ManagedPortDrift {
  readonly key: ConfigPortKey;
  readonly actualIntent: ManagedPortIntent;
  readonly actualPort: number;
  readonly configuredIntent: ManagedPortIntent;
  readonly configuredPort?: number;
}
```

- [ ] **Step 4: Implement resolution and planning**

`resolvePortIntents` walks only active sticky catalog entries. A numeric effective leaf is exact;
absence is automatic. `planManagedPorts` returns:

```ts
export interface ManagedDurablePortPlanEntry {
  readonly field: PortField;
  readonly key: ConfigPortKey;
  readonly intent: ManagedPortIntent;
  readonly selection: PortSelection;
  readonly newlyAllocatedAutomatic: boolean;
}

export interface ManagedPortPlan {
  readonly durable: ReadonlyArray<ManagedDurablePortPlanEntry>;
  readonly runtimeOnly: ReadonlyArray<PortReservationRequest>;
  readonly inactiveAssignments: ReadonlyArray<ManagedPortAssignment>;
}
```

An existing automatic entry uses `selection: { kind: "exact", port: persisted.port }` and
`newlyAllocatedAutomatic: false`; a new automatic entry uses `selection: { kind: "automatic",
preferred }` and `newlyAllocatedAutomatic: true`. Merge `inactiveAssignments` back into the
repository claim, but do not request sockets for them. Narrow `ManagedPortAssignment.key` from
`string` to `ConfigPortKey` in the same task.

- [ ] **Step 5: Run GREEN and commit**

```bash
pnpm --filter @supabase/stack exec vitest run src/managed/port-intent.unit.test.ts src/managed/port-plan.unit.test.ts
pnpm --filter @supabase/stack check:all
git add packages/stack/src/managed/model.ts packages/stack/src/managed/port-intent.ts packages/stack/src/managed/port-plan.ts packages/stack/src/managed/port-intent.unit.test.ts packages/stack/src/managed/port-plan.unit.test.ts
git commit -m "feat(stack): resolve managed port intent"
```

---

### Task 4: Enforce the Intent-Sensitive Repository Ownership Matrix

**Files:**

- Modify: `packages/stack/src/managed/repository.ts`
- Modify: `packages/stack/src/managed/repository-memory.ts`
- Modify: `packages/stack/src/managed/sqlite.ts`
- Test: `packages/stack/src/managed-service.integration.test.ts`

**Interfaces:**

- Produces `ManagedPortReservation`, `listPortReservations`, and atomic `claimStartPorts`.
- Replaces lifecycle-only collision checks with the approved intent/lifecycle matrix.

- [ ] **Step 1: Add shared adapter conformance scenarios**

Run each scenario against memory and SQLite through existing public repository/service setup:

1. stopped exact A and stopped exact B retain the same port;
2. starting exact B conflicts with running exact A;
3. stopped automatic A blocks exact B;
4. stopped automatic A blocks another automatic direct claim;
5. reservation reads include stopped exact A so the coordinator can allocate automatic B elsewhere;
6. tombstoning A removes it from durable reservation reads;
7. changing exact to automatic fails atomically when another stopped exact row shares the number;
8. failed automatic A retains exclusivity, while failed exact rows may coexist.

For every rejected write, re-read both stacks and assert neither durable assignment changed.

- [ ] **Step 2: Run the focused integration file and confirm RED**

```bash
pnpm --filter @supabase/stack exec vitest run --project integration src/managed-service.integration.test.ts
```

- [ ] **Step 3: Add reservation and claim contracts**

```ts
export interface ManagedPortReservation {
  readonly stackId: string;
  readonly stackName: string;
  readonly lifecycle: ManagedStackLifecycle;
  readonly assignment: ManagedPortAssignment;
}

export interface ClaimManagedStartPortsInput {
  readonly stackId: string;
  readonly operationToken: string;
  readonly ports: ReadonlyArray<ManagedPortAssignment>;
  readonly now: string;
}
```

Add repository methods:

```ts
readonly listPortReservations: () => Effect.Effect<ReadonlyArray<ManagedPortReservation>>;
readonly claimStartPorts: (
  input: ClaimManagedStartPortsInput,
) => Effect.Effect<ManagedStackRecord, ClaimManagedStartPortsFailure>;
```

`claimStartPorts` is authorized by the active operation, accepts pending/stopped/failed stacks, sets
lifecycle to `starting`, and replaces the durable assignments in the same transaction.

- [ ] **Step 4: Implement the matrix once and mirror it in both adapters**

The shared policy is:

```ts
const conflicts = (
  incomingStackId: string,
  incoming: ManagedPortAssignment,
  owner: ManagedPortReservation,
): boolean =>
  incomingStackId !== owner.stackId &&
  incoming.port === owner.assignment.port &&
  (incoming.intent === "automatic" ||
    owner.assignment.intent === "automatic" ||
    managedStackOccupiesPorts(owner.lifecycle));
```

SQLite evaluates this under `BEGIN IMMEDIATE`; memory evaluates it inside its atomic snapshot. The
target stack's previous rows never conflict with its own replacement set. Add an index on `(port,
intent)` but no blanket unique index on `port`. `listPortReservations` excludes tombstoned rows and
returns stopped/failed rows for automatic allocation avoidance.

- [ ] **Step 5: Run GREEN and commit**

```bash
pnpm --filter @supabase/stack exec vitest run --project integration src/managed-service.integration.test.ts
pnpm --filter @supabase/stack check:all
git add packages/stack/src/managed/repository.ts packages/stack/src/managed/repository-memory.ts packages/stack/src/managed/sqlite.ts packages/stack/src/managed-service.integration.test.ts
git commit -m "feat(stack): enforce managed port ownership matrix"
```

---

### Task 5: Build the Scoped Managed Port Coordinator

**Files:**

- Create: `packages/stack/src/managed/port-coordinator.ts`
- Modify: `packages/stack/src/managed/model.ts`
- Modify: `packages/stack/src/managed.ts`
- Test: `packages/stack/src/managed-port-coordinator.integration.test.ts`

**Interfaces:**

- Consumes the planner, selected-field binder, repository reservation read, and atomic claim.
- Produces one scoped concrete allocation and lease after durable ownership is accepted.

- [ ] **Step 1: Write public-coordinator integration scenarios**

Use isolated memory/SQLite roots, real loopback sockets, dynamically assigned numbers, and
test-local `Deferred` gates. Cover:

- exact success and external exact conflict;
- sticky reuse and external sticky conflict without relocation;
- new automatic conventional preference and fallback;
- keyless previous-number collision relocating successfully;
- exact conflict with a stopped sticky owner including owner attribution;
- automatic repository race releasing the complete candidate and retrying;
- exact repository race failing without retry;
- interruption after partial bind releasing every listener; and
- claim failure preserving the previous repository assignment.

- [ ] **Step 2: Run the integration test and confirm RED**

```bash
pnpm --filter @supabase/stack exec vitest run --project integration src/managed-port-coordinator.integration.test.ts
```

- [ ] **Step 3: Add typed failures**

Add tagged errors containing data rather than CLI-formatted recovery prose:

```ts
export class ManagedExactPortOccupiedError extends Data.TaggedError(
  "ManagedExactPortOccupiedError",
)<{
  readonly key: ConfigPortKey;
  readonly port: number;
  readonly ownerStackId?: string;
  readonly ownerStackName?: string;
}> {
  readonly code = "MANAGED_EXACT_PORT_OCCUPIED" as const;
}

export class ManagedStickyPortOccupiedError extends Data.TaggedError(
  "ManagedStickyPortOccupiedError",
)<{
  readonly key: ConfigPortKey;
  readonly port: number;
  readonly stackId: string;
  readonly ownerStackId?: string;
  readonly ownerStackName?: string;
}> {
  readonly code = "MANAGED_STICKY_PORT_OCCUPIED" as const;
}

export class ManagedPortClaimRaceError extends Data.TaggedError("ManagedPortClaimRaceError")<{
  readonly stackId: string;
  readonly port: number;
  readonly ownerStackId: string;
}> {
  readonly code = "MANAGED_PORT_CLAIM_RACE" as const;
}

export class ManagedPortAllocationError extends Data.TaggedError("ManagedPortAllocationError")<{
  readonly fields: ReadonlyArray<PortField>;
  readonly cause: unknown;
}> {
  readonly code = "MANAGED_PORT_ALLOCATION_FAILED" as const;
}
```

Register their codes in the existing exhaustive managed error maps.

- [ ] **Step 4: Implement the scoped service**

```ts
export interface ManagedPortStartAllocation {
  readonly stack: ManagedStackRecord;
  readonly durableAssignments: ReadonlyArray<ManagedPortAssignment>;
  readonly ports: ResolvedPorts;
  readonly lease: PortLease;
}

export interface ManagedPortCoordinatorShape {
  readonly acquireStart: (input: {
    readonly stack: ManagedStackRecord;
    readonly operationToken: string;
    readonly plan: ManagedPortPlan;
    readonly now: string;
  }) => Effect.Effect<ManagedPortStartAllocation, ManagedPortStartFailure, Scope.Scope>;
}
```

`acquireStart` reads all non-tombstoned reservations and first rejects known logical exact-versus-
sticky conflicts with managed owner attribution. It then binds the plan's active requests,
constructs durable assignments from bound sticky fields plus preserved inactive rows, and calls
`claimStartPorts`. A claim race retries only when every conflicting incoming field is a newly
allocated automatic field. The default retry policy is eight attempts; expose the candidate policy
and retry limit only through `ManagedPortCoordinator.make` options for deterministic tests.

The scoped finalizer always releases unconsumed listeners. Runtime initialization receives the
lease and releases fields as services bind.

- [ ] **Step 5: Run GREEN and commit**

```bash
pnpm --filter @supabase/stack exec vitest run --project integration src/managed-port-coordinator.integration.test.ts
pnpm --filter @supabase/stack check:all
git add packages/stack/src/managed/port-coordinator.ts packages/stack/src/managed/model.ts packages/stack/src/managed.ts packages/stack/src/managed-port-coordinator.integration.test.ts
git commit -m "feat(stack): coordinate managed port claims"
```

---

### Task 6: Integrate Managed Start, Drift, and Failure Settlement

**Files:**

- Modify: `packages/stack/src/managed/stack-lifecycle.ts`
- Modify: `packages/stack/src/managed/service.ts`
- Modify: `packages/stack/src/managed/create-service.ts`
- Modify: `packages/stack/src/managed/model.ts`
- Test: `packages/stack/src/managed-service.integration.test.ts`
- Test: `packages/stack/src/managed-effect.integration.test.ts`

**Interfaces:**

- `resolveStack` requires `portDocument` for both start and status; start additionally requires a
  runtime initializer.
- Runtime initialization receives the complete concrete allocation and scoped lease.
- Running resolution reports port drift without probing or writing.

- [ ] **Step 1: Convert existing transitional port tests to intent input**

Replace direct `configuration.ports` start calls with `portDocument`. Keep direct repository-write
tests for repository guards. Add scenarios consuming every existing `ports.*` contract fixture.

Add explicit assertions for:

- exact template values versus omitted defaults;
- environment and remote source propagation;
- stopped exact change and exact-key removal;
- intent-only running drift;
- sticky reuse across stop/start, branch return, and checkout move;
- sibling branch/worktree/named automatic independence;
- legacy-running preflight before identity, allocation, or filesystem writes; and
- initialization failure after an accepted claim retaining durable ports with lifecycle `failed`.

- [ ] **Step 2: Run focused integration tests and confirm RED**

```bash
pnpm --filter @supabase/stack exec vitest run --project integration src/managed-service.integration.test.ts src/managed-effect.integration.test.ts
```

- [ ] **Step 3: Make the start input explicit**

```ts
export interface ManagedRuntimePortAllocation {
  readonly ports: ResolvedPorts;
  readonly lease: PortLease;
}

export class ManagedRuntimeStartError extends Data.TaggedError("ManagedRuntimeStartError")<{
  readonly cause: unknown;
}> {
  readonly code = "MANAGED_RUNTIME_START_FAILED" as const;
}

export interface ResolveManagedStackStartRequest {
  readonly workspacePath: string;
  readonly operation: "start";
  readonly stackName?: string;
  readonly portDocument: ManagedPortIntentDocument;
  readonly legacyPortConflict?: {
    readonly key: ConfigPortKey;
    readonly port: number;
    readonly ownerId?: string;
  };
  readonly initialize: (
    stack: ManagedStackRecord,
    allocation: ManagedRuntimePortAllocation,
  ) => Effect.Effect<ManagedRuntimeMetadata, ManagedRuntimeStartError>;
}
```

Do not retain an optional `portDocument` compatibility path. Promise facade callbacks receive the
same allocation shape at the outer package edge. A supplied `legacyPortConflict` fails before
identity mutation or allocation and retains the config key and port required by CLI-2102 output.

- [ ] **Step 4: Refactor lifecycle sequencing**

For a new identity:

1. `prepareStack` publishes the pending stack and operation without port rows;
2. coordinator binds and `claimStartPorts` persists the accepted complete durable set;
3. initialize runtime with concrete ports and lease;
4. validate and publish lifecycle `running`;
5. on failure before claim, abort pending;
6. on failure after claim, publish an active `failed` stack retaining the accepted assignments.

For an existing stopped/failed stack, claim a start operation before allocation. Bind first, then
atomically replace assignments and enter `starting`. A bind or claim conflict preserves the prior
record. Runtime failure keeps the accepted assignment and settles lifecycle `failed`.

For a running stack, compute drift from persisted assignments and requested intents, including an
intent-only difference, and return without operation claim, socket probe, or write.

- [ ] **Step 5: Run GREEN and commit**

```bash
pnpm --filter @supabase/stack exec vitest run --project integration src/managed-service.integration.test.ts src/managed-effect.integration.test.ts
pnpm --filter @supabase/stack check:all
git add packages/stack/src/managed/stack-lifecycle.ts packages/stack/src/managed/service.ts packages/stack/src/managed/create-service.ts packages/stack/src/managed/model.ts packages/stack/src/managed-service.integration.test.ts packages/stack/src/managed-effect.integration.test.ts
git commit -m "feat(stack): start managed stacks with sticky ports"
```

---

### Task 7: Compose Managed Allocation Inside the Detached Daemon

**Files:**

- Modify: `packages/stack/src/daemon.ts`
- Modify: `packages/stack/src/layers.ts`
- Create: `packages/stack/src/managed-daemon.ts`
- Create: `packages/stack/src/managed-daemon-node.ts`
- Create: `packages/stack/src/managed-daemon-bun.ts`
- Modify: `packages/stack/src/managed-node.ts`
- Modify: `packages/stack/src/managed-bun.ts`
- Modify: `packages/stack/package.json`
- Test: `packages/stack/src/managed-daemon.integration.test.ts`
- Test: `packages/stack/src/createStack.integration.test.ts`

**Interfaces:**

- Produces a managed daemon message containing only serializable identity/config inputs.
- Keeps `DaemonStartMessage` and ordinary `daemonLayer` registry-free.
- Extracts one runtime boot primitive accepting already-resolved ports and a same-process lease.

- [ ] **Step 1: Write the subprocess and boundary regressions**

The subprocess scenario launches the managed daemon entrypoint with an isolated state root and
SQLite file. It verifies:

- the child PID owns the listeners while the parent remains unable to bind them;
- the repository contains the child's accepted durable assignments;
- startup acknowledgement arrives only after runtime initialization and publication;
- child startup failure releases listeners and records the specified failed/aborted state; and
- two managed daemon tests can execute concurrently without shared sockets or directories.

Use a test-only daemon entrypoint that injects a loopback runtime bootstrap, binds every concrete
port from the allocation, and releases each corresponding lease field. This exercises the real
fork/IPC/registry/socket boundary without Docker or downloaded service artifacts.

The direct regression from Task 2 remains green and proves no managed repository service or state
root is requested.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
pnpm --filter @supabase/stack exec vitest run --project integration src/managed-daemon.integration.test.ts
pnpm --filter @supabase/stack exec vitest run --project integration src/createStack.integration.test.ts
```

- [ ] **Step 3: Extract the runtime boot primitive**

Refactor the body shared after port resolution into:

```ts
interface RuntimeBootInput {
  readonly config: ResolvedStackConfig;
  readonly lease: PortLease;
  readonly socketPath: string;
}
```

The ordinary daemon still calls `resolveDaemonConfig` with `reservePortSet`, then calls the
primitive.
It never imports a managed module.

- [ ] **Step 4: Add the managed child composition**

The parent sends `workspacePath`, `stackName`, `stateRoot`, serializable stack configuration, the
effective config document plus value origins, and socket path. The child derives active fields with
`portFieldsForConfigInput`, constructs `ManagedPortIntentDocument`, opens the managed layer, resolves
identity, calls the managed start API, resolves runtime config using the allocation returned to its
initialize callback through an injected resolver that returns those ports without probing or
binding again, and boots services with the same lease. The child sends `started` only after managed
publication; all intent resolution, allocation, and registry work occurs inside the child.

Export managed daemon launchers only from `@supabase/stack/managed` platform entrypoints. Do not add
managed options to `daemonLayer` or `createStack`. The launcher executes the serialized runtime
configuration it is given; it does not select, persist, or reconcile a Docker/native runtime policy.

- [ ] **Step 5: Run GREEN and commit**

```bash
pnpm --filter @supabase/stack exec vitest run --project integration src/managed-daemon.integration.test.ts
pnpm --filter @supabase/stack exec vitest run --project integration src/createStack.integration.test.ts
pnpm --filter @supabase/stack check:all
git add packages/stack/src/daemon.ts packages/stack/src/layers.ts packages/stack/src/managed-daemon.ts packages/stack/src/managed-daemon-node.ts packages/stack/src/managed-daemon-bun.ts packages/stack/src/managed-node.ts packages/stack/src/managed-bun.ts packages/stack/package.json packages/stack/src/managed-daemon.integration.test.ts packages/stack/src/createStack.integration.test.ts
git commit -m "feat(stack): allocate managed ports inside daemon"
```

---

### Task 8: Pin the Branch Contract, Documentation, and Parallel Suite

**Files:**

- Modify: `packages/stack/src/managed-stack-contract.ts`
- Modify: `packages/stack/src/managed-stack-contract.integration.test.ts`
- Modify: `packages/stack/src/managed-service.integration.test.ts`
- Modify: `packages/stack/docs/architecture.md`
- Modify: `docs/adr/0015-managed-stack-contract-fixtures.md`

**Interfaces:** No new production interface. This task freezes the clarified product behavior and
verifies the complete workspaces.

- [ ] **Step 1: Add the shared-config branch fixture**

Add `ports.stopped-siblings-with-shared-exact-config-coexist`: two sibling identities inherit the
same explicit `api.port` and `db.port`; both stopped records coexist; starting the first succeeds;
starting the second while the first occupies those ports returns exact conflicts identifying the
first; stopping the first lets the second start without changing either assignment.

Update the pinned fixture inventory and ADR count in the same change.

- [ ] **Step 2: Add deterministic concurrency coverage**

Using test-local `Deferred` gates, verify concurrent sibling automatic starts publish disjoint
durable assignments and concurrent same-identity starts converge on one assignment set. Use unique
temporary state roots and SQLite files per test.

- [ ] **Step 3: Update architecture documentation**

Replace the current blanket lifecycle-lease description with the exact/automatic ownership matrix,
describe runtime-only keyless ports, place the coordinator inside managed runtime processes, and
state that ordinary `createStack()` and daemon execution are external unmanaged participants.

- [ ] **Step 4: Run formatting and focused contract checks**

```bash
pnpm --filter @supabase/stack exec vitest run --project integration src/managed-stack-contract.integration.test.ts
pnpm exec oxfmt packages/stack/docs/architecture.md docs/adr/0015-managed-stack-contract-fixtures.md
git diff --check
```

- [ ] **Step 5: Run all changed-workspace quality gates**

```bash
pnpm --filter @supabase/config check:all
pnpm --filter @supabase/config test:unit
pnpm --filter @supabase/stack check:all
pnpm --filter @supabase/stack test:unit && pnpm --filter @supabase/stack test:integration
```

Expected: every command passes; no e2e target runs.

- [ ] **Step 6: Prove full integration parallelism twice**

Run the unchanged default integration project twice, without `--no-file-parallelism`, worker caps,
or sequential configuration:

```bash
pnpm nx run @supabase/stack:test:integration
pnpm nx run @supabase/stack:test:integration --skip-nx-cache
```

Expected: both runs pass with Vitest file parallelism enabled and leave no listener, Git lock, or
temporary-state leakage.

- [ ] **Step 7: Commit the contract and documentation**

```bash
git add packages/stack/src/managed-stack-contract.ts packages/stack/src/managed-stack-contract.integration.test.ts packages/stack/src/managed-service.integration.test.ts packages/stack/docs/architecture.md docs/adr/0015-managed-stack-contract-fixtures.md
git commit -m "docs(stack): define managed port ownership contract"
```

## Plan Self-Review Checklist

- Every existing CLI-2110 port fixture is exercised through the managed public surface.
- The new shared explicit-config branch scenario prevents blanket stopped-stack uniqueness.
- Exact, sticky automatic, and runtime-only keyless fields have distinct conflict semantics.
- The detached child, not the parent, owns allocation, persistence, and runtime lease consumption.
- Direct unmanaged entrypoints receive neither a repository nor managed reservations.
- Disabled durable assignments survive without holding listeners.
- Intent-only running drift is observable and never mutates the running stack.
- Memory and SQLite adapters share the same matrix scenarios.
- Real-socket and concurrency tests use dynamic loopback leases and test-local synchronization.
- The complete integration project runs twice with default parallelism before completion.
