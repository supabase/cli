# Managed Port Allocation Design

## Context

CLI-2110 defines the managed stack's port ownership policy. A port explicitly present in the
effective project configuration is exact, while an omitted config-addressable port is automatic.
Those automatic ports are allocated once and remain sticky across stop/start, branch return, and
workspace moves.

The stack package and managed state are not published compatibility boundaries. This change can
therefore replace the current development schema and port APIs directly instead of preserving
parallel legacy mechanisms or adding migrations.

Pull request #6216 is the latest shipped M2 baseline. It contains managed identity maintainability
work rather than port allocation, so this design builds on its managed identity and repository
model without treating its runtime allocator as a managed-state integration point.

## Goals

- Honor every explicit host port from the effective configuration exactly, including a value equal
  to the template default.
- Allocate omitted ports automatically, prefer conventional ports for new stacks, and persist the
  accepted assignment for sticky reuse.
- Keep automatic assignments unique across non-tombstoned managed stacks while allowing stopped
  stacks that share an exact committed configuration to retain the same exact metadata.
- Hold operating-system socket leases across selection, persistence, and runtime handoff so
  allocation is not a probe-then-bind race.
- Preserve a strict boundary between managed allocation and direct, unmanaged `createStack()` use.
- Keep the complete integration test suite parallelizable.

## Non-goals

- CLI command output and conflict presentation, owned by CLI-2114.
- General translation of every project configuration field, owned by CLI-2115.
- Legacy stack import and bootstrap, owned by CLI-2109.
- Runtime selection and launch policy, owned by CLI-2124.
- Preventing an unmanaged stack or arbitrary external process from occupying a stopped managed
  stack's sticky port in the future.
- A migration path for unpublished managed state or an adapter for the current development schema.

## Architectural boundary

Managed and unmanaged allocation remain separate orchestration paths that share only low-level
socket leasing primitives and typed port metadata.

The managed coordinator owns intent resolution, sticky reuse, managed conflict detection,
candidate selection, repository publication, and runtime handoff. It never asks `createStack()` or
the ordinary stack configuration resolver to discover managed reservations. The coordinator gives
the runtime one complete active-field allocation together with the already-held lease.

Direct `createStack()` retains an ephemeral allocator. It does not read, reserve, update, or infer
anything from managed state. From the managed system's perspective, a direct stack is an external
process. If it later occupies a stopped managed stack's sticky port, the next managed start fails
with an external-port conflict instead of silently relocating or stealing the port.

This separation prevents both directions of leakage: core stack startup does not depend on managed
repositories, and managed policy is not weakened to match an ephemeral allocator.

## Port catalog

Introduce one exhaustive typed catalog for host-visible runtime ports. Each entry defines:

- the typed runtime port field;
- the optional dotted project-configuration key;
- the conventional preferred port;
- the service whose enabled state controls whether the field participates; and
- enough metadata to report the field consistently.

Configured host ports include the applicable keys under `api`, `db`, `db.pooler`, `studio`,
`local_smtp`, `analytics`, and `edge_runtime`. Host ports that have no project-configuration key are
runtime-only automatic ports. The catalog, rather than duplicated object literals, is the
exhaustive mapping used by both intent resolution and concrete runtime projection.

Disabled services do not participate in allocation and do not hold socket leases. Persisted
config-addressable assignments for disabled fields remain available for future re-enablement unless
the stack is tombstoned; disabling a service is not permission to give its sticky automatic port to
another managed stack.

Config-addressable assignments are durable: present keys are exact, while omitted keys are
automatic and sticky. Keyless internal fields are allocated for the current runtime only, may move
freely between starts, and are recorded in live runtime state rather than durable
`ManagedPortAssignment` rows. This keeps all port selection inside managed orchestration without
creating an unremediable sticky conflict for a field the user cannot configure.

## Effective configuration and intent

Port intent is derived from the effective document after environment interpolation and selected
remote overlay, but before schema decoding fills defaults:

- a present numeric port is `exact`, even when it equals the conventional template value;
- an omitted port is `automatic`;
- a value supplied through environment interpolation is `exact`; and
- a value supplied by the selected remote configuration is `exact`.

Allocation correctness depends only on effective presence and numeric value. The configuration
loader will also retain path-level source provenance (`local`, `environment`, `remote`, or
`omitted`) for later diagnostics. Provenance must survive interpolation and remote overlay rather
than being reconstructed from the final number.

Intent resolution is a pure transformation from the loaded effective document and catalog to a
complete typed intent set. Schema defaults must never be used to infer exactness.

## Managed allocation transaction

The managed coordinator receives resolved stack identity, effective intents, enabled port fields,
and any persisted assignments. It constructs a complete candidate allocation before changing
managed state.

For a new sticky automatic field, the coordinator tries its conventional port first while excluding
all durable assignments of non-tombstoned managed stacks. If that port cannot be bound or is already
owned, it selects another available port. A keyless runtime-only automatic field also excludes all
durable assignments plus current runtime reservations, but is not retained after stop. For a new
or changed exact field, only the requested number is a valid candidate.

The coordinator binds every candidate on loopback and retains the complete socket lease. Only
after all fields are bound does it atomically publish the allocation and pending lifecycle change
through the repository. A managed ownership race during a new automatic allocation releases the
whole candidate set and retries selection. A race for an exact or previously sticky port fails;
those meanings do not permit relocation.

Repository ownership is intent-sensitive. Sticky automatic assignments are exclusive across every
non-tombstoned stack, including stopped and failed stacks. Exact assignments may coexist as metadata
on multiple stopped or failed stacks, which is required when branches share committed scaffolded
ports. An exact assignment may not take a sticky automatic assignment, even while its owner is
stopped. Entering a port-occupying lifecycle additionally rejects any exact assignment already
occupied by another stack. Tombstoning releases durable ownership. SQLite and memory adapters
implement the same transactional matrix.

The runtime receives only concrete ports and the held lease. It neither reselects ports nor reads
managed reservations. As each service successfully binds its port, the corresponding lease socket
is released. Failures before handoff release the complete set interruption-safely.

### Detached daemon placement

The process that initializes the runtime also owns managed allocation and its socket leases. For a
detached start, the parent resolves identity and sends the selected stack, effective intents, and
managed operation inputs to a managed daemon entrypoint. The child claims the start operation,
selects and binds ports, persists the accepted durable assignments, and initializes services while
holding those leases. It acknowledges startup only after runtime initialization and managed
publication succeed.

The ordinary daemon entrypoint remains unmanaged and retains its ephemeral allocator. No listener
is transferred between processes, and no parent-held lease is released before a child races to bind.
Foreground managed startup uses the same coordinator composition in-process.

## Durable ownership matrix

For another non-tombstoned stack, assignment compatibility is:

| Existing assignment | Incoming assignment | Existing owner stopped or failed | Existing owner occupying ports |
| ------------------- | ------------------- | -------------------------------- | ------------------------------ |
| exact               | exact               | coexist                          | conflict                       |
| automatic sticky    | exact               | conflict                         | conflict                       |
| exact               | automatic sticky    | allocate elsewhere               | allocate elsewhere             |
| automatic sticky    | automatic sticky    | allocate elsewhere               | allocate elsewhere             |

An automatic-to-automatic collision is normally resolved during allocation rather than surfaced.
An exact request that conflicts with a stopped sticky owner fails with guidance to change the exact
key or delete and recreate the automatic owner. It must not report that stopping the already-stopped
owner will help.

## Sticky and exact transition rules

For an existing stopped stack:

- an unchanged automatic field reuses its persisted number exactly;
- an unchanged exact field reuses its configured number exactly;
- a new or changed exact field must bind the requested number before the repository atomically
  replaces the prior allocation;
- removing an exact key changes its intent to automatic while preserving its existing number; and
- any bind or managed-ownership conflict leaves the previously accepted allocation untouched.

If removing an exact key would turn a number shared by another stopped exact assignment into an
exclusive sticky automatic assignment, the transition fails and preserves the previous exact row.
The caller may change the explicit configuration or delete and recreate the stack to obtain a fresh
automatic assignment.

A config-addressable sticky automatic port is not a preference on restart. If another process
occupies it while the managed stack is stopped, restart fails and reports the collision. Silent
relocation would break stable URLs and connection settings. A keyless runtime-only automatic port
has no such promise and is reallocated when unavailable.

For a running stack, no intent or port mutation is accepted. The coordinator compares the effective
intent set with the persisted allocation and returns structured drift, including intent-only drift
such as removing an explicit key whose numeric value happens to remain unchanged. The change takes
effect only after stop/start.

## Failure and concurrency semantics

Two arbiters protect different boundaries:

- operating-system socket leases arbitrate live availability against external and unmanaged
  processes; and
- the repository transaction arbitrates durable ownership among managed stacks.

Leases are Effect-scoped resources acquired and released with interruption-safe masks. A partial
candidate set is never published. If runtime initialization fails after an allocation was accepted,
the stack retains the complete durable assignment set for a later retry, releases and forgets its
runtime-only keyless ports, and does not claim that the runtime is active or publish a partial
runtime result.

Errors remain typed and preserve the distinction between:

- exact-port unavailability, including the port, configuration key, and managed owner when known;
- sticky automatic-port unavailability, which explicitly disallows relocation;
- managed ownership races;
- invalid or duplicate intent input; and
- running-stack drift, including configured and persisted intent/value details.

The allocator never stops another stack, mutates another stack's allocation, steals ownership, or
turns an exact or sticky conflict into an automatic fallback.

## Repository model

`ManagedPortAssignment` remains the durable expression of a config-addressable key, concrete port,
and intent. Repository preparation accepts the complete durable assignment set and validates:

- every enabled key appears exactly once;
- disabled or unknown keys cannot acquire a new active lease;
- all numbers are valid and unique within the stack;
- sticky automatic numbers are exclusive across non-tombstoned stacks;
- an exact number does not overlap another stack's sticky automatic number; and
- an occupying exact number does not overlap another occupying stack's exact number.

The unpublished SQLite `ports` table is replaced directly with the constraints, transactional
checks, and indexes needed for the intent-sensitive ownership matrix. Exact-to-exact stopped
duplicates mean a blanket unique index on `port` is incorrect. There is no schema migration,
compatibility reader, or fallback to filesystem metadata. Memory and SQLite implementations must
pass the same public repository contract scenarios.

## Testing strategy

Coverage is integration-first and exercises the public managed service/coordinator rather than
mocking allocator internals. The shared managed service suite runs against both memory and SQLite
repositories and covers:

- a present default-valued port as exact and an omitted port as automatic;
- local, environment-interpolated, and selected-remote exact values;
- sibling branches, worktrees, and named stacks avoiding each other's reservations;
- sticky reuse across restart, branch return, and workspace move;
- exact changes, exact-key removal, and intent-only running drift;
- shared exact scaffolded ports across stopped branch stacks, with conflict only while occupied;
- sticky automatic ownership retained by stopped and failed stacks and released by tombstones;
- exact requests rejected against stopped sticky automatic owners;
- collisions with external processes, legacy/direct stacks, and other managed stacks;
- deterministic concurrent automatic and exact allocation attempts; and
- interruption and runtime-initialization cleanup of socket leases.

Real socket tests bind loopback through the public coordinator. Candidate order and concurrency
synchronization are injectable test-local policies, allowing deterministic assertions without
spies, fixed ports, timing sleeps, or internal call-order expectations. Pure unit tests are limited
to the catalog and effective-document-to-intent transformation.

A direct `createStack()` integration regression proves that the unmanaged path remains ephemeral
and performs no managed-state read. Existing CLI-2102 contract fixtures are consumed through the
public managed interface rather than copied into implementation-specific tests.

A managed-daemon subprocess scenario verifies that allocation and lease ownership occur in the
child process through runtime bind and publication. A keyless-port scenario occupies the previous
runtime number before restart and verifies automatic relocation without changing durable
assignments.

### Parallel-suite invariant

The entire integration suite must continue to run with Vitest's normal parallel execution. Every
new scenario uses its own temporary state root, project directory, and SQLite database. Real socket
tests acquire unique loopback leases dynamically. Concurrency cases use test-local barriers or
deferred gates.

New tests must not use fixed ports, mutate process-wide current working directory or environment,
share project directories or Git configuration, install global listener fixtures, or opt a file or
project into sequential execution. Completion includes running the full stack integration project
with the default parallel configuration and repeating the run to expose leaked listeners or shared
state.

## Documentation

Update the managed architecture and contract documentation to name the coordinator as the owner of
managed port policy, document the intent-sensitive stopped-stack ownership matrix, distinguish
sticky config-addressable assignments from runtime-only keyless ports, and state that direct
`createStack()` is an external unmanaged participant. Remove documentation that implies managed
allocation is derived from filesystem stack metadata or performed inside the core runtime resolver.
