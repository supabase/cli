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
fabricating drift from schema defaults.

```ts
import {
  subtractCliConfig,
  toProjectConfig,
  isComparableProjectConfigPath,
} from "@supabase/config";

const remote = toProjectConfig({ apiResponse }); // or { cliConfig } for a local document
const overlay = subtractCliConfig(remote, remote);
const restrictedDrift = Object.fromEntries(
  Object.entries(overlay).filter(([key]) => isComparableProjectConfigPath([key])),
);
```

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
