# 0009. Configuration Schema & Validation

**Status**: proposed
**Date**: 2026-02-10

## Problem Statement

`config.json` is referenced in ADRs 0003 (doc generation from schema), 0004 (project manifest), 0006 (`env()` syntax, `environments` block, branch mapping), and PLAN.md shows a `@supabase/config` package. No ADR captures the schema design decisions.

## Key Decisions to Cover

- **Schema format**: JSON Schema-based (per PLAN.md), but what generates the schema? Zod? TypeBox? Hand-written?
- **`env()` syntax**: How it works, how it's parsed, error handling for missing vars
- **Schema versioning**: How to handle schema evolution, what happens when a user's config is from an older schema version
- **Validation**: When does it run (on load? on push?), error messages, partial validation
- **Platform variables vs user variables**: Implicit binding from config paths (ADR 0006 Section 6) vs explicit `env()`
- **Default config generation**: What `supabase init` produces
- **Migration**: From old `supabase/config.toml` to new `supabase/config.json`
- **`@supabase/config` package architecture**: How it exports schema, types, and template (from PLAN.md)

## Decision: `@supabase/config` Package Architecture (2026-08-24)

CLI-2231 resolves the "`@supabase/config` package architecture" bullet above (the rest of this ADR's key decisions remain open). The package exports three entrypoints plus a generated JSON Schema artifact:

- `@supabase/config` (`.`) — pure, browser/edge-safe surface: `ProjectConfigSchema` and its derived types, config encoding (`encodeProjectConfigToJson`/`Toml`), sparse-config defaults (`getDefaultProjectConfig`, `omitDefaultValues`, `subtractProjectConfig`), and the error classes. No file IO, no Effect-returning function, and no `@effect/platform-*`/`node:`/`bun:` module anywhere in its transitive import graph — enforced by `entrypoint-purity.unit.test.ts`, which statically walks the real relative import graph and asserts it against a hardcoded allowlist (so both additions and removals to the pure surface are a deliberate review event).
- `@supabase/config/io` — a Promise-based file-IO facade for non-Effect consumers, built once (a process-lifetime singleton `ManagedRuntime`) from `makeProjectConfigIo` over a narrow `FileSystem | Path` platform layer. Resolved via package.json `exports` conditions, matched in this order: `"bun"` → `./src/bun.ts` (`@effect/platform-bun`'s `BunFileSystem`/`BunPath`), `"node"` → `./src/node.ts` (`@effect/platform-node`'s `NodeFileSystem`/`NodePath`), `"browser"` → `./src/io-browser.ts` (a stub that throws — there is no browser-safe file IO), `"default"` → `./src/node.ts`. `./io` has zero internal consumers by design: it exists solely for external Node/Bun code that isn't Effect-native.
- `@supabase/config/effect` — the Effect-native superset: re-exports everything from `.` plus the Effect-returning config-loading/saving programs (`loadProjectConfig`, `saveProjectConfig`, `loadProjectConfigFile`, `configJsonPath`/`configTomlPath`), the `ProjectConfigStore` service and `projectConfigStoreLayer`, project-environment resolution, and functions-manifest inference. Every consumer inside this monorepo that needs any Effect-native symbol imports it from `./effect`; a consumer that only needs pure symbols imports from `.` instead — never a package-internal file directly.
- `@supabase/config/schema.json` — the generated JSON Schema for `ProjectConfig`, a `dist/` build output.

`effect` is a peer dependency, not a regular one. A service's runtime identity in Effect v4 is its string key (e.g. `ProjectConfigStore`'s `"@supabase/config/ProjectConfigStore"`), not object/`Context.Tag` identity, so a duplicated `effect` copy would still resolve the service correctly by key — that is not the reason. The real reasons: (a) `effect` is still at `rc`, and its internals churn release to release, so a consumer's dependency graph ending up with two different `effect` `rc` versions risks subtle internal incompatibilities even though cross-copy service lookup itself survives; (b) a peer keeps `effect` deduped and out of this package's own bundle, which matters for a library this size; (c) the consumer owns which `effect` version it runs, rather than having one pinned transitively through `@supabase/config`. `@effect/platform-bun`/`@effect/platform-node` are optional peers — only `./io` needs a concrete platform implementation, a given consumer only ever runs on one of Bun or Node, and requiring both unconditionally would be dead weight for whichever runtime isn't in use.

## Related Decisions

- [ADR 0003](0003-self-documenting-cli.md): Self-Documenting CLI — doc generation from config schema
- [ADR 0004](0004-cli-design-goals-and-workflows.md): CLI Design Goals — config as project manifest
- [ADR 0006](0006-environment-management.md): Environment Management — `env()` syntax, `environments` block
- [ADR 0018](0018-sparse-config-subtraction.md): Sparse Config Subtraction — the pure subtraction core exported from `.`

## See Also

- [CLI-2231](https://linear.app/supabase/issue/CLI-2231) — refactor `@supabase/config` into the three-entrypoint (`.`/`./io`/`./effect`) contract decided above
