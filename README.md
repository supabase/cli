# Supabase

Bun monorepo for exploring the next generation of the Supabase CLI and local development stack.

## Setup

Install workspace dependencies:

```sh
pnpm install
```

Clone the reference submodules used during development:

```sh
bun run repos:install
```

That pulls `.repos/effect/`, which is the local source of truth for Effect v4 APIs and patterns in this repo.

## Workspace Layout

```text
.
|-- apps/
|   |-- cli/   # Published Supabase CLI package
|   `-- docs/  # Next.js docs site generated from the CLI
|-- packages/
|   |-- api/                  # Typed Supabase Management API client
|   |-- config/               # Supabase config schema and generated types
|   |-- process-compose/      # Effect-based process orchestration library
|   |-- stack/                # Programmatic local Supabase stack runtime
|   `-- cli-*/                # Platform-specific CLI binary packages
|-- tools/
|   `-- nx-plugins/           # Local Nx inference plugins
|-- docs/                     # ADRs, design notes, and implementation docs
`-- .repos/effect/            # Effect v4 reference source
```

## Apps

| Workspace | Purpose |
| --- | --- |
| `apps/cli` | Main `@supabase/cli` package. Contains command handlers, runtime services, auth, output, telemetry, and docs generation scripts. |
| `apps/docs` | Internal docs site built with Next.js and generated from the CLI docs sources. |

## Packages

| Workspace | Purpose |
| --- | --- |
| `packages/api` | Auto-generated TypeScript client for the Supabase Management API. |
| `packages/config` | JSON Schema and generated TypeScript types for Supabase configuration. |
| `packages/process-compose` | TypeScript/Bun port of `process-compose` used for multi-service orchestration. |
| `packages/stack` | Programmatic local Supabase stack used by the CLI and other tooling. |
| `packages/cli-darwin-arm64` | Published native CLI binary wrapper for macOS arm64. |
| `packages/cli-darwin-x64` | Published native CLI binary wrapper for macOS x64. |
| `packages/cli-linux-arm64` | Published native CLI binary wrapper for Linux arm64 (glibc). |
| `packages/cli-linux-arm64-musl` | Published native CLI binary wrapper for Linux arm64 (musl). |
| `packages/cli-linux-x64` | Published native CLI binary wrapper for Linux x64 (glibc). |
| `packages/cli-linux-x64-musl` | Published native CLI binary wrapper for Linux x64 (musl). |
| `packages/cli-windows-x64` | Published native CLI binary wrapper for Windows x64. |

## Working In The Monorepo

Root-level scripts:

```sh
pnpm run repos:install
pnpm run repos:pull
pnpm run check:all   # run all checks across every project
pnpm run fix:all     # run all fixers across every project
```

### Standard package scripts

All standard TypeScript workspaces (`apps/cli`, `packages/api`, `packages/config`, `packages/process-compose`, `packages/stack`) expose the following scripts:

| Script | What it does |
|--------|--------------|
| `test` | Run the full test suite (unit + integration + e2e) |
| `test:core` | Run unit and integration tests |
| `test:unit` | Run unit tests _(inferred by Nx plugin)_ |
| `test:integration` | Run integration tests _(inferred by Nx plugin)_ |
| `test:e2e` | Run end-to-end tests _(inferred by Nx plugin)_ |
| `check:all` | Run all check targets for this project |
| `fix:all` | Run all fix targets for this project |
| `types:check` | Type-check with `tsgo --noEmit` _(inferred by Nx plugin)_ |
| `lint:check` | Check for lint errors with `oxlint` _(inferred by Nx plugin)_ |
| `lint:fix` | Auto-fix lint errors _(inferred by Nx plugin)_ |
| `fmt:check` | Check formatting with `oxfmt --check` _(inferred by Nx plugin)_ |
| `fmt:fix` | Auto-fix formatting _(inferred by Nx plugin)_ |
| `knip:check` | Find unused exports and dependencies with `knip-bun` _(inferred by Nx plugin)_ |
| `knip:fix` | Auto-remove unused exports and dependencies _(inferred by Nx plugin)_ |

The inferred scripts (`test:unit`, `test:integration`, `test:e2e`, `types:check`, `lint:*`, `fmt:*`, `knip:*`) are not declared in `package.json` — they are injected by local Nx plugins in `tools/nx-plugins/`. They are fully cached and can be discovered via `nx show project <name>`.

Quality checks are run from the workspace you are changing:

```sh
# From a project directory — scoped to that project only:
pnpm run check:all
pnpm run fix:all
pnpm run test

# From the workspace root — runs across all projects:
pnpm run check:all
```

## Using Nx

Nx is the task runner for this repo. It handles caching, parallelism, and cross-project orchestration. All tasks — whether declared in a project's `package.json` or inferred by a plugin — are invoked the same way.

**Run a single target:**

```sh
nx run @supabase/api:knip:check
nx run @supabase/cli:test
```

**Run a target across all projects:**

```sh
nx run-many -t knip:check
nx run-many -t lint:check fmt:check types:check knip:check
```

**Run only affected projects** (compared to `main`):

```sh
nx affected -t test
nx affected -t lint:check fmt:check types:check knip:check
```

**Inspect a project's full task configuration** (including inferred targets):

```sh
nx show project @supabase/api
```

This is the best way to see what targets exist on a project, what their inputs and outputs are, and whether they are cached. Some targets are not declared in `package.json` but are injected by local Nx plugins — `knip:check` and `knip:fix` are examples of this.

### Caching

Nx caches task results locally under `.nx/cache`. A target hits the cache when all its inputs are unchanged since the last successful run — inputs include source files, named input sets like `sharedGlobals`, and external dependency versions.

To force a re-run and bypass the cache:

```sh
nx run @supabase/api:knip:check --skip-nx-cache
```

To clear all cached results:

```sh
nx reset
```

### Inferred targets

Several targets in this repo are not explicitly declared in any project file. They are injected by local plugins in `tools/nx-plugins/` that inspect each package's `package.json` and derive targets from the tooling configuration found there.

To see the full list of targets for a project, always use `nx show project` rather than reading the `nx.targets` field in `package.json` directly.

See [`docs/nx-inference-plugins.md`](docs/nx-inference-plugins.md) for how the plugin system works and how to add new plugins.

## Documentation

- [`docs/adr/`](docs/adr/) contains architecture decision records.
- [`docs/`](docs/) contains design notes for CLI output, telemetry, environment management, distribution, migration, and monorepo tooling.
- [`apps/cli/docs/`](apps/cli/docs/) contains source material used to generate command documentation.

## Reference Repos

The repo keeps source checkouts in `.repos/` for local inspection while developing:

- `.repos/effect/` contains the complete Effect v4 source used as the reference implementation for types, APIs, and patterns.
