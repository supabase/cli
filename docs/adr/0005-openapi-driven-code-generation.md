# 0005. OpenAPI-Driven Code Generation for CRUD Commands

**Status**: proposed
**Date**: 2026-02-10

## Problem Statement

The Supabase Management API is OpenAPI 3.0 compliant with ~100+ endpoints. Many CLI commands in the "Management APIs" section are thin CRUD wrappers around single API calls — list secrets, create a project, get network restrictions, etc.

Hand-writing typed API clients, Stricli command definitions, and handler stubs for each of these is repetitive, error-prone, and drifts from the API over time. ADR 0001 (Pillar 1: Command as Typed Function) already separates handler logic from rendering, making handlers ideal codegen targets. ADR 0004 distinguishes workflow commands (hand-written) from CRUD commands (generable).

~30 commands can be fully auto-generated, ~12 scaffolded, leaving only ~10+ truly hand-written. We need a strategy that eliminates boilerplate without sacrificing the hand-tuned quality of workflow commands.

## Decision

### Three-layer generation strategy

#### Layer 1: Generated types + typed client (`@supabase/api` package — fully generated)

- `openapi-typescript` generates `v1.d.ts` from `https://api.supabase.com/api/v1-json`
- `openapi-fetch` provides a typed client — handlers call `api.GET("/v1/projects/{ref}/secrets", ...)` with full type inference
- No hand-written wrapper methods needed — `openapi-fetch` IS the abstraction
- Types are **checked into git** (hermetic builds, visible diffs in PRs, no network dependency)
- CI job verifies types stay in sync with the live spec

#### Layer 2: Command scaffold generator (one-shot, then hand-owned)

A custom `scaffold-commands.ts` script reads the OpenAPI spec and generates:

- Stricli `buildCommand()` definitions (flags from query params / request body, positional args from path params)
- Handler stubs that call the `openapi-fetch` client and return `CommandResult<T>`
- Run **once** to bootstrap — generated files are then developer-owned and hand-edited
- A mapping config controls which OpenAPI operations map to which CLI paths (prevents API-mirroring)

#### Layer 3: Hand-written workflow commands

Workflow commands (`dev`, `push`, `pull`, `migrations`, `functions serve`, etc.) use the `@supabase/api` client but are entirely hand-written — they orchestrate multiple API calls, local file operations, and interactive flows.

### Command classification

| Classification | Count | Examples |
|---|---|---|
| **Auto-gen** (pure CRUD, 1:1 API mapping) | ~30 | `orgs list/create`, `projects list/delete/api-keys`, `secrets list/set/unset`, `branches list/get/delete`, `domains *`, `vanity-subdomains *`, `network-bans *`, `network-restrictions *`, `ssl-enforcement *`, `encryption *`, `snippets *`, `functions list/delete`, `env list-environments/list/set/unset/create/delete` |
| **Scaffold** (mostly CRUD, needs custom logic) | ~12 | `projects create`, `branches create/update`, `postgres-config *`, `backups *`, `sso *` |
| **Hand-write** (workflow, multi-step, local state) | ~10+ | `dev`, `push/pull`, `migrations *`, `functions deploy/download/serve/new`, `config push/pull/diff`, `storage *`, `login/logout`, `init/link`, `env pull/push/seed` |

### `openapi-fetch` over generated wrapper methods

Instead of generating one function per endpoint (which adds indirection without adding type safety), handlers use `openapi-fetch` directly:

```typescript
// Handler calls the typed client directly — path, params, and response are all type-checked
const { data, error } = await api.GET("/v1/projects/{ref}/secrets", {
  params: { path: { ref: flags.project } },
});
if (error) return { ok: false, error: mapApiError(error) };
return { ok: true, data };
```

This approach means:

- Zero wrapper code to maintain — `openapi-fetch` provides full type safety from the generated `v1.d.ts`
- IDE autocompletion works on paths, params, and response types
- Adding a new endpoint requires zero client-side code changes — just use the path string

### Checked-in types, not build-time generation

- The API changes infrequently — checked-in types make builds hermetic
- Diffs in PRs make API changes visible during code review
- Breaking changes cause TypeScript compilation errors immediately
- CI job runs `openapi-typescript` on schedule and opens a PR when drift is detected

### CI/CD: OpenAPI type sync

Three GitHub Actions workflows keep the checked-in `v1.d.ts` in sync with the live Management API spec. See the [OpenAPI Sync design doc](../openapi-sync.md) for workflow details and YAML examples.

## Rationale

**Eliminating boilerplate without losing control**: The three-layer strategy matches the effort to the complexity. Pure CRUD commands get fully generated types and clients (Layer 1) with scaffolded command definitions (Layer 2). Workflow commands get the typed client but nothing else — they're too varied for codegen to help beyond that.

**One-shot scaffold over continuous codegen**: Continuously regenerated code can't be customized — every hand-edit gets overwritten. One-shot scaffolding generates the starting point, then developers own the files. This is the right trade-off for CLI commands where descriptions, flag names, and error messages need polish.

**`openapi-fetch` over custom wrappers**: A generated wrapper function per endpoint (e.g., `api.listSecrets(ref)`) adds a layer of indirection without adding type safety — `openapi-fetch` already provides full type inference from the path string. The wrapper would just be mapping arguments to the same call `openapi-fetch` makes directly.

## Consequences

### Positive

- ~30 commands get type-safe API calls with zero hand-written client code
- ~12 commands get scaffolded starting points, saving hours of boilerplate per command
- API drift is caught automatically by CI — no silent breakage
- New API endpoints are immediately usable via `openapi-fetch` without any code generation step
- Checked-in types make builds hermetic and API changes visible in PRs
- The `@supabase/api` package is reusable by any package in the monorepo

### Negative

- Checked-in types require a CI job to detect drift — stale types are possible between runs
- `openapi-typescript` and `openapi-fetch` are external dependencies we don't control
- The scaffold generator is custom tooling that needs to be built and maintained
- Developers must understand `openapi-fetch`'s API (path-string-based) which differs from traditional API clients

## Alternatives Considered

1. **Hand-write everything** — Correct but slow. ~30 commands of pure boilerplate is wasted effort when the OpenAPI spec already describes the types, parameters, and paths. Every API change requires manual updates across multiple files.

2. **Generate wrapper methods per endpoint** — A function like `api.listSecrets(ref)` is familiar but adds a layer without adding type safety. `openapi-fetch` already provides full type inference from the path string. The wrapper just maps arguments to the same underlying call.

3. **Build-time generation (generate types during `bun install` or `bun build`)** — Adds network dependency and latency to every build. Fails when offline or when the API is down. Checked-in types are simpler and more reliable.

4. **Continuous codegen (regenerate command files on every build)** — Generated command files can't be customized — descriptions, flag names, and error messages all need hand-editing. One-shot scaffold followed by hand-ownership is more flexible.

5. **Mirror the API hierarchy as the CLI surface** — The API is organized by resource (`/v1/projects/{ref}/secrets`), but the CLI should be organized by workflow (`supabase secrets list --project <ref>`). The mapping config in the scaffold generator prevents API-mirroring.

## Related Decisions

- [ADR 0001](0001-cli-dx-architecture-pillars.md): CLI DX Architecture — The 7 Pillars (handler purity, typed results)
- [ADR 0003](0003-self-documenting-cli.md): Self-Documenting CLI (docs from code)
- [ADR 0004](0004-cli-design-goals-and-workflows.md): CLI Design Goals & Development Workflows (workflow vs CRUD commands)
- [ADR 0006](0006-environment-management.md): Environment Management & Variable Resolution (env command classification)

## See Also

- [OpenAPI Sync Workflows](../openapi-sync.md): GitHub Actions workflow details, YAML examples, and design decisions for keeping types in sync
