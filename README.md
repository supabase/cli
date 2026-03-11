# Supa

Playground for exploring the next version of the Supabase CLI.

## Setup

```sh
bun install
```

Optional: clone the reference repos in `.repos/` for local learning and development:

```sh
git submodule update --init --recursive
```

## Packages

| Package | Description |
|---|---|
| `@supabase/cli` | The CLI itself (Stricli + React Ink) |
| `@supabase/api` | Typed Management API client |
| `@supabase/config` | Configuration JSON Schema and types |
| `@supabase/process-compose` | Process orchestrator (TypeScript port) |

## Docs

The `docs/` directory contains design documents and [Architecture Decision Records](docs/adr/).
