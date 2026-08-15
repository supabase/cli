# Managed Port Allocation Design

## Context

CLI-2110 defines the managed stack's port ownership policy. A port explicitly present in the
effective project configuration is exact, while an omitted port is automatic. Automatic ports are
allocated once and remain sticky across stop/start, branch return, and workspace moves.

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
- Prevent two non-tombstoned managed stacks from owning the same port, including while stopped.
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
the runtime one complete concrete allocation together with the already-held lease.

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
always automatic. The catalog, rather than duplicated object literals, is the exhaustive mapping
used by both intent resolution and concrete runtime projection.

Disabled services do not participate in allocation and do not hold socket leases. Persisted
assignments for disabled fields remain available for future re-enablement unless the stack is
tombstoned; disabling a service is not permission to give its sticky port to another managed
stack.

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

For a new automatic field, the coordinator tries its conventional port first while excluding all
ports reserved by non-tombstoned managed stacks. If that port cannot be bound or is already owned,
it selects another available port. For a new or changed exact field, only the requested number is a
valid candidate.

The coordinator binds every candidate on loopback and retains the complete socket lease. Only
after all fields are bound does it atomically publish the allocation and pending lifecycle change
through the repository. A managed ownership race during a new automatic allocation releases the
whole candidate set and retries selection. A race for an exact or previously sticky port fails;
those meanings do not permit relocation.

Repository uniqueness covers every non-tombstoned stack, including stopped, failed, starting,
running, and stopping stacks. Tombstoning releases ownership. The SQLite schema enforces this
invariant directly, and the in-memory repository implements the same transactional contract.

The runtime receives only concrete ports and the held lease. It neither reselects ports nor reads
managed reservations. As each service successfully binds its port, the corresponding lease socket
is released. Failures before handoff release the complete set interruption-safely.

## Sticky and exact transition rules

For an existing stopped stack:

- an unchanged automatic field reuses its persisted number exactly;
- an unchanged exact field reuses its configured number exactly;
- a new or changed exact field must bind the requested number before the repository atomically
  replaces the prior allocation;
- removing an exact key changes its intent to automatic while preserving its existing number; and
- any bind or managed-ownership conflict leaves the previously accepted allocation untouched.

A sticky automatic port is not a preference on restart. If another process occupies it while the
managed stack is stopped, restart fails and reports the collision. Silent relocation would break
stable URLs and connection settings.

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
the stack retains that complete allocation for a later retry, but managed state must not claim that
the runtime is active and must not publish a partial runtime result.

Errors remain typed and preserve the distinction between:

- exact-port unavailability, including the port, configuration key, and managed owner when known;
- sticky automatic-port unavailability, which explicitly disallows relocation;
- managed ownership races;
- invalid or duplicate intent input; and
- running-stack drift, including configured and persisted intent/value details.

The allocator never stops another stack, mutates another stack's allocation, steals ownership, or
turns an exact or sticky conflict into an automatic fallback.

## Repository model

`ManagedPortAssignment` remains the durable expression of key, concrete port, and intent, with the
key narrowed to the catalog's port-field type. Repository preparation accepts a complete allocation
and validates:

- every enabled key appears exactly once;
- disabled or unknown keys cannot acquire a new active lease;
- all numbers are valid and unique within the stack; and
- no number belongs to another non-tombstoned stack.

The unpublished SQLite `ports` table is replaced directly with the constraints and indexes needed
for global non-tombstoned ownership. There is no schema migration, compatibility reader, or
fallback to filesystem metadata. Memory and SQLite implementations must pass the same public
repository contract scenarios.

## Testing strategy

Coverage is integration-first and exercises the public managed service/coordinator rather than
mocking allocator internals. The shared managed service suite runs against both memory and SQLite
repositories and covers:

- a present default-valued port as exact and an omitted port as automatic;
- local, environment-interpolated, and selected-remote exact values;
- sibling branches, worktrees, and named stacks avoiding each other's reservations;
- sticky reuse across restart, branch return, and workspace move;
- exact changes, exact-key removal, and intent-only running drift;
- ownership retained by stopped and failed non-tombstoned stacks and released by tombstones;
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
managed port policy, describe stopped-stack ownership, and state that direct `createStack()` is an
external unmanaged participant. Remove documentation that implies managed allocation is derived
from filesystem stack metadata or performed inside the core runtime resolver.
