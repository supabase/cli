# @supabase/config

Supabase project configuration package built on Effect V4 Schema.

It owns:

- the canonical `ProjectConfig` schema
- the `ProjectConfigStore` Effect service for config IO
- JSON Schema generation at `@supabase/config/schema.json`
- config file loading/saving for `supabase/config.json`
- backward-compatible TOML support for `supabase/config.toml`

## Entrypoints

- `@supabase/config` — pure, browser/edge-safe surface: the `ProjectConfig` schema and types,
  config encoding, sparse-config defaults, and errors. No file IO, no Effect-returning functions.
- `@supabase/config/io` — Promise-based file-IO facade for non-Effect consumers. The bun/node
  implementation is picked automatically via package.json exports conditions. Requires installing
  exactly one of the optional platform peers — `@effect/platform-bun` under Bun, `@effect/platform-node`
  under Node — and is unavailable in browser bundles (the `browser` condition resolves to a stub that
  throws); use `@supabase/config` there instead.
- `@supabase/config/effect` — Effect-native superset of `@supabase/config`, adding the
  `ProjectConfigStore` service, `projectConfigStoreLayer`, and other Effect programs (config
  loading/saving, project env resolution, functions manifest inference).
- `@supabase/config/schema.json` — generated JSON Schema for `ProjectConfig`.

## Usage

```ts
import {
  ProjectConfigSchema,
  ProjectConfigStore,
  projectConfigStoreLayer,
  type ProjectConfig,
} from "@supabase/config/effect";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";

const layer = projectConfigStoreLayer.pipe(Layer.provide(BunServices.layer));

const loaded = await Effect.runPromise(
  Effect.gen(function* () {
    const store = yield* ProjectConfigStore;
    return yield* store.load(process.cwd());
  }).pipe(Effect.provide(layer)),
);
```

For convenience entrypoints at the runtime edge:

```ts
import { loadProjectConfig } from "@supabase/config/io";
```

For lazy `env(NAME)` resolution, load project env separately and resolve only the value or subtree you need:

```ts
import { loadProjectEnvironment, resolveProjectSubtree } from "@supabase/config/effect";
```

When both `supabase/config.json` and `supabase/config.toml` exist in one project, JSON wins. Saves preserve the existing format when possible and default new config files to JSON.

## Architecture Docs

- [Project config loading](./docs/project-config-loading.md)

## Development

```sh
pnpm run check:all   # Run all quality checks in parallel
pnpm run fix:all     # Auto-fix lint, format, and unused exports in parallel
pnpm run test        # Run tests
pnpm run build       # Generate dist/schema.json
```
