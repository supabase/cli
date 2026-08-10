# 0015. Managed Stack Contract Fixtures

**Status**: proposed
**Date**: 2026-08-10

## Problem Statement

The managed local-stack design combines project, checkout, branch, and named-stack identity with
mutable state, host-wide port allocation, runtime selection, legacy bootstrap, credentials, and
reclamation. These decisions affect both the reusable `@supabase/stack` package and the CLI. If each
layer encodes its own behavior matrix, they will drift and tests will eventually validate
implementation details instead of the behavior developers observe.

The persistence technology is intentionally not part of the product contract. A later adapter may
use SQLite or another store, but changing storage must not change identity or lifecycle semantics.

## Decision

The typed fixtures exported from `@supabase/stack/testing` are the normative executable description
of the M1 managed-stack behavior. Each scenario records:

- explicit input state;
- a public CLI, Git, direct-stack API, or managed-stack API action;
- the resolved opaque identities and outcome;
- the complete set of permitted managed-state writes and runtime side effects; and
- human, JSON, or programmatic output, including structured warnings and deterministic recovery
  guidance.

Opaque symbolic IDs make the same scenario reusable across an in-memory repository, a persistent
adapter, the managed package, and future CLI integration tests. Linear records the decision history
and links to implementation work; it is not a second source of executable truth.

`@supabase/stack` has two distinct public responsibilities:

1. Direct `createStack(config)` creates one caller-controlled stack. Omitted stack and runtime roots
   are disposable temporary directories and are removed on disposal. It does not inspect Git,
   create identity markers, or mutate a global managed registry.
2. The explicit managed surface owns system-aware discovery, identity, stack selection, ports,
   runtime persistence, bootstrap, and reclamation. It accepts an isolated state root or injected
   repository so applications and tests can use it without the CLI.

The CLI is a consumer and presentation layer. It translates arguments into managed operations and
projects managed results into human and JSON output. It must not implement a second identity,
selection, port, runtime, or lifecycle decision path.

Git workspaces store project, checkout, and context identities in Git-local metadata, using common
or worktree scope as appropriate. Contract effects record that scope explicitly: project identity
uses common Git config, while checkout and context identities use worktree-local config. Context
writes also declare their owning branch so storage adapters cannot persist an unbound context. A
tracked working-tree identity marker is inert: discovery never trusts or rewrites it. Ordinary
non-Git folders persist a project-local, untracked identity marker on first start and recover that
same project, checkout, and context identity on later starts.

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

The fixture validator therefore checks more than catalog shape: selected, written, and effected
identities must be declared; starts of existing stacks must declare a stopped lifecycle; managed
state creation and registry publication must imply each other, as must managed-state deletion and
registry tombstoning; every state write and runtime effect must identify its target; contextual CLI
stack results must bind their output to a selected target; Git identity writes must use the correct
common or worktree scope, context writes must name the active branch as owner, and adapters cannot
recreate an identity already declared by a checkout; new Git-derived contexts, manual ref
replacement, detached-commit reuse, and selected linked worktrees must declare the relevant Git
state or transition; ordinary folders must write their full untracked identity marker on creation
and resolve it on reuse; managed and sticky port conflicts and persisted-runtime conflicts must
identify their actual target; sticky reuse must bind the assignment to the selected target;
runtime-selection creation fixtures must establish both an absent managed target and the legacy
state decision; persisted-runtime preflight failures must identify a stopped stack; a successful
bootstrap retry must follow an explicit rolled-back attempt;
credential create, update, and copy operations must prove that global state contains references
rather than plaintext; data-preserving prune must begin with mutable data; tracked identity markers
must remain untouched; native qualification facts must partition the service matrix, use a declared
platform, and match the platform passed to preflight; status operations must remain read-only
reports; repository adapter and portable runtime projections must reference a declared scenario,
match its identity, and agree on their complete decision; every invalid stack name must be exercised
through a public action; structured JSON projections must always name their outcome; destructive
runtime effects must map to mutable-state deletion and runtime-state deletion must stop the running
target; other runtime effects must agree with permitted state writes; and stable identity plus exact
human and JSON recovery fields cannot contradict the managed result. We deliberately do not
introduce a parallel test-only identity resolver; it would duplicate product policy before the real
managed surface exists and could pass while the production implementation drifts.

## Implementation Handoff

The downstream implementation issues own the executable drivers, while this ADR and fixture data
own the expected behavior:

- CLI-2106, CLI-2107, and CLI-2108 attach the repository and identity resolver to the identity
  fixtures, including ordinary folders, worktrees, branches, and orphan handling.
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

## See Also

- [CLI-2102](https://linear.app/supabase/issue/CLI-2102/contract-encode-approved-behavior-as-cross-layer-acceptance-fixtures)
- [CLI-2103](https://linear.app/supabase/issue/CLI-2103/contract-freeze-project-checkout-worktree-branch-and-named-stack)
- [CLI-2104](https://linear.app/supabase/issue/CLI-2104/contract-freeze-legacy-migration-declared-port-stop-and-rollback)
- [CLI-2105](https://linear.app/supabase/issue/CLI-2105/contract-freeze-runtime-selection-naming-precedence-and-persistence)
