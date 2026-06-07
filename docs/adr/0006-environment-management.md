# 0006. Environment Management & Variable Resolution

**Status**: proposed
**Date**: 2026-02-10

## Problem Statement

The CLI needs a model for managing environment-specific configuration (secrets, API keys, feature flags) across local development and deployed environments.

Three forces shape this problem:

1. **Two workflows from [ADR 0004](0004-cli-design-goals-and-workflows.md)** — remote-first (platform is source of truth, pull/push sync) and local-first (manual `.env`, no platform until linked). Environment management must work in both modes.
2. **Sensitive values** — secrets, tokens, and API keys must never appear in `config.json` (committed to Git) and must never leak to version control.
3. **Multiple deployment targets** — local development, preview branches, and production each need different variable values, but the configuration structure should be identical across all of them.

The Management API for environments is already designed. This ADR focuses on CLI-side architectural decisions: the command surface, sync model, local file structure, and variable resolution.

## Decision

We adopt the environment management model described in the [Environments Management design document](../environments-management.md). The key architectural decisions are:

| # | Decision | Summary |
|---|----------|---------|
| 1 | Flat, independent environments | Three non-deletable defaults (`development`, `preview`, `production`) plus user-created custom environments. No inheritance — values are explicitly copied via seeding. |
| 2 | `supabase env` command group | CRUD subcommands auto-generated per ADR 0005. Workflow subcommands (`pull`, `push`, `seed`) hand-written. |
| 3 | Pull/push sync model | `pull` = full replacement of `.env` from platform (secrets excluded). `push` = diff-based upsert (secrets on remote skipped, optional `--prune`). Both default to `development`. |
| 4 | Secrets as a flag, not a separate system | All variables encrypted at rest. `secret` flag makes a variable write-only. Auto-classified from `"x-secret": true` in config schema. Set on platform directly, never pushed from `.env`. |
| 5 | Resolution order for local dev | OS env → `.env.local` → `.env`. No variable expansion in `.env` files. |
| 6 | Two variable binding modes | Platform variables: implicit binding (canonical names from config paths). User variables: explicit `env()` in `config.json`. Both share the same environment and CLI commands. |
| 7 | Branch-to-environment mapping | Configured in `config.json`. First explicit match wins; wildcard last. `development` excluded (local-only). |
| 8 | Single `.env` file | One `.env` (from `development` or manual) + `.env.local` (personal overrides). All `.env*` gitignored. No per-environment `.env` files. |

For full operational details — CLI command reference, workflows, branch-specific overrides, Edge Functions integration, platform API requirements, and dashboard behavior — see the [design document](../environments-management.md).

## Rationale

**Flat environments over inheritance**: Inheritance creates hidden coupling — changing a "base" environment cascades unpredictably. Flat environments are explicit: what you see in `list` is what the service gets. Seeding provides the copy-once mechanism when environments share starting values.

**Pull as full replace, push as diff**: Pull is a snapshot — simple to reason about, no merge conflicts. Push shows a diff before applying, giving the developer control. This asymmetry matches how developers think: "give me the latest" (pull) vs "here's what I changed" (push).

**Secrets as a flag, not a separate system**: A unified variable system means one set of commands, one `.env` format, one dashboard view. The `secret` flag adds write-only semantics without splitting the mental model.

**No variable expansion in `.env`**: Variable expansion (`${VAR}`) creates implicit dependencies between variables and makes the file harder to reason about. Literal values are predictable. Composition belongs in `config.json` where it's explicit.

**`development` excluded from branch mapping**: `development` is for local execution, not deployment. Including it in the branch mapping would conflate "what runs on my machine" with "what gets deployed," which is exactly the confusion environments are designed to eliminate.

**Explicit secret management over file-based annotation**: Secrets are set directly on the platform via `supabase env set --secret` rather than annotated in `.env` files. This eliminates a non-standard annotation format, avoids secrets flowing through local files and push, and makes the security boundary clear: secrets go to the platform via a dedicated command, not through a file sync workflow. For platform variables, schema-driven auto-classification (`"x-sensitive": true`) handles the common case automatically.

## Consequences

### Positive

- Developers get a familiar pull/push model that works like Git for environment variables
- Secrets are handled safely by default — never in `config.json`, never auto-pulled, set explicitly via `--secret` or auto-classified from schema
- The resolution order (OS → `.env.local` → `.env`) works naturally with CI/CD, Docker, and local overrides
- CRUD commands are auto-generable per ADR 0005, reducing implementation effort
- The flat environment model is simple to explain and debug
- Local-first developers can work with `.env` files immediately, then sync when they link a project

### Negative

- No inheritance means duplicated values across environments — seeding mitigates but doesn't eliminate this
- Pull is destructive (full replace) — developers must use `.env.local` for values they don't want overwritten
- Write-only secrets cannot be verified after creation — if a value is wrong, it must be re-set
- Branch-to-environment mapping in `config.json` means the mapping is committed to Git — all collaborators share the same mapping

## Alternatives Considered

1. **Environment inheritance (development → preview → production)** — Each environment inherits from its parent, overriding specific values. Reduces duplication but creates hidden dependencies — changing a parent value silently affects children. Debugging "where did this value come from?" becomes hard. Flat environments with explicit seeding are simpler to reason about.

2. **Separate `.env.development`, `.env.preview`, `.env.production` files** — Multiple files sitting on disk, one per environment. Creates confusion about which file is active, risks committing the wrong file, and doesn't match the platform model (environments live on the platform, not in local files). A single `.env` representing the current working environment is cleaner.

3. **Separate secrets storage (e.g., `supabase secrets` command group)** — A dedicated system for secrets with its own commands and storage. Doubles the surface area for what is fundamentally the same operation (set a key-value pair). The `secret` flag on a unified variable system is simpler.

4. **Variable expansion in `.env` files** — Supporting `${VAR}` syntax for composing values. Adds implicit dependencies between variables, makes files harder to debug, and creates divergence from platform behavior (the platform doesn't expand variables). Literal values are predictable.

5. **Automatic merge on pull (three-way merge)** — Instead of full replace, merge remote changes with local edits. Complex to implement correctly, produces confusing conflicts for key-value pairs, and the merge semantics are unclear (which side wins?). Full replace with `.env.local` for overrides is simpler.

## Related Decisions

- [ADR 0001](0001-cli-dx-architecture-pillars.md): CLI DX Architecture — The 7 Pillars (handler purity, typed results, error design)
- [ADR 0004](0004-cli-design-goals-and-workflows.md): CLI Design Goals & Development Workflows (remote-first and local-first workflows, `supabase dev` orchestration)
- [ADR 0005](0005-openapi-driven-code-generation.md): OpenAPI-Driven Code Generation (CRUD vs workflow command classification)

## See Also

- [Environments Management](../environments-management.md): Full design document covering data model, API requirements, dashboard behavior, and end-to-end workflows
