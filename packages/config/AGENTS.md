# @supabase/config

Supabase project configuration package built on Effect V4 Schema — owns the canonical
`CliConfig` schema, config file loading/saving, and JSON Schema generation.

## Entrypoints

Six supported import paths total (see ADR 0009's 2026-08-24 decision for the full rationale): four
module entrypoints (`.`, `./io`, `./effect`, `./internal`) plus two generated JSON Schema
artifacts (`./schema.json`, `./project-schema.json`).

- `@supabase/config` (`.`) — pure, browser/edge-safe surface. `CliConfigSchema`/`ProjectConfigSchema`
  and their derived types, config encoding, sparse-config defaults, the `ProjectConfig` converters
  (`toProjectConfig`, `fromConfigDocument`, `fromApiProjectConfig`, …), and error classes. No file
  IO, no Effect-returning function, no `@effect/platform-*`/`node:`/`bun:` module anywhere in its
  transitive import graph. `fromConfigDocument` also accepts a `CliConfigWithRawPresence` pair (a
  `CliConfig` alongside which keys were actually present in the source document) — presence matters
  because the schema defaults every optional section, so the decoded `CliConfig` alone can't tell
  "explicitly set to the default" from "never set" (ADR 0021). Call `unmappedApiFields` after
  `fromApiProjectConfig` if you care whether this package version understood the response.
- `@supabase/config/io` — a Promise-based file-IO facade for **external, non-Effect Node/Bun
  consumers only**. Resolved via package.json exports conditions (`bun`/`node`/`browser`/`default`).
  Has zero internal consumers by design — nothing inside this monorepo should import it.
- `@supabase/config/effect` — the Effect-native superset. Re-exports everything from `.` plus the
  Effect-returning config-loading/saving programs, `CliConfigStore`/`cliConfigStoreLayer`,
  project-environment resolution, and `inferFunctionsManifest` (discovers and validates
  `supabase/functions/*` on disk).
- `@supabase/config/internal` (CLI-2234) — NOT covered by semver, and only `apps/cli` may import it
  (enforced by `src/monorepo-import-contract.unit.test.ts`). Exists solely for `apps/cli`'s own
  Go-parity call sites and contract-guard tests: `loadCliConfig`/`resolveCliConfigValue`/
  `resolveCliConfigSubtree` — the SAME runtime functions `./effect` exports, re-typed here to
  additionally accept the internal-only `goViperCompat` option (`InternalLoadCliConfigOptions`/
  `InternalResolveCliConfigOptions`) — plus the otherwise-internal registry data
  (`AUTH_HOOK_NAMES`, `unmappedSecretApiPaths`, `projectConfigMappingRows`,
  `ProjectConfigMappingRow`, `ProjectConfigApiAttributes`, `ENV_CAPTURE_REGEX`). Anything here can
  change or vanish in any release.
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
  its public specifier (`.`/`./effect`). Enforced: every `@supabase/config/internal` occurrence
  outside this package must be under `apps/cli/`.
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

1. Removes any stale `dist/` (a rename that leaves an orphaned compiled module behind must not
   ship), then compiles `src/` to `dist/` (`tsc -p tsconfig.build.json`) — the `.js`/`.d.ts` output
   every `dist`/`types`/`default` export condition points at.
2. Renders both generated JSON Schema artifacts (`dist/schema.json`, `dist/project-schema.json`)
   from `toCliConfigJsonSchema()`/`toProjectConfigJsonSchema()`, post-processed (via
   `scripts/json-schema-postprocess.ts`) to collapse Effect's non-finite-number `anyOf` encoding
   back to a plain `number`/`integer` node and to add `$id`/`title`/`description`, then formatted
   through `oxfmt`.
3. Verifies every `types`/non-`bun` `default` target (plus both JSON artifacts) declared in
   package.json's `exports` map actually exists on disk.
4. Runs a tree-shake probe: bundles a probe importing only `CliConfigSchema` from the compiled
   `dist/index.js` for a `browser` target and asserts the output excludes registry-only code,
   proving the package.json `sideEffects: false` claim against real compiled output rather than
   merely asserting it — plus a positive-control probe (bundling `projectConfigMappingRows` from
   `dist/internal.js`) proving the registry-only marker is actually detectable by this bundling
   method before trusting its absence elsewhere as meaningful.
5. Runs a pack-and-install smoke test: `npm pack`s the real publish tarball (governed by `files`/
   `.npmignore` — the exact thing `npm publish` would ship), extracts it into a fresh, isolated
   consumer project, symlinks in the real, already pnpm-resolved runtime deps (network-free), and
   imports every entrypoint and JSON artifact through a real `node` process — catching `files`/
   `exports` drift a workspace-link smoke test or a `tsc`-only build would miss entirely.

`dist/` is gitignored and rebuilt on demand — no build output is checked in. The public type
surface is instead enforced per-PR by export snapshots and purity walkers (see "Testing" below)
plus the repo-root `pnpm check:config-api` (`tools/config-api-compare.ts`), which diffs this
package's declaration output between the PR base and head commits and is advisory at PR time. A
release-time tarball diff is planned under CLI-2233 as the hard gate.

### Publishing the tarball (CLI-2234)

A `.npmignore` file exists at this package's root — even though its own rules exclude almost
nothing `files` in package.json doesn't already exclude — because npm's packlist walk otherwise
falls back to the ROOT `.gitignore` for this whole directory, and that file's bare `dist` line
prunes `packages/config/dist/` from the walk entirely before `files` is ever consulted, silently
shipping a tarball with zero `dist/**` files. An `.npmignore`'s mere presence (regardless of
content) stops npm from consulting `.gitignore` at all; `files` still governs what actually ships.
Verify `npm pack --dry-run` and `pnpm pack --dry-run` produce equivalent content after touching
either file.

## Testing

Run tests from this package with `bun --bun vitest run --project unit` (plain `node` vitest is
broken here). Always run the relevant unit tests for what you changed before considering a task
done. Besides ordinary behavioral coverage, three tests enforce this package's own contracts and
must stay green after any entrypoint or type-surface change:

- `src/entrypoint-purity.unit.test.ts` — the pure-graph invariant above (also walked separately for
  `src/io-browser.ts`, the `browser` condition target for `./io`), plus pinned export-name
  snapshots for `.`/`./effect`/`./internal` and the package.json `exports` map shape.
- `src/monorepo-import-contract.unit.test.ts` — the "Monorepo import rule" above: no internal
  `./io` consumer, no deep `@supabase/config/src/*` import, and no `@supabase/config/internal`
  import outside `apps/cli/` — scanning `apps/` and `packages/` while excluding this package's own
  directory.
- `src/lib/resolve.unit.test.ts` — behavioral coverage of the public sync resolvers.
- `scripts/json-schema-postprocess.unit.test.ts` / `scripts/build-artifacts.unit.test.ts` — the
  JSON Schema post-processing `renderJsonSchema` applies (non-finite-number `anyOf` collapse,
  `$id`/`title`/`description`), the second against the real generated documents.
