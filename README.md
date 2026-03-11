# Supa

Bun monorepo for exploring the next generation of the Supabase CLI and local development stack.

## Setup

Install workspace dependencies:

```sh
bun install
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
bun run repos:install
bun run repos:pull
```

Quality checks are run from the workspace you are changing:

```sh
cd apps/cli
bun run --parallel "*:check"
bun run --parallel "*:fix"
bun run test
```

Most packages follow the same Bun workspace conventions and expose the same `*:check`, `*:fix`, and `test` scripts.

## Documentation

- [`docs/adr/`](docs/adr/) contains architecture decision records.
- [`docs/`](docs/) contains design notes for CLI output, telemetry, environment management, distribution, and migration work.
- [`apps/cli/docs/`](apps/cli/docs/) contains source material used to generate command documentation.

## Reference Repos

The repo keeps source checkouts in `.repos/` for local inspection while developing:

- `.repos/effect/` contains the complete Effect v4 source used as the reference implementation for types, APIs, and patterns.
