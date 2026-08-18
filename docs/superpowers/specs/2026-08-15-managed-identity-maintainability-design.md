# Managed Identity Maintainability Design

## Context

Pull request #6214 fixes confirmed managed-identity recovery defects found after #6202. The same
review identified duplication and documentation drift in the code that owns workspace discovery,
identity settlement, Git configuration locking, and recovery tests.

The managed surface has not shipped as a stable compatibility boundary. The repository's
refactoring policy therefore favors the simplest current model over preserving unused exports.

## Goal

Reduce verified maintenance hazards in the managed-identity implementation without broadening
#6214 into a package-wide decomposition or changing developer-visible behavior.

## Scope

### Shared workspace facts

Create one small pure module that derives the managed workspace, context, and context descriptor
from a workspace inspection. Discovery and identity publication will consume this derivation
instead of rebuilding ordinary-folder and Git-checkout facts independently.

The discovery types remain the public read-only report contract. Resolved-plan types remain the
mutation-settlement contract; structurally similar types will not be merged merely to remove lines.

### Concurrent registration settlement

Move reusable topology and monotonic-publication predicates out of the large identity
implementation into a focused pure settlement module. The module will express the benign
first-start outcomes accepted by the facade, while transition-specific ownership checks remain in
their existing recovery flows.

The service facade will consume the named settlement policy rather than reassembling it from field
comparisons. Existing double discovery remains intact because it is the race-settlement guard.

### Git lock retry policy

Define the 10 millisecond exponential retry with a 400 millisecond bound once inside the Git module
and reuse it for ordinary Git config locking and explicit conditional-replacement lock acquisition.
The retrying Git config path and the non-retrying self-lock-aware path remain distinct.

### Unused Promise canonicalizer

Delete the Promise-based `canonicalizeManagedWorkspacePath`, its Node filesystem imports, its
managed entrypoint export, and the export assertion. Repository-wide search found no consumer; the
Effect filesystem implementation remains the only production path.

### Documentation and test quality

Correct the managed architecture documentation:

- describe four public entrypoint levels rather than three;
- describe the actual testing entrypoint, including fixtures, validators, repository seams, and
  transport test tags; and
- repair the malformed acquisition-failure sentence.

Strengthen the managed discovery integration tests by requiring exactly one concurrent rebind
winner, tracking every opened SQLite handle for cleanup, and removing assertions that only restate
discovery's already-filtered projection.

## Module size and ownership

Line count is a diagnostic, not a rule. This change will not mechanically slice large files or
introduce pass-through modules. New shared policy belongs in focused pure modules measured in
hundreds of lines, and the large identity implementation must shrink rather than grow.

The broader decomposition of `workspace-identity.ts`, `sqlite.ts`, `git.ts`, and `repository.ts` is
explicitly deferred until #6214 is complete. That follow-up will choose deep modules around domain
ownership rather than file size alone.

## Error behavior

No error tag, error code, recovery ordering, transition ownership rule, or fail-closed ambiguity
behavior changes. Settlement helpers only name behavior already exercised through the managed
public Interface. Removing the unused Promise canonicalizer is the only exported-surface change.

## Verification

Behavior remains protected through existing public-interface integration suites for managed
discovery, identity, resolution, and Git configuration. Focused tests will cover the strengthened
concurrent-rebind assertion and cleanup correction. Completion requires the full `packages/stack`
unit and integration suite plus type, lint, format, and unused-code checks.

## Explicit exclusions

- No generic identity matcher across exact, compatible, monotonic, and ownership semantics.
- No wholesale merge of branch-copy and adopt-context takeover implementations.
- No merge of resolved-plan and discovery contracts.
- No contract-fixture execution-policy change.
- No package-wide file decomposition.
