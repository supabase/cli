# 0017. Simplified managed stack architecture

**Status**: accepted
**Date**: 2026-08-17

## Decision

Managed local-stack coordination has one implementation and one durable state
document. The stack package owns identity, sticky ports, launch selection,
lifecycle transitions, and state writes. A detached Supervisor holds the
exclusive ownership lease only while the stack is running or an admitted
operation is in flight, while stop-time cleanup remains unproven, or while an
unproven destroy leaves durable intent `destroying`. Public
handles communicate with it through same-release Effect RPC and a small
release-stable maintenance protocol for probe and stop. CLI handlers call this
facade and do not maintain a second metadata or PID-based liveness path.

The public API has two deliberate entrypoints: Effect-native operations are
available from `@supabase/stack/effect`, while the package root exposes the
Promise handle and root Promise functions (`createStack`, `openStack`,
`findStack`, `listStacks`, and `inspectStack`). Test callers use the public
`createTestStack` helper from `@supabase/stack/testing`; it owns an isolated
project root and exact-identity cleanup through `await using`. Overlapping test
helpers share one process-scoped ephemeral coordination state root so automatic
ports coordinate like production while each project root and identity-scoped
data remain isolated. The coordination root is reference-counted and removed
after every owned stack has destroyed successfully; a failed destroy retains
its exact project and coordination state for recovery.

The managed document is private, unreleased state under the user-level managed
root. It is not a repository contract, service registry, compatibility facade,
or independently versioned database schema. Platform entrypoints only provide
filesystem, path, process, HTTP, and control-transport services.

Stack handles are lightweight identity-scoped clients. Creating or opening one
does not launch a Supervisor. Successful stop drains ingress, removes every
ephemeral runtime resource, persists stopped state, delivers its response, then
closes control and releases ownership. The caller waits for both response and
lease release. A stopped stack therefore consumes no live process, container,
network, socket, listener, or gateway. Status and retained logs are read from
durable files only when owner metadata and the ownership lock are both absent.
The same handle lazily launches a fresh Supervisor on its next start.

A Supervisor launched for a mutation also exits when that mutation cannot leave
running intent behind. In particular, a failed start before the running state is
committed releases its control endpoint and ownership lease after reporting the
failure. A successful start keeps the Supervisor alive; a sequential idempotent
start returns the current status without resetting lazy activation or publishing
a synthetic starting transition.

If exact runtime cleanup cannot be proven, status remains `stopping` and the
owner stays available for a retryable `stop()`; a cleaned stopped stack never
retains that owner.

There is no durable generation counter and runtime resources are never adopted
across owner sessions. The exclusive stack lease and `ownerSessionId` identify
the only writer and current ephemeral resources. Explicit start, stop, or destroy
first removes exact stack-owned remnants and creates fresh resources;
failure to complete or validate cleanup fails closed. Persistent data, sticky
ports, secrets, definitions, logs, and artifacts remain identity-scoped.

Before a native cold start creates anything, it verifies every persisted public
and private port is bindable. PostgreSQL lock evidence containing a live or
unclassifiable owner PID fails closed; a lock naming a process that no longer
exists is left for PostgreSQL's own stale-lock recovery. A live stop/start
composition preflights configuration without trying to bind ports that the
current Supervisor intentionally owns. Cold recovery never adopts those
resources. If an authoritative bind loses a race for a fresh automatic public
assignment, planning retries with a bounded exclusion set; exact assignments
and previously persisted sticky automatic ports remain hard failures and are
never silently moved.

Every managed document records one concrete runtime selection. Native and
container runtimes never mix. Omission defaults to Docker; callers may
explicitly select Docker or Podman. There is no probing or auto-detection;
Podman is supported only on local Linux hosts. Persisted state records the
resolved exact engine. Capability releases and
workload artifacts are persisted as exact version pins (including their
concrete native release and container image) rather than ranges or floating
tags.

Read-only discovery never acquires ownership. Owner metadata points to a Unix
domain socket on POSIX or a named pipe on Windows, and the ownership lock is the
single-writer authority. Offline status and retained logs are available only
when both metadata and lock are absent. Mutations use the live owner or acquire
the lease and launch a fresh Supervisor. Ambiguous ownership fails closed.

The stable maintenance protocol contains only probe and stop. Same-release
callers use Effect RPC for status, logs, activation, start, and destroy; artifact
preparation runs directly in the caller scope and never uses the Supervisor. An
incompatible owner can always be stopped, after which the caller may launch the
current Supervisor and start again. The first admitted lifecycle operation runs
to completion; concurrent lifecycle mutations fail immediately with a conflict
rather than joining or queueing.

PostgreSQL is the only eager capability by default. Start prepares and launches
only the eager dependency closure. Every other enabled capability prepares and
starts when traffic first reaches its stable gateway route. Explicit
`stack.prepare(...)` remains available for callers that intentionally want to
warm selected artifacts, but it is not part of ordinary CLI start. Preparation
is caller-owned: cancellation stops that caller's unfinished transfers while
completed cache entries remain. It never acquires control or ownership and does
not create runtime resources.

Artifact cache trust begins only after a candidate has passed checksum and
runtime-path validation, had its metadata written, and been atomically
published. A cache hit revalidates the metadata, required path kinds and
containment, and executable shape, but does not cryptographically revalidate
published contents. The cache is user-owned and immutable by contract; manual
post-publication changes may execute successfully or fail later at workload
start. A partially published or malformed entry is never trusted merely
because its directory exists.

Effect failures remain operation-specific tagged errors (for example,
configuration, preparation, gateway, port, and lifecycle failures), preserving
typed recovery and actionable context at the Effect boundary. The Promise
facade translates those failures into native rejections only at its outer edge.

## Why this replaces ADR-0015

ADR-0015 proposed exported contract fixtures, a repository boundary, and
parallel persistent adapters without shipped producers or consumers. Keeping
them would preserve a second architecture. Its identity and lifecycle intent
survive only where implemented by the stack package and Supervisor.

## Testing decision

Tests follow consumed boundaries:

- stack integration covers identity, sticky ports, durable lifecycle,
  ownership, stale-owner recovery, and interrupted cleanup;
- supervisor integration covers detached ownership, RPC, stop, and
  destroy; and
- one shared stack-package E2E journey runs in native and Docker modes, starts
  with PostgreSQL alone, activates every other service through realistic
  traffic, verifies cross-service behavior, then exercises
  stop/start and retained offline observability.

CLI handler integration covers only argument translation, output, telemetry,
and calls into the stack facade. Private implementation tests are retained only
where public scenarios cannot make a branch observable.

## Consequences

The architecture has one source of truth for lifecycle state and one owner for
ephemeral resources. Refactors update the package facade and its real consumers
together. The private document format may change with the current build, while
destructive cleanup and ownership remain explicit safeguards.
