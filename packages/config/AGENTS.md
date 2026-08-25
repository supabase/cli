# @supabase/config

Supabase project configuration package built on Effect V4 Schema — owns the canonical
`CliConfig` schema, config file loading/saving, and JSON Schema generation.

## Entrypoints

Three entrypoints plus a generated artifact (see ADR 0009's 2026-08-24 decision for the full
rationale):

- `@supabase/config` (`.`) — pure, browser/edge-safe surface. The `CliConfigSchema` and
  derived types, config encoding, sparse-config defaults, and error classes. No file IO, no
  Effect-returning function, no `@effect/platform-*`/`node:`/`bun:` module anywhere in its
  transitive import graph.
- `@supabase/config/io` — a Promise-based file-IO facade for **external, non-Effect Node/Bun
  consumers only**. Resolved via package.json exports conditions (`bun`/`node`/`browser`/`default`).
  Has zero internal consumers by design — nothing inside this monorepo should import it.
- `@supabase/config/effect` — the Effect-native superset. Re-exports everything from `.` plus the
  Effect-returning config-loading/saving programs, `CliConfigStore`/`cliConfigStoreLayer`,
  project-environment resolution, and functions-manifest inference.
- `@supabase/config/schema.json` — generated JSON Schema for `CliConfig` (a `dist/` build
  output).

## Monorepo import rule

- A file anywhere in this monorepo that needs **any** Effect-native symbol (the `CliConfigStore`
  service, `loadCliConfig`/`saveCliConfig`, project-environment resolution, functions-manifest
  inference, etc.) imports everything it needs from `@supabase/config/effect` — never mix that with
  importing the same package's default entrypoint in the same file.
- A file that needs only pure symbols (the schema, types, encoding, sparse defaults, errors) imports
  from `@supabase/config`.
- `@supabase/config/io` is exclusively for external consumers outside this monorepo that aren't
  Effect-native. Do not add an internal consumer of it.
- Never deep-import this package's internals (e.g. `@supabase/config/src/io.ts`). Only the four
  entrypoints above are supported import paths.

## Pure-graph invariant

`src/index.ts`'s transitive runtime import graph must never grow to include `io.ts`, `paths.ts`,
`project.ts`, `functions-manifest.ts`, `bun.ts`, `node.ts`, `promise-facade.ts`, `effect.ts`,
`cli-config.layer.ts`, or `cli-config.service.ts` — that would drag file-IO/Effect-platform
machinery into a graph bundlers (e.g. Studio) need to tree-shake as browser-safe.
`src/entrypoint-purity.unit.test.ts` enforces this by statically walking `index.ts`'s real relative
import graph against a hardcoded allowlist, pins both entrypoints' exact runtime export surfaces, and
asserts the package.json `exports` map shape. Any change that grows the pure graph or the export
surface must update that test deliberately — it is not meant to be a silent pass.

## Testing

Run tests from this package with `bun --bun vitest run --project unit` (plain `node` vitest is
broken here). Always run the relevant unit tests for what you changed before considering a task done.
