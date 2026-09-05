# `@supabase/stack` Simplification Design

**Status:** superseded — see [ADR-0017](../../adr/0017-simplified-managed-stack-architecture.md) for the current maintained design
**Date:** 2026-08-16
**Baseline:** PR #6218 at `bb502dfa7971d44f41a30d402fd08a54d7a2c6dd`

## Purpose

Simplify `@supabase/stack` around the five capabilities the package actually needs:

1. run several local Supabase stacks concurrently for worktree-based development;
2. run a stack detached from the CLI and reconnect to it later;
3. keep automatically selected ports sticky for the environment that first launched the stack;
4. run services through Docker or native binaries according to platform availability; and
5. remain a self-contained, programmatically usable package.

The current runtime core already provides most of this. The redesign removes the managed control
plane that grew around it: dual daemon paths, repository substitution, relational identity state,
operation claims, owner tokens, publication polling, tombstones, reconciliation, and a parallel
fixture language.

## Non-goals

- Do not redesign `ServiceCatalog`, `StackBuilder`, `StackPreparation`, `LocalStack`, `ApiProxy`, or
  the `@supabase/process-compose` orchestration model.
- Do not change exact-versus-automatic port intent or the approved port-conflict matrix.
- Do not make direct `createStack()` participate in the host-wide managed registry. It remains an
  isolated, foreground, ephemeral programmatic primitive.
- Do not add compatibility shims or migrations for the unreleased SQLite managed registry.
- Do not persist resolved Functions environment values, JWTs, API keys, or other secrets.

## Design principles

- One mechanism per invariant. A live control endpoint proves lifecycle ownership; there is no
  second operation row that tries to describe the same fact.
- One real adapter earns a seam. The file store is internal until a second production persistence
  adapter exists.
- The process that reserves ports is the process that launches services. Port reservations never
  cross a process, callback, or Promise seam.
- Rare, human-initiated workspace anomalies fail with precise repair guidance. Normal startup does
  not run a general recovery engine.
- Tests exercise public Effect or Promise interfaces with real temporary files and sockets. They do
  not validate a second declarative implementation of the behavior.

## Target module map

### Runtime core (kept)

`StackConfigResolver`, `StackPreparation`, `StackBuilder`, `LocalStack`, `ApiProxy`, and the
`Stack` / `RemoteStack` interfaces continue to own service configuration, artifact selection,
native-versus-Docker adapters, topology, lifecycle, projection, and transport.

### Managed identity

An environment is exactly:

```text
workspaceId + checkoutId + contextId + localProjectKey + stackName
```

- `workspaceId` is stored in common local Git config for Git workspaces. It is
  local repository/folder lineage and unrelated to a remote Supabase project.
- `checkoutId` is stored beneath the checkout-specific Git directory.
- Branch `contextId` is stored in branch-local Git config; branch rename therefore carries it.
- Detached contexts are checkout-scoped and stored beside the checkout marker.
- Ordinary folders keep their workspace, checkout, and context IDs in
  `.supabase/identity.json` using the existing atomic claim primitive.
- `localProjectKey` is the canonical Supabase project root relative to the
  canonical enclosing checkout root, normalized to `/` and `.` at checkout
  root; ordinary folders use `.`. It does not use `config.toml` or remote link state.
- `stackId` is the lowercase SHA-256 hex digest of the five length-delimited identity values. It is
  deterministic and requires no registration row or random-ID publication protocol.

The common path has three states:

- `healthy`: identity is complete and agrees with any matching stack document;
- `unregistered`: missing identity is atomically created for a mutating start;
- `needsRepair`: moved or duplicated checkout evidence requires an explicit repair operation.

Read-only discovery never writes. Task 2 only validates a repair plan. The manager later acquires a
deterministic environment-repair control endpoint before updating the checkout marker and every
affected stopped stack document. Repair preserves the identity IDs and therefore the stack ID and
sticky ports. There is no location-history state machine, transitioning state, adoptable/orphaned
state, monotonic settlement, automatic adoption, or automatic pruning on the start path.

### Internal per-stack store

```text
<stateRoot>/
  stacks/<stackId>/
    stack.json
    data/
    logs/
```

`stack.json` is an Effect Schema document with:

```typescript
interface StackDocument {
  readonly format: "supabase-stack";
  readonly formatVersion: 1;
  readonly id: string;
  readonly identity: {
    readonly workspaceId: string;
    readonly checkoutId: string;
    readonly contextId: string;
    readonly localProjectKey: string;
    readonly name: string;
  };
  readonly workspace: {
    readonly kind: "git" | "folder";
    readonly checkoutKind: "primary" | "worktree" | "bare" | "folder";
    /** Canonical Supabase project root, not the enclosing Git checkout root. */
    readonly path: string;
    readonly branch?: string;
  };
  readonly ports: ReadonlyArray<ManagedPortAssignment>;
  readonly lifecycle: "stopped" | "starting" | "running" | "deleting" | "failed";
  readonly runtime?: {
    readonly pid: number;
    readonly controlEndpoint: string;
    readonly protocolVersion: 1;
  };
  readonly launch?: {
    readonly mode: "native" | "auto" | "docker";
    readonly versions: Readonly<Record<string, string>>;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

The document contains no secrets. Docker containers and native runtime resources use `stackId` as
their deterministic name/label input so crash cleanup can be derived rather than stored as a large
cleanup plan.

All writes use a sibling temporary file, fsync where supported, and atomic rename. Reads are
lock-free. Corrupt or incompatible documents become per-stack `corrupt` listing entries rather than
making every stack unreadable.

Every mutation of a stack document requires ownership of that stack's control endpoint. A new stack
binds first and creates its document second. Repair binds while the stack is stopped. The owner
reserves the complete candidate port set before publishing its whole document; a competing owner
that loses an OS reservation rereads the documents and replans. Per-stack control ownership prevents
same-document writers, while OS port reservations fence concurrent cross-stack allocation without a
second coordination protocol.

The store is not public and has no repository injection interface. Tests receive an explicit
temporary `stateRoot` and use the real implementation.

### No global registry lock

There is deliberately no global file mutex. Making stale lock-file takeover both crash-safe and
compare-safe requires a second election/fencing protocol, which recreates the coordination system
this design removes.

The actual invariants already have narrower owners: atomic identity claims protect identity files,
the control endpoint serializes one stack's lifecycle and document, and bound placeholder sockets
settle concurrent cross-stack port allocation. A port-reservation loser rereads the lock-free store
and replans with a bounded Effect `Schedule`. Stopped automatic ownership remains visible in
`stack.json`; exact stopped coexistence remains a pure conflict-matrix rule.

### Lifecycle ownership and reattachment

Each managed stack has one deterministic loopback control address derived from its `stackId`:
`127.0.0.1` plus a port in `49152..65535` derived from two digest bytes. Node, Bun, POSIX, and
Windows use the same transport. The listener binds before service-port planning, so automatic ports
avoid it. An unrelated listener or the rare 14-bit deterministic-address collision fails as a typed
control-address conflict; it is never unlinked or taken over.

Binding the endpoint grants lifecycle ownership. The same bound server serves the existing validated
`Stack` management transport plus a versioned owner-status response; `/owner` is not a sidecar
listener or separate lifecycle API.

Acquisition behaves as follows:

1. Bind succeeds: this process owns the stack.
2. Address is in use and connect succeeds: a live owner exists. Start connects and awaits that
   owner's ready/failure state; status and logs attach; stop/delete send commands.
3. Address is in use but the endpoint does not speak the expected owner protocol: fail with a typed
   conflict. Do not kill, unlink, or infer ownership from a PID.

The kernel releases the loopback listener on normal close and process death. A stop/delete caller
waits for server close before attempting to bind; a killed owner needs no stale-path recovery.

The control protocol carries `protocolVersion: 1`. A mismatched client fails loudly with guidance;
there is no speculative compatibility adapter.

### One supervisor

There is one Effect-native supervisor program for detached stacks. Runtime-specific Node and Bun
files only provide platform layers and invoke `Effect.runPromise(main)` at the outer edge.

Startup order is normative:

1. Resolve identity in the parent without allocating ports.
2. Spawn the supervisor with identity, paths, serializable stack configuration, and port intents.
3. Bind the deterministic control endpoint.
4. Read stack documents, plan exact fields first, reserve the complete port set in this process, and
   atomically persist the allocation. On a reservation race, release the partial set, reread, and
   replan with a bounded Effect `Schedule`.
5. Start services. Each `beforeSpawn` releases only its placeholder socket immediately before the
   service binds.
6. Persist `running` runtime metadata and signal ready through fork IPC. Concurrent start losers
   attach to the control endpoint and await the same result.
7. On interruption or shutdown, scoped finalizers stop services, release remaining placeholders,
   close the control server, and persist `stopped` or `failed` as appropriate.

There is no `PortLease.handoff`, managed-daemon variant, operation claim, publication poll, or
abandoned-operation reconciler.

A process killed during start releases its control address and leaves a `starting` document. The
next owner derives resource cleanup from the stack ID, marks the previous attempt failed, and starts
again. A process killed during delete leaves `deleting`; the next owner completes deletion before
allowing a fresh registration of the same deterministic identity.

### Public managed interface

The public managed interface is deliberately smaller:

```typescript
interface ManagedStackManager {
  readonly stateRoot: string;
  readonly discoverWorkspace: (path: string) => Effect.Effect<WorkspaceDiscovery, DiscoveryError>;
  readonly resolveStack: (
    request: ResolveStackRequest,
  ) => Effect.Effect<ManagedStack, ResolveError>;
  readonly inspectStack: (stackId: string) => Effect.Effect<ManagedStack | undefined>;
  readonly listStacks: () => Effect.Effect<ReadonlyArray<ManagedStackListing>>;
  readonly deleteStack: (stackId: string) => Effect.Effect<DeleteResult, DeleteError>;
  readonly repairWorkspace: (
    request: RepairRequest,
  ) => Effect.Effect<WorkspaceDiscovery, RepairError>;
}
```

`resolveStack` owns managed selection and port intent but does not accept repository, initialization,
liveness, polling, or runtime-inspection callbacks. Detached launch composition remains in
`managedDaemonLayer`, which returns the existing `RemoteStack` interface. A Promise facade wraps the
same Effect layer for non-Effect callers.

Removed public concepts include `ManagedStackRepository`, repository access from the Promise handle,
`newCheckout`, `rebindCheckout`, `adoptContext`, `abandonIdentityTransition`, `prune`,
`reconcileAbandonedOperations`, owner PID options, and publication timing options. Repair replaces
the relevant recovery operations behind one explicit interface.

## Port invariants

1. A present config key is exact: use it or fail; never relocate it.
2. An omitted key receives a sticky automatic assignment persisted for its stack identity.
3. An unavailable persisted sticky port fails; it is not silently moved.
4. Exact fields are planned and reserved before automatic or runtime-only fields.
5. Exact assignments may coexist on stopped sibling stacks. A running owner conflicts.
6. Automatic assignments remain exclusive while stopped or failed.
7. Running configuration drift is reported and applies only after stop/start.
8. Removing an exact key preserves its number as automatic; disabling a service preserves its
   existing assignment and intent unchanged.
9. Errors name the port, requesting key, and owning stack, including self-owned retired keys.
10. Direct `createStack()` stays ephemeral and registry-blind.

## Lean test strategy

The integration suite is the primary protection. Each test drives a public manager or daemon
interface using real temporary state roots, real Git worktrees where identity matters, real JSON
documents, and real control sockets. Stateful Effect layers replace only expensive external service
startup when the test is about management rather than runtime artifacts.

Required managed integration scenarios:

1. First start in a Git checkout registers identity, allocates ports, and writes one stack document;
   stop/start reuses the same stack ID and automatic ports.
2. Two sibling worktrees start independently and concurrently; their automatic ports differ.
3. Two stopped siblings may share exact ports; a live owner produces an actionable conflict.
4. Automatic ports remain exclusive across stopped stacks and external occupation fails without
   relocation.
5. Running drift is reported; stop/start applies changes; removed exact keys and disabled services
   retain the approved intent semantics.
6. Concurrent starts of one identity produce one owner and one attached caller.
7. Killing the supervisor during start and during delete permits the next operation to recover
   without registry surgery.
8. A later manager process lists and reattaches to a detached stack, reads status/logs, and stops it.
9. Moved or duplicated workspace evidence returns `needsRepair`; explicit repair preserves stack ID
   and ports.
10. One corrupt document is reported as corrupt without hiding healthy stacks.
11. Control-protocol mismatch fails with explicit guidance.

Unit tests remain only for pure port planning/conflict rules, deterministic identity derivation, and
schema decoding branches structurally unreachable through integration setup.

E2E coverage remains limited to:

- one detached start/status/stop golden path through a real subprocess;
- one parallel-worktree golden path;
- one native-or-Docker full-stack smoke path where the actual runtime seam is the behavior.

The typed contract fixture corpus, fixture validator, repository conformance matrix, source-shape
tests, export-key snapshots, golden error strings, and branch-by-branch state-machine tests are
deleted. Any scenario not protecting an observable workflow is deleted rather than translated.

## Documentation and decision replacement

This design supersedes ADR-0015's decisions to make typed fixtures normative, expose repository
injection, and require conformance against memory and persistent adapters. ADR-0015 is updated to
`superseded` and links here. `packages/stack/docs/architecture.md` and the package README describe
only the resulting design; they do not retain a historical walkthrough of the removed machinery.

## Acceptance criteria

- One detached supervisor implementation, with thin Node and Bun runtime entrypoints.
- No managed operation rows, owner tokens, tombstones, publication polling, forced reconciliation,
  or port-lease handoff.
- No SQLite or in-memory managed repository implementation and no public repository seam.
- Managed persistence is per-stack, secret-free JSON written atomically.
- Normal workspace resolution has only `healthy`, `unregistered`, and `needsRepair` outcomes.
- The required integration scenarios above pass; low-value implementation tests and fixture DSL are
  removed.
- `packages/stack` and `apps/cli` unit/integration suites pass.
- `pnpm check:all` passes in `packages/stack`; all relevant `apps/cli` checks pass.
- Source and test line counts are materially lower than the PR #6218 baseline.
