# 0015. Managed Stack Contract Fixtures

**Status**: superseded by [ADR-0017](0017-simplified-managed-stack-architecture.md)
**Date**: 2026-08-10

> This proposal described a repository/adapter and exported fixture contract
> that was never a shipped boundary. The simplified managed implementation
> uses one private document and direct manager, supervisor, control, and CLI
> journeys. ADR-0017 is the current decision record; this document remains as
> historical context only.

## Problem Statement

The managed local-stack design combines project, checkout, branch, and named-stack identity with
mutable state, host-wide port allocation, runtime selection, legacy bootstrap, credentials, and
reclamation. These decisions affect both the reusable `@supabase/stack` package and the CLI. If each
layer encodes its own behavior matrix, they will drift and tests will eventually validate
implementation details instead of the behavior developers observe.

The persistence technology is intentionally not part of the product contract. A later adapter may
use SQLite or another store, but changing storage must not change identity or lifecycle semantics.

## Decision

The 104 typed fixtures exported from `@supabase/stack/testing` are the normative executable
description of the current managed-stack contract, including the M1 baseline and subsequent
lifecycle, port, runtime, and ownership behavior. Each scenario records:

- explicit input state;
- a public CLI, Git, direct-stack API, or managed-stack API action;
- the resolved opaque identities and outcome;
- the complete set of permitted managed-state writes and runtime side effects; and
- human, JSON, or programmatic output, including structured warnings and deterministic recovery
  guidance.

Opaque symbolic IDs make the same scenario reusable across an in-memory repository, a persistent
adapter, the managed package, and future CLI integration tests. Linear records the decision history
and links to implementation work; it is not a second source of executable truth.
Each scenario starts from its own isolated `given` state, so a symbolic ID or port has no shared
state across scenarios unless a fixture explicitly references another scenario. Conformance drivers
must reset their repository between scenarios.

Structured error and warning codes follow ADR 0001's `SCREAMING_SNAKE_CASE` convention. A `report`
is always read-only, and an `error` has no state mutation or runtime effect except the explicit
failed-bootstrap rollback, whose only permitted effects remove partial managed state.

`@supabase/stack` has two distinct public responsibilities:

1. Direct `createStack(config)` creates one caller-controlled stack. Omitted stack and runtime roots
   are resolved independently as disposable temporary directories and are removed on disposal.
   Supplying project, cache, or one state-root path does not make another omitted state root
   persistent. Direct usage does not inspect Git, create identity markers, or mutate a global
   managed registry.
2. The explicit managed surface owns system-aware discovery, identity, stack selection, ports,
   runtime persistence, bootstrap, and reclamation. It accepts an isolated state root or injected
   repository so applications and tests can use it without the CLI.

Managed port ownership is intent-sensitive. Exact rows may coexist on stopped or failed sibling
stacks, while an occupying exact row conflicts with another occupying exact row. Sticky automatic
rows are exclusive across all non-tombstoned stacks and an exact request cannot take one, even when
the owner is stopped. Keyless runtime-only fields are coordinated for the current runtime but are
not durable assignments. Disabled services do not hold leases, and ordinary `createStack()` and
the unmanaged daemon remain external participants that never consult managed reservations.
For detached starts, the child process that initializes services also runs the coordinator and owns
the leases through runtime handoff; no parent-held listener is transferred or reacquired.

The CLI is a consumer and presentation layer. It translates arguments into managed operations and
projects managed results into human and JSON output. It must not implement a second identity,
selection, port, runtime, or lifecycle decision path.

Git workspaces store project and branch-context identities in common local Git configuration, which
is shared by linked worktrees. Checkout identity is stored separately under each checkout's Git
directory. Context writes declare their owning branch so storage adapters cannot persist an unbound
context. A tracked working-tree identity marker is inert: discovery never trusts or rewrites it.
Ordinary non-Git folders persist a project-local, untracked identity marker on first start and
recover that same project, checkout, and context identity on later starts.

Read-only status remains a successful `report` when it can identify a running stack but finds
unapplied port, credential, or runtime configuration. The report includes a structured warning and
recovery guidance. Conditions that prevent safe identity selection, such as ambiguous ownership,
remain errors.

Persistence sits behind the managed package's repository boundary. Contract fixtures must run
against a storage-independent test repository and then against each selected persistent adapter.
The choice of SQLite, files, or another implementation does not move product policy into the CLI or
change the package boundary.

## Testing Strategy

Tests should be as close as possible to how a developer uses the product:

- Package integration tests invoke public direct or managed APIs and compare their observable
  result with the shared fixture.
- CLI integration tests invoke command handlers and assert argument translation plus human/JSON
  projection from that same managed result.
- Repository conformance tests execute the same fixtures against the isolated repository and the
  selected persistent adapter.
- Unit tests are reserved for genuinely pure algorithms and public export/type checks; they do not
  duplicate the behavior matrix through private helpers.
- E2E tests cover a small number of real subprocess/runtime golden paths. Add a targeted E2E test
  when a boundary cannot be represented faithfully in an in-process integration test, rather than
  mocking away the behavior under test.

CLI-2102 checks in the fixture data and public direct-stack boundary before the managed engine and
persistent adapter exist. The implementation issues it unblocks must attach real drivers to these
fixtures. CLI integration coverage begins when a real command boundary exists; a fixture-presence
test is not evidence that an unimplemented command already satisfies the behavior.

The fixture validator is deliberately fixture lint, not a second implementation of the managed
stack policy. It checks a small set of generic rule families:

- catalog shape and unique scenario identity;
- referential integrity for selected, written, and effected identities;
- state-write and runtime-effect pairing;
- structured diagnostic and read-only outcome shape; and
- consistency between the managed result and its human, JSON, and API projections.

The lint implementation lives separately in `managed-stack-contract-validation.ts` so the contract
module remains centered on types and normative scenario data.

The native qualification matrix derives service names and versions from the package service catalog
so it cannot drift from the shipped manifest. Identity resolution, lifecycle preconditions, port and
runtime selection, bootstrap policy, credential policy, and reclamation semantics belong to the real
managed resolver and engine delivered by the implementation issues below. Further requests to
"validate" those semantics should be covered by running these scenarios against that implementation,
not by expanding this lint into a parallel rule engine. A new lint rule is appropriate only when it
protects a generic fixture-format invariant across behavior areas.

Native-qualification facts describe the complete M5 launch-scope target, not the package's current
Docker-backed implementation. CLI-2121 through CLI-2141 attach the real native service graph to that
target contract.

## Implementation Handoff

The downstream implementation issues own the executable drivers, while this ADR and fixture data
own the expected behavior:

- CLI-2106, CLI-2107, and CLI-2108 attach the repository and identity resolver to the identity
  fixtures, including ordinary folders, worktrees, branches, and orphan handling.
- CLI-2106 and CLI-2108 must store checkout identity beneath the checkout-specific Git directory
  without implicitly enabling `extensions.worktreeConfig`; branch contexts remain in common local
  Git configuration.
- CLI-2109 attaches automatic legacy bootstrap and rollback-safe publication.
- CLI-2110 attaches exact and automatic port intent, allocation, stickiness, drift, and collisions.
- CLI-2124 attaches runtime selection, persistence, and strict conflict handling.
- CLI-2114 attaches the experimental CLI handlers and verifies that their human and JSON output is
  projected from managed results.
- The selected persistent adapter must run the same repository contract as the isolated test
  repository before its implementation issue is complete.

## Rationale

A single typed matrix makes disagreements visible in review and allows every layer to consume the
same expected result. Public-interface integration tests survive refactors because they assert
commands, API calls, outputs, and state transitions rather than internal call graphs. Injected
repositories keep system-aware behavior programmatically reusable while preventing a persistence
choice from leaking into product semantics.

Keeping direct and managed stack creation separate also preserves a simple embedding API for tests:
`createStack()` remains isolated, while callers that want branch/worktree-aware state opt into the
managed surface explicitly.

## Consequences

### Positive

- Package, CLI, and persistence adapters share one reviewed behavioral authority.
- Tests describe developer-visible journeys and remain useful through implementation refactors.
- Programmatic consumers can use managed state without importing CLI code.
- Direct test stacks stay isolated from Git and system-wide state.
- Storage technology can change without changing package ownership or managed semantics.

### Negative / Trade-offs

- The fixture catalog is intentionally large because it records edge cases that otherwise become
  implicit behavior.
- New managed behavior requires updating the shared matrix before layer-specific tests.
- Until downstream implementations attach real drivers, fixture catalog tests validate contract
  completeness and projection seams, not the future engine itself.

## Alternatives Considered

1. **Duplicate package and CLI test tables**: rejected because identity and lifecycle rules would
   drift and reviewers could not identify the authoritative result.
2. **Make CLI tests authoritative**: rejected because managed behavior must be reusable from Node
   and Bun without the CLI.
3. **Define behavior through a SQLite schema**: rejected because schemas describe persistence, not
   product semantics, and would make a technology choice distort package boundaries.
4. **Put the whole matrix in E2E tests**: rejected because the suite would be slow and failure
   diagnosis poor. E2E remains the fallback for boundaries that integration tests cannot exercise
   faithfully.
