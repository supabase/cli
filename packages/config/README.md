# @supabase/config

Supabase project configuration package built on Effect V4 Schema — owns the canonical `CliConfig`
document schema, config file loading/saving, and JSON Schema generation.

> `CliConfig` is the config _document_ (`supabase/config.toml`/`.json`) — the full local
> superset the CLI reads and writes. `ProjectConfig` is reserved for the hosted-project
> subset (not implemented yet). `CliSettings` is the CLI's own runtime settings and lives
> in the CLI, not this package.

It owns:

- the canonical `CliConfig` schema
- the `CliConfigStore` Effect service for config IO
- JSON Schema generation at `@supabase/config/schema.json`
- config file loading/saving for `supabase/config.json`
- backward-compatible TOML support for `supabase/config.toml`

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
