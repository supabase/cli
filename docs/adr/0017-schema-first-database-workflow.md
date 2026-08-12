# 0017. Schema-First Database Workflow

**Status**: proposed
**Date**: 2026-08-10

## Problem Statement

The alpha CLI needs one coherent workflow for declaring database shape, reviewing the
resulting changes, applying them locally, and synchronizing them with the Supabase
platform. PostgreSQL DDL, migration files, live database state, and platform migration
history are related but distinct forms of state. Without an explicit ownership model,
the CLI can generate migrations that do not match what it applies, overwrite local
intent during a pull, or hide drift between local and remote databases.

The repository already depends on `@supabase/pg-delta`, which can extract PostgreSQL
state, load declarative SQL through a shadow database, plan changes, render execution-
aware SQL files, apply fingerprint-gated plans, and export declarative SQL. The CLI must
decide which responsibilities belong to pg-delta and which belong to the schema and
migrations workflows.

## Decisions Already Established

- `schema` is the primary public command group for database shape changes.
- Declarative schema is the default alpha workflow; migration files are its generated
  implementation artifact.
- `schema generate` derives migration files without applying them.
- `schema apply` mutates the local database from declared schema intent.
- `schema push` synchronizes declared schema intent to the platform.
- `schema pull` refreshes the local declarative representation from platform state.
- `migrations` remains the advanced file-level workflow and does not own declarative
  schema generation.
- `apply` means local database mutation; `push` and `pull` mean platform synchronization.

## Proposed Integration Boundary

Pending interview decisions, the working boundary is:

- pg-delta is the schema compiler: database/catalog extraction, managed-view policy,
  declarative SQL loading, rename analysis, change planning, safety metadata, plan
  rendering, and declarative export.
- the CLI is the workflow coordinator: project layout, target resolution, shadow
  lifecycle, migration naming and ledger integration, conflict policy, user prompts,
  structured output, retries, and composition of schema operations with migrations.
- the migration runner remains responsible for applying and recording concrete
  migration files. The CLI must not claim a generated migration was applied unless the
  same execution units were recorded in migration history.

## pg-delta Fit and Gaps

pg-delta is a strong fit for the schema-compilation portion of the workflow. Its
current library API can load declarations into a real shadow database, extract and
compare managed state, report rename candidates and safety metadata, render one SQL
file per execution segment, apply a fingerprint-gated plan, prove convergence on a
clone, and export a manifest-owned declarative tree.

It does not provide the workflow around those primitives:

- no migration versions, applied-history ledger, pending-migration reconciliation,
  repair, or append-only file policy;
- no Supabase project/branch resolution, authentication, or production guardrails;
- native shadow lifecycle now exists, but the alpha workflow still needs an explicit
  ownership boundary between shared bootstrap and pg-delta-specific isolation;
- no policy for reconciling pulled state with local edits or unpushed migrations;
- no guarantee that a multi-segment plan is globally transactional;
- no stable API or persisted artifact compatibility while the dependency remains alpha.

Coverage also needs an explicit alpha contract. Entirely unmodeled object kinds are
diagnosed and can be rejected with strict coverage, but known attributes within modeled
families are still invisible to extraction and therefore to pg-delta's own proof. The
Supabase integration profile does not yet ship a complete versioned platform baseline,
and stateful extension intent is only partially represented. Alpha must document and
preflight its supported subset rather than claim complete PostgreSQL round-trip fidelity.

## Initial Alpha Recommendation

Subject to the decisions below:

- use migration replay in a fresh shadow as the observed baseline for generation;
- treat declarations as desired state and append-only migration files/history as the
  transition ledger;
- have `schema apply` and `schema push` execute generated files through the migration
  runner, never through pg-delta's direct target mutation path;
- export pulls into staging and replace only files owned by the export manifest;
- start with database scope, strict coverage, shape-only SQL, explicit rename acceptance,
  and no credential-bearing declarative objects;
- preserve pg-delta execution segments as distinct migration versions;
- keep pg-delta behind a narrow adapter and persist plans only as diagnostic artifacts.

## Decisions Required

1. Whether schema commands and direct migration commands may be mixed in one project,
   and how the CLI detects stale declarative state when they are mixed.
2. The comparison baseline for `schema generate`: local live state, migration replay,
   the last generated checkpoint, or another durable snapshot.
3. Whether `schema apply` must always generate migration files first and then apply
   those files, or may apply a pg-delta plan directly.
4. Whether `schema push` generates from local state and pushes migrations, or plans
   directly against remote state and then materializes the resulting migration files.
5. Pull conflict behavior when local declarative files or unpushed migrations differ
   from the platform.
6. Alpha management scope: database objects only, or cluster-global roles and grants
   as well.
7. Alpha safety defaults for destructive changes, rename ambiguity, unmodeled object
   diagnostics, table rewrites, lock risk, and declarative files containing data.
8. Whether proof on a disposable clone is required, optional, or deferred for local and
   remote workflows.
9. The stability strategy for pg-delta's breaking-change alpha API and artifact formats.

## Upstream Work or Deferrals

- Complete the versioned Supabase baseline and Cloud/local default-privilege handling.
- Close modeled-family extraction gaps before advertising broad round-trip fidelity.
- Extend intent handlers for pgmq and pg_partman before making them declarative.
- Improve explicit rename declarations for non-interactive and rename-plus-edit cases.
- Add independent verification for critical workflows rather than treating a proof that
  shares the planner's extractor as an independent oracle.

## Consequences

### Positive

- The public workflow stays centered on schema intent while retaining reviewable,
  auditable migration history.
- pg-delta's planner, managed-view policy, safety metadata, and export logic are reused
  instead of duplicated in the CLI.
- Explicit ownership makes local apply, remote push, and pull conflict behavior testable.

### Negative

- The CLI needs orchestration and durable-state machinery beyond pg-delta itself.
- Supporting both declarative and direct migration workflows creates reconciliation
  cases that must fail closed when intent is ambiguous.
- pg-delta is currently a breaking-change alpha dependency, so the integration needs a
  narrow adapter and compatibility tests.

## Related Decisions

- [ADR 0004](0004-cli-design-goals-and-workflows.md): CLI Design Goals & Development Workflows
- [Alpha command structure](../cli/dev-alpha-command-structure.md)
- [Schema workflow glossary](../cli/schema-workflow-glossary.md)
