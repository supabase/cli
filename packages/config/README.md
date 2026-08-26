# @supabase/config

Supabase project configuration package built on Effect V4 Schema — owns the canonical `CliConfig`
document schema, config file loading/saving, and JSON Schema generation.

It owns:

- the canonical `CliConfig` schema
- the `CliConfigStore` Effect service for config IO
- JSON Schema generation at `@supabase/config/schema.json`
- config file loading/saving for `supabase/config.json`
- backward-compatible TOML support for `supabase/config.toml`

## Naming

- `CliConfig` — the config _document_ (`supabase/config.toml`/`.json`) — the full local superset
  the CLI reads and writes.
- `ProjectConfig` — the hosted-project subset: a sparse overlay of the hosted sections (api, auth,
  db, realtime, storage, workers, experimental) describing what a Supabase project looks like on
  the platform. Introduced by CLI-2230: produced by `toProjectConfig` from either a `CliConfig`
  document or a Management API response — see "ProjectConfig mapping" below.
- `CliSettings` — the CLI's own runtime settings; lives in `apps/cli`, not this package.

Use the `Cli*` prefix for the local checkout side and a bare `Project*` name for the hosted
Supabase project. Helpers that operate on config values follow the config family regardless of
their inputs (`resolveCliConfigValue`, `MissingCliConfigValueError`). See
[ADR 0020](../../docs/adr/0020-config-naming-vocabulary.md) for the full decision record.

## Entrypoints

- `@supabase/config` — pure, browser/edge-safe surface: the `CliConfig` schema and types,
  config encoding, sparse-config defaults, and errors. No file IO, no Effect-returning functions.
- `@supabase/config/io` — Promise-based file-IO facade for non-Effect consumers. The bun/node
  implementation is picked automatically via package.json exports conditions. Requires installing
  exactly one of the optional platform peers — `@effect/platform-bun` under Bun, `@effect/platform-node`
  under Node — and is unavailable in browser bundles (the `browser` condition resolves to a stub that
  throws); use `@supabase/config` there instead.
- `@supabase/config/effect` — Effect-native superset of `@supabase/config`, adding the
  `CliConfigStore` service, `cliConfigStoreLayer`, and other Effect programs (config
  loading/saving, project env resolution, functions manifest inference).
- `@supabase/config/schema.json` — generated JSON Schema for `CliConfig`.

## ProjectConfig mapping

The hosted-project subset — `ProjectConfig` — and its normalizers live on the pure entrypoint
(`@supabase/config`), so the CLI and Studio share one implementation:

- `toProjectConfig(source)` — thin dispatcher over the two normalizers; pass `{ cliConfig }`
  or `{ apiResponse }`. Throws `ProjectConfigParseError` when `source` carries neither own key
  or both.
- `fromConfigDocument(cliConfig)` — projection of a `CliConfig` document (or any
  `EffectiveConfig`): keeps the hosted sections (`api`, `auth`, `db`, `realtime`, `storage`,
  `workers`, `experimental`), drops local-only ones. Hosted sections are copied at field
  granularity, omitting every `x-secret` leaf, and every duration/byte-size field a mapping
  row canonicalizes (e.g. a document's `"24h"` becomes `"24h0m0s"`, matching what the API side
  would emit for the same logical value) — parity with `fromApiProjectConfig`'s own secret
  omission and canonical spellings.
- `fromApiProjectConfig(input)` — translation of a Management API v2 project-config response
  (the full envelope, its `data` object, or bare `data.attributes`): registry-driven renames, boolean inversions, and
  unit conversions; lenient toward API keys this package version doesn't know; secret fields
  omitted (the API reports HMAC digests, never plaintext). Attaches a deep-cloned, deep-frozen
  copy of the raw attributes as a non-enumerable `_apiResponse` — invisible to encodes and
  structural walks, never persisted (ADR 0019). Both normalizers throw `ProjectConfigParseError`
  on malformed API input (a bad envelope, a mapped field of the wrong type, or an unparseable
  schema-decode failure).
- `unmappedApiFields(projectConfig)` — the API fields this package version doesn't map,
  derived from the same mapping registry.
- `attachApiResponse(projectConfig, rawAttributes)` — re-attaches `_apiResponse` after a
  spread/`structuredClone`/state-store round-trip already dropped it.
- `comparableProjectConfigPaths` / `isComparableProjectConfigPath(path)` — the registry-derived
  field paths `fromApiProjectConfig` can actually speak for, so a diff consumer restricts its
  comparison instead of hand-maintaining an equivalent field list.

`ProjectConfig` is sparse by design: it carries only what its source actually said, so it
composes with `subtractCliConfig`/`omitDefaultValues` (operand type `EffectiveConfig`) without
fabricating drift from schema defaults. Diffing two independently-sourced `ProjectConfig`s (a
remote response against a local document, rather than either against schema defaults) still needs
restricting to `comparableProjectConfigPaths`/`isComparableProjectConfigPath` — and at LEAF-path
granularity: `isComparableProjectConfigPath` takes a full path like
`["auth", "email", "smtp", "enabled"]`, not a top-level section name, so filtering
`Object.entries(overlay)` (section names only) restricts nothing.

```ts
import {
  subtractCliConfig,
  toProjectConfig,
  isComparableProjectConfigPath,
} from "@supabase/config";

const remote = toProjectConfig({ apiResponse }); // Management API v2 project-config response
const local = toProjectConfig({ cliConfig }); // decoded supabase/config.toml document

// `overlay` is what `local` says that `remote` doesn't already agree with.
const overlay = subtractCliConfig(local, remote);

// Restrict to individual LEAF paths — see the granularity note above.
function leafPaths(
  value: unknown,
  prefix: ReadonlyArray<string> = [],
): ReadonlyArray<ReadonlyArray<string>> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      leafPaths(child, [...prefix, key]),
    );
  }
  return [prefix];
}

const restrictedDrift = leafPaths(overlay).filter(isComparableProjectConfigPath);
// e.g. [["api", "schemas"], ["api", "max_rows"], ["auth", "site_url"]] — the fields `local`
// DECLARES that `remote` doesn't already agree with, restricted to what `fromApiProjectConfig`
// can actually speak for.
```

This example computes **one direction** of a drift check: values the local document declares that
differ from the remote. It does not surface remote-only settings — a field the API maps
unconditionally (e.g. `auth.email.smtp.enabled`) where the local document never declared the
subsection produces no leaf in this overlay at all. Finding those needs the reverse subtraction
(`subtractCliConfig(remote, local)`) intersected with the paths the document-side operand actually
declares, per the comparison contract on the `ProjectConfig` docstring — the comparable-path set
only says which paths the API mapper can represent, not which ones a given document spoke for. A
complete two-sided drift computation is `config diff`'s job (CLI-2156); this example is its
building block, not a substitute.

## Usage

```ts
import {
  CliConfigSchema,
  CliConfigStore,
  cliConfigStoreLayer,
  type CliConfig,
} from "@supabase/config/effect";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";

const layer = cliConfigStoreLayer.pipe(Layer.provide(BunServices.layer));

const loaded = await Effect.runPromise(
  Effect.gen(function* () {
    const store = yield* CliConfigStore;
    return yield* store.load(process.cwd());
  }).pipe(Effect.provide(layer)),
);
```

For convenience entrypoints at the runtime edge:

```ts
import { loadCliConfig } from "@supabase/config/io";
```

For lazy `env(NAME)` resolution, load project env separately and resolve only the value or subtree you need:

```ts
import { loadCliProjectEnvironment, resolveCliConfigSubtree } from "@supabase/config/effect";
```

When both `supabase/config.json` and `supabase/config.toml` exist in one project, JSON wins. Saves preserve the existing format when possible and default new config files to JSON.

## Architecture Docs

- [CLI config loading](./docs/cli-config-loading.md)

## Development

Repo-wide quality checks run from the repository root:

```sh
pnpm check:all
pnpm fix:all
```

Package-local checks and development commands run from `packages/config`:

```sh
pnpm types:check
pnpm run test        # Run tests
pnpm run build       # Generate dist/schema.json
```
