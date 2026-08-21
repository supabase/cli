# 0017. Simplified managed stack architecture

**Status**: accepted
**Date**: 2026-08-17

## Decision

Managed local-stack coordination has one implementation and one durable state
document. `ManagedStackManager` owns identity, sticky-port intent, launch
metadata, lifecycle transitions, and document writes. `managed/control.ts`
owns deterministic control ownership and endpoint derivation. The supervisor
child owns the runtime lease and `DaemonServer`; `RemoteStack` is the client
transport. CLI handlers call the lifecycle facade and never maintain a second
metadata file or PID-based liveness path.

The managed document is private unreleased state under the user-level managed
root. It is intentionally not a SQLite schema, repository contract, service
registry, or compatibility facade. Storage and lifecycle decisions stay in the
manager; the supervisor reconciles runtime resources before asking the manager
to start or delete a stack. Platform entrypoints only provide filesystem, path,
process, HTTP, and control-transport services.

Launch updates use the existing owner control route (`POST /managed/launch`).
An attached caller asks the owner to update launch metadata; a caller with
owned control updates the document directly. Stop acquires control first,
waits for the persisted `stopped` lifecycle, and handles a stale owner with
deterministic cleanup keyed by stack id. Delete requires owned control and a
live owner therefore cannot be deleted. After stale ownership is recovered,
delete reconciles persisted container resources before removing a document in
any lifecycle state.

Read-only discovery never acquires control ownership. It probes `/owner` and
treats an unreachable or foreign listener as non-live. Control ownership maps
the stack id to eight deterministic loopback candidates in the
`127.0.0.1:10000..32767` range. A mutation attaches to a matching owner on any
candidate or binds the first available candidate; unrelated listeners and
other stack identities are skipped. Acquisition fails closed when every
candidate is occupied or when a protocol-incompatible response prevents
ownership verification. Readers scan the same sequence and verify the
published ownership id. This is pragmatic single-user localhost coordination,
not a hostile multi-user security boundary. We are not adding control tokens
until the threat model justifies more protocol and persistence machinery.

## Why this replaces ADR-0015

ADR-0015 proposed 104 exported contract fixtures, a repository boundary, and
parallel persistent adapters. None of those were shipped producers or
consumers. Keeping them would preserve private compatibility surfaces and a
second architecture that the current CLI does not use. The proposal is
superseded; its identity and lifecycle intent are retained only where they are
implemented by the manager and supervisor.

## Testing decision

Tests follow the real consumed boundaries:

- manager integration covers ordinary folders, sibling worktrees, identity,
  sticky ports, document lifecycle, concurrent read/start ownership, stale
  owner recovery, and interrupted deletion;
- supervisor integration starts a real detached child, reattaches through the
  control endpoint, updates launch metadata, stops, and deletes; and
- CLI handler integration covers argument translation, output projections,
  telemetry, and the managed facade calls.

Private store/model algorithms receive focused unit coverage where useful. A
test that snapshots every export or validates a private contract registry is
not an architectural guarantee and should be deleted. Add an e2e journey only
when the compiled CLI/process boundary cannot be represented faithfully by one
of the existing integration journeys.

## Consequences

The architecture is smaller and has one source of truth for managed lifecycle
state. Refactors update the manager/facade and its real consumers together;
there is no fixture adapter or compatibility layer to keep in sync. The private
document format may change with the current build, while destructive cleanup
and control ownership remain explicit safeguards.
