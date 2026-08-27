# @supabase/config

Supabase project configuration package built on Effect V4 Schema — the config-file document model
(`CliConfig`), the hosted-project subset (`ProjectConfig`), schema-backed parsing, validation, and
encoding, defaults and sparse-diff helpers, and the converters between the local and hosted
representations.

It owns:

- the canonical `CliConfig` schema for `supabase/config.toml`/`supabase/config.json`
- the `CliConfigStore` Effect service for config file IO, and a Promise-based facade over it
- the `ProjectConfig` hosted-project subset and its converters to/from a `CliConfig` document or a
  Management API v2 project-config response
- `ProjectConfigSchema`, a runtime-validating companion to `ProjectConfig`
- JSON Schema generation for both shapes, at `@supabase/config/schema.json` and
  `@supabase/config/project-schema.json`

## Naming

- `CliConfig` — the config _document_ (`supabase/config.toml`/`.json`) — the full local superset
  the CLI reads and writes.
- `ProjectConfig` — the hosted-project subset: a sparse overlay of the hosted sections (`api`,
  `auth`, `db`, `realtime`, `storage`, `workers`, `experimental`) describing what a Supabase
  project looks like on the platform. Produced by `toProjectConfig` from either a `CliConfig`
  document or a Management API response — see "ProjectConfig: producing and validating values"
  below.
- `CliSettings` — the CLI's own runtime settings; lives in `apps/cli`, not this package.

Use the `Cli*` prefix for the local checkout side and a bare `Project*` name for the hosted
Supabase project. Config-value helpers follow the config family regardless of their inputs
(`resolveCliConfigValue`, `MissingCliConfigValueError`). See
[ADR 0020](../../docs/adr/0020-config-naming-vocabulary.md) and
[docs/cli-config-loading.md](./docs/cli-config-loading.md) for the full vocabulary.

## Entrypoints

| Entrypoint              | Contents                                                                                                                                                   | Constraints                                                                                                                                                                                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.`                     | `CliConfigSchema`/`ProjectConfigSchema` and their types, config encoding, sparse-config defaults, the `ProjectConfig` converters, error classes            | Pure — browser/edge/Node/Bun-safe. No file IO, no Effect-returning function, no `@effect/platform-*`/`node:`/`bun:` module anywhere in its transitive import graph                                                                                                                                     |
| `./io`                  | A Promise-based facade over the same file-IO/Effect programs as `./effect`                                                                                 | Resolved automatically via package.json export conditions (`bun`/`node`/`browser`/`default`). Requires one of the optional platform peers — `@effect/platform-bun` under Bun, `@effect/platform-node` under Node — installed at runtime; see "Installing" below for the failure mode when it's missing |
| `./effect`              | Effect-native superset of `.`: `CliConfigStore`/`cliConfigStoreLayer`, config loading/saving, project-environment resolution, functions-manifest inference | Requires `effect`; requires a platform peer only for the file-IO programs, exactly like `./io`                                                                                                                                                                                                         |
| `./internal`            | `apps/cli`'s Go-parity typings (`goViperCompat`) and the internal API-mapping registry data                                                                | **Not covered by semver.** Exists solely for the Supabase CLI's own use and its contract-guard tests — any export here (its existence, shape, or behavior) can change or vanish in any release without notice                                                                                          |
| `./schema.json`         | Generated JSON Schema for `CliConfig`                                                                                                                      | Draft 2020-12 — a language-agnostic contract for non-TypeScript consumers                                                                                                                                                                                                                              |
| `./project-schema.json` | Generated JSON Schema for `ProjectConfig`                                                                                                                  | Draft 2020-12 — a language-agnostic contract for non-TypeScript consumers                                                                                                                                                                                                                              |

A few things worth calling out beyond the table:

- **`./io`'s member names mirror `./effect`'s one-to-one** (`loadCliConfig`, `saveCliConfig`,
  `loadCliConfigFile`, `findCliProjectRoot`, `findCliProjectPaths`, `loadCliProjectEnvironment`,
  `inferFunctionsManifest`) — the subpath itself conveys Promise-vs-Effect, not the member name.
  In a browser bundle, `./io` resolves to a stub whose exports throw a curated error only when
  actually invoked (never at import time), directing you back to `.`.
- **`./effect` deliberately shadows two names from `.`.** `resolveCliConfigValue` and
  `resolveCliConfigSubtree` exist on both `.` (plain, synchronous — throws instead of failing an
  `Effect`) and `./effect` (Effect-typed). Because explicit named exports win over a star
  re-export of the same name, importing from `./effect` always gets you the Effect-typed variant,
  even though `./effect` also re-exports everything else from `.` verbatim.
- **`./internal` is genuinely unstable.** It is not merely undocumented — it is explicitly outside
  this package's compatibility promise (see "Semver and the published contract" below).

## Installing

This package is not yet published (`private: true`; publishing is tracked separately). Once it
is, install it alongside the peers your runtime needs:

```sh
npm install @supabase/config effect
```

`effect` is a required peer dependency. `@effect/platform-bun` and `@effect/platform-node` are
optional peers — install exactly one, matching your runtime, if you use `./io` or `./effect`'s
file-IO programs:

| Consumer                                       | Required peers                    |
| ---------------------------------------------- | --------------------------------- |
| Pure / browser / edge (`.` only, no file IO)   | `effect`                          |
| Node (`./io` or `./effect`'s file-IO programs) | `effect`, `@effect/platform-node` |
| Bun (`./io` or `./effect`'s file-IO programs)  | `effect`, `@effect/platform-bun`  |

Under the `node`/`bun` export conditions, the matching platform peer is imported eagerly at module
load. A missing peer surfaces as a raw module-resolution error (e.g. `Cannot find package
'@effect/platform-node'`) the first time something imports `./io` or `./effect` — not a curated
message — so install the peer for your runtime before importing either subpath. The `browser`
condition is the one exception: it needs no platform peer, since it resolves to a stub that throws
its own curated error only when invoked (see "Entrypoints" above).

## ProjectConfig: producing and validating hosted-project values

The hosted-project subset — `ProjectConfig` — and its converters live on the pure entrypoint
(`.`), so any TypeScript consumer can produce or compare `ProjectConfig` values without file IO or
Effect:

- `toProjectConfig(source)` — thin dispatcher over the two normalizers below; pass `{ cliConfig }`
  or `{ apiResponse }`. Throws `ProjectConfigParseError` when `source` carries neither key or both.
- `fromConfigDocument(cliConfig)` — projection of a `CliConfig` document (or any `EffectiveConfig`)
  onto the hosted sections (`api`, `auth`, `db`, `realtime`, `storage`, `workers`, `experimental`),
  omitting every `x-secret` leaf and canonicalizing duration/byte-size fields the same way the API
  side would. **Not a verbatim rendering of the document** — see
  [ADR 0021](../../docs/adr/0021-projectconfig-convergence-semantics.md) for the push-precedence
  and sentinel-pruning semantics this applies.
- `fromApiProjectConfig(input)` — translation of a Management API v2 project-config response (the
  full envelope, its `data` object, or bare `data.attributes`) via registry-driven renames,
  boolean inversions, and unit conversions; lenient toward API keys this package version doesn't
  yet know, and never reports a secret field's plaintext. Attaches a deep-frozen copy of the raw
  attributes as a non-enumerable `_apiResponse` (invisible to encodes and structural walks, never
  persisted — see [ADR 0019](../../docs/adr/0019-config-api-response-passthrough.md)). Throws
  `ProjectConfigParseError` on malformed input.
- `unmappedApiFields(projectConfig)` — the API fields this package version doesn't map, derived
  from the same mapping registry.
- `attachApiResponse(projectConfig, rawAttributes)` — re-attaches `_apiResponse` after a
  spread/`structuredClone`/state-store round-trip already dropped it.
- `comparableProjectConfigPaths` / `isComparableProjectConfigPath(path)` — the registry-derived
  field paths `fromApiProjectConfig` can actually speak for, so a diff consumer restricts its
  comparison instead of hand-maintaining an equivalent field list.

```ts
import { fromApiProjectConfig, fromConfigDocument, toProjectConfig } from "@supabase/config";

const remote = toProjectConfig({ apiResponse }); // Management API v2 project-config response
const local = toProjectConfig({ cliConfig: someCliConfig });
```

### `ProjectConfigSchema`: runtime validation as another option

For a consumer that already holds a well-typed `ProjectConfig` (produced by the converters above),
that's the whole story. A consumer that instead receives untrusted or serialized data — a value
read back from storage, sent over the wire, or produced by a third party — can validate it against
`ProjectConfigSchema` instead:

```ts
import { ProjectConfigSchema } from "@supabase/config";

const result = await ProjectConfigSchema["~standard"].validate(candidate);
if (result.issues) {
  // reject `candidate` — see the Standard Schema v1 spec for the `issues` shape
}
```

`ProjectConfigSchema` is a full Effect `Schema.Codec` (usable with `Schema.decodeUnknownEffect`
and friends) **and** a spec-compliant [Standard Schema v1](https://standardschema.dev/) object
(`~standard`) at the same time — `Schema.toStandardSchemaV1` augments and returns the same value
rather than wrapping it, so it works with any library that accepts a `~standard`-compatible
schema, not only Effect code.

`ProjectConfigSchema` is derived from `CliConfigSchema`, never hand-declared, which gives it a
specific, narrower validation contract — what it does and does not promise:

- **Hosted sections only** — the same seven sections `ProjectConfig` itself carries; nothing else
  validates.
- **Deeply optional** — every key at every level is optional, mirroring `ProjectConfig`'s own
  `DeepPartial` shape, so a sparse fragment like `{ auth: { email: { smtp: { enabled: true } } } }`
  validates even without whatever sibling fields would otherwise be required.
- **`x-secret` leaves removed** — no secret-marked field exists in this schema at all, matching
  the converters' own secret-omission behavior.
- **Cross-field checks stripped** — whole-struct business-rule refinements from the base schema
  (e.g. "if `enabled`, then `host` is required") are removed, since a deliberately sparse overlay
  can legitimately violate them.
- **Arrays are not deep-partialized** — an array field's element type is left untouched, matching
  `ProjectConfig`'s own array handling.
- **Permissive, not closed** — never `additionalProperties: false`; an unrecognized own key (from
  a schema version ahead of this package) is accepted, not rejected.
- **`_apiResponse` is out of scope** — it's a non-enumerable property, invisible to both decode and
  validation.

## `./io`'s error contract

A rejected `loadCliConfig`, `loadCliConfigFile`, or `saveCliConfig` call from `./io` can reject
with any of:

- `CliConfigParseError` — a malformed `supabase/config.toml`/`.json`
- `DuplicateRemoteProjectIdError` — two `[remotes.*]` blocks declare the same `project_id`
- `InvalidRemoteProjectIdError` — a `[remotes.*]` block's `project_id` isn't a valid project ref
- `CliProjectEnvParseError` — a malformed `.env`/`.env.local` file
- `PlatformError` (from `effect/PlatformError`) — a host/OS failure surfaced by the underlying
  `FileSystem` service

Every one of these is a plain class (an Effect `Data.TaggedError`), so a catch block can
distinguish them with `instanceof`:

```ts
import { CliConfigParseError, DuplicateRemoteProjectIdError } from "@supabase/config";
import { loadCliConfig } from "@supabase/config/io";

try {
  const loaded = await loadCliConfig(process.cwd());
} catch (error) {
  if (error instanceof CliConfigParseError) {
    // malformed config.toml/config.json
  } else if (error instanceof DuplicateRemoteProjectIdError) {
    // two [remotes.*] blocks claim the same project_id
  }
  throw error;
}
```

## Semver and the published contract

The runtime export surface of `.`, `./io`, and `./effect`, plus the two generated JSON Schema
artifacts (`./schema.json`, `./project-schema.json`), is this package's published contract.
`./internal` carries no such guarantee. See [AGENTS.md](./AGENTS.md) for how that contract is
enforced (export-surface snapshots and a checked-in API report).

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

For lazy `env(NAME)` resolution, load project env separately and resolve only the value or subtree
you need:

```ts
import { loadCliProjectEnvironment, resolveCliConfigSubtree } from "@supabase/config/effect";
```

When both `supabase/config.json` and `supabase/config.toml` exist in one project, JSON wins. Saves
preserve the existing format when possible and default new config files to JSON.

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
pnpm run build       # Compile dist/, generate schema.json/project-schema.json, sync api-report/
```

See [AGENTS.md](./AGENTS.md) for the build pipeline and contract-enforcement details.
