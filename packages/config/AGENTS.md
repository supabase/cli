# @supabase/config

Supabase project configuration package built on Effect V4 Schema — owns the canonical
`CliConfig` schema, config file loading/saving, and JSON Schema generation.

## Entrypoints

Four entrypoints plus two generated JSON Schema artifacts (see ADR 0009's 2026-08-24 decision for
the full rationale):

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
- `@supabase/config/internal` (CLI-2234) — NOT covered by semver. Exists solely for `apps/cli`'s
  own Go-parity call sites and contract-guard tests: the internal-only `goViperCompat` typings
  (`InternalLoadCliConfigOptions`/`InternalResolveCliConfigOptions`) and the otherwise-internal
  registry data (`AUTH_HOOK_NAMES`, `unmappedSecretApiPaths`, `projectConfigMappingRows`,
  `ProjectConfigMappingRow`, `ProjectConfigApiAttributes`, `ENV_CAPTURE_REGEX`). Unlike `./io`,
  `apps/cli` IS an expected consumer of this subpath. Anything here can change or vanish in any
  release.
- `@supabase/config/schema.json` — generated JSON Schema (draft 2020-12) for `CliConfig` (a
  `dist/` build output).
- `@supabase/config/project-schema.json` (CLI-2234) — generated JSON Schema (draft 2020-12) for
  `ProjectConfig`, derived from `ProjectConfigSchema` (`src/project-config/project-schema.ts`); a
  `dist/` build output alongside `schema.json`.

## Monorepo import rule

- A file anywhere in this monorepo that needs **any** Effect-native symbol (the `CliConfigStore`
  service, `loadCliConfig`/`saveCliConfig`, project-environment resolution, functions-manifest
  inference, etc.) imports everything it needs from `@supabase/config/effect` — never mix that with
  importing the same package's default entrypoint in the same file.
- A file that needs only pure symbols (the schema, types, encoding, sparse defaults, errors) imports
  from `@supabase/config`.
- `@supabase/config/io` is exclusively for external consumers outside this monorepo that aren't
  Effect-native. Do not add an internal consumer of it.
- `@supabase/config/internal` is for `apps/cli`'s own Go-parity call sites and contract-guard
  tests only — a symbol that needs the internal-only `goViperCompat` typings, or the internal
  registry data, imports it from there; every other symbol in the same import statement stays on
  its public specifier (`.`/`./effect`).
- Never deep-import this package's internals (e.g. `@supabase/config/src/io.ts`). Only the six
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

## Build (CLI-2232)

`pnpm --filter @supabase/config build` (or `pnpm run build` from this package) runs
`scripts/build.ts`, in order:

1. Compiles `src/` to `dist/` (`tsc -p tsconfig.build.json`) — the `.js`/`.d.ts` output every
   `dist`/`types`/`default` export condition points at.
2. Renders both generated JSON Schema artifacts (`dist/schema.json`, `dist/project-schema.json`)
   from `toCliConfigJsonSchema()`/`toProjectConfigJsonSchema()`, formatted through `oxfmt`.
3. Runs a tree-shake probe: bundles a probe importing only `CliConfigSchema` from the compiled
   `dist/index.js` for a `browser` target and asserts the output excludes registry-only code,
   proving the package.json `sideEffects: false` claim against real compiled output rather than
   merely asserting it.
4. Syncs `api-report/` — a declarations-only build (`tsconfig.api-report.json`) mirrored into the
   checked-in `api-report/` directory. `src/api-report.unit.test.ts` regenerates the same build and
   diffs it against that mirror, so any type-surface change anywhere in `src/` shows up as a
   reviewable `api-report/` diff instead of passing silently — commit that diff whenever it appears.
5. Runs a Node-consumer smoke test (from `apps/cli`, the one in-repo workspace that depends on this
   package through a real `node_modules` link) that imports every entrypoint and JSON artifact
   through the `node` export condition, catching a broken `exports` map or dist resolution that a
   `tsc`-only build wouldn't.

`dist/` is gitignored and rebuilt on demand; `api-report/` is the one build output that is checked
in. Re-run the build and commit the resulting `api-report/` diff whenever a change touches this
package's public type surface.

## Testing

Run tests from this package with `bun --bun vitest run --project unit` (plain `node` vitest is
broken here). Always run the relevant unit tests for what you changed before considering a task
done. Besides ordinary behavioral coverage, three tests enforce this package's own contracts and
must stay green after any entrypoint or type-surface change:

- `src/entrypoint-purity.unit.test.ts` — the pure-graph invariant above, plus pinned export-name
  snapshots for `.`/`./effect`/`./internal` and the package.json `exports` map shape.
- `src/api-report.unit.test.ts` — the checked-in `api-report/` mirror described above.
- `src/monorepo-import-contract.unit.test.ts` — the "Monorepo import rule" above (no internal
  `./io` consumer, no deep `@supabase/config/src/*` import), scanning `apps/` and `packages/`
  while excluding this package's own directory.
