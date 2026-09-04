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

## Installing

```sh
npm install @supabase/config effect@rc
```

```ts
import { getDefaultCliConfig, toProjectConfig } from "@supabase/config";

// Project a config document onto the hosted-project subset — here the
// schema-derived default document; a real caller would load one with
// `loadCliConfig` from `@supabase/config/io` (see "Usage" below).
const projectConfig = toProjectConfig({ cliConfig: getDefaultCliConfig() });
```

Install it alongside the peers your runtime needs.

This package requires Effect 4.x, currently only published under the `rc` dist-tag — `effect@latest`
still resolves to 3.x, which will not satisfy this package's peer range.

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
its own curated error only when invoked (see "Entrypoints" below).

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
(`resolveCliConfigValue`). See
[ADR 0020](https://github.com/supabase/cli/blob/develop/docs/adr/0020-config-naming-vocabulary.md)
and [docs/cli-config-loading.md](https://github.com/supabase/cli/blob/develop/packages/config/docs/cli-config-loading.md)
for the full vocabulary.

## Entrypoints

| Entrypoint              | Contents                                                                                                                                                                                                                                                                                                                                                                                                                        | Constraints                                                                                                                                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.`                     | `CliConfigSchema`/`ProjectConfigSchema` and their types, config encoding, sparse-config defaults, the `ProjectConfig` converters, the config-diff classification engine (`diffProjectConfig`), error classes                                                                                                                                                                                                                    | Pure — browser/edge/Node/Bun-safe. No file IO, no Effect-returning function, no `@effect/platform-*`/`node:`/`bun:` module anywhere in its transitive import graph                                                                                                                                         |
| `./io`                  | A Promise-based facade over the same file-IO/Effect programs as `./effect`                                                                                                                                                                                                                                                                                                                                                      | Resolved automatically via package.json export conditions (`bun`/`node`/`browser`/`default`). Requires one of the optional platform peers — `@effect/platform-bun` under Bun, `@effect/platform-node` under Node — installed at runtime; see "Installing" below for the failure mode when it's missing     |
| `./effect`              | Effect-native superset of `.`: `CliConfigStore`/`cliConfigStoreLayer`, config loading/saving, project-environment resolution, functions-manifest inference                                                                                                                                                                                                                                                                      | Requires `effect`; requires a platform peer only for the file-IO programs, exactly like `./io`                                                                                                                                                                                                             |
| `./internal`            | `ENV_CAPTURE_REGEX`, `AUTH_HOOK_NAMES`, `unmappedSecretApiPaths`, `projectConfigMappingRows`, the `ProjectConfigMappingRow`/`ProjectConfigApiAttributes`/`InternalLoadCliConfigOptions` types, plus `loadCliConfig`/`resolveCliConfigValue`/`resolveCliConfigSubtree` re-typed to additionally accept the internal-only `goViperCompat` option — the SAME runtime functions `./effect` exports, not independent implementations | **Not covered by semver, and only `apps/cli` may import it** (enforced by `src/monorepo-import-contract.unit.test.ts`). Exists solely for the Supabase CLI's own use and its contract-guard tests — any export here (its existence, shape, or behavior) can change or vanish in any release without notice |
| `./schema.json`         | Generated JSON Schema for `CliConfig`                                                                                                                                                                                                                                                                                                                                                                                           | Draft 2020-12 — a language-agnostic contract for non-TypeScript consumers                                                                                                                                                                                                                                  |
| `./project-schema.json` | Generated JSON Schema for `ProjectConfig`                                                                                                                                                                                                                                                                                                                                                                                       | Draft 2020-12 — a language-agnostic contract for non-TypeScript consumers                                                                                                                                                                                                                                  |

A few things worth calling out beyond the table:

- **`./io`'s member names mirror `./effect`'s one-to-one** (`loadCliConfig`, `saveCliConfig`,
  `loadCliConfigFile`, `findCliProjectRoot`, `findCliProjectPaths`, `loadCliProjectEnvironment`,
  `inferFunctionsManifest`) — the subpath itself conveys Promise-vs-Effect, not the member name.
  In a browser bundle, `./io` resolves to a stub whose exports throw a curated error only when
  actually invoked (never at import time), directing you back to `.`.
- **`./effect` deliberately shadows two names from `.`.** `resolveCliConfigValue` and
  `resolveCliConfigSubtree` exist on both `.` (plain, synchronous) and `./effect` (Effect-typed).
  Neither has a failure mode — an unresolved `env(NAME)` reference is preserved verbatim rather
  than rejected or thrown. Because explicit named exports win over a star re-export of the same
  name, importing from `./effect` always gets you the Effect-typed variant, even though `./effect`
  also re-exports everything else from `.` verbatim.
- **`./internal` is genuinely unstable.** It is not merely undocumented — it is explicitly outside
  this package's compatibility promise (see "Semver and the published contract" below).

Bundle size, measured against the full `.` surface: ~390 KB minified (~110 KB minified+gzipped),
most of which is `effect`'s own schema/validation engine — an app that already bundles `effect`
adds closer to ~115 KB minified for this package's own code on top. A consumer that only needs the
shape contract, not runtime validation, can use `@supabase/config/schema.json`/`project-schema.json`
with any JSON Schema validator instead of importing this package at all.

### Exports at a glance (`.`)

Every runtime and type export of the pure `.` entrypoint, grouped by category:

**Schema/types**

| Export                                                       | What it is                                                                               |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `CliConfigSchema`                                            | The `CliConfig` Effect schema (decode/encode/validate).                                  |
| `CliConfig`                                                  | The decoded `CliConfig` type.                                                            |
| `CliConfigJson`                                              | The encoded (pre-decode) `CliConfig` JSON shape.                                         |
| `ConfigFormat`                                               | `"toml" \| "json"`.                                                                      |
| `LoadedCliConfig`                                            | The shape a successful `loadCliConfig`/`loadCliConfigFile`/`saveCliConfig` call returns. |
| `LoadCliConfigOptions`                                       | Public options accepted by `loadCliConfig`/`loadCliConfigFile`.                          |
| `CliConfigValueOrigin` / `CliConfigValueSource`              | Per-leaf provenance (`"local"`/`"remote"`/`"environment"`).                              |
| `SaveCliConfigOptions`                                       | Options accepted by `saveCliConfig`.                                                     |
| `FunctionsManifest` / `ResolvedFunctionConfig`               | The shape `inferFunctionsManifest` (`./effect`/`./io`) returns.                          |
| `LoadCliProjectEnvironmentOptions` / `CliProjectEnvironment` | Options for, and the merged env-map shape returned by, `loadCliProjectEnvironment`.      |
| `CliProjectPaths`                                            | The discovered project paths shape.                                                      |
| `ProjectConfig`                                              | The hosted-project subset shape.                                                         |
| `ProjectConfigSchema`                                        | Runtime-validating companion to `ProjectConfig` (see below).                             |
| `CliConfigWithRawPresence`                                   | A `CliConfig` + raw-presence pair `fromConfigDocument` also accepts (ADR 0021).          |
| `ReadonlyJsonValue`                                          | A JSON-safe, deeply readonly value type.                                                 |
| `ToProjectConfigSource`                                      | `toProjectConfig`'s discriminated `{ cliConfig }`/`{ apiResponse }` input.               |

**Env resolution & value provenance**

| Export                                              | What it is                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------- |
| `resolveCliConfigValue` / `resolveCliConfigSubtree` | Resolve/redact `env(NAME)` leaves; plain sync here, Effect-typed on `./effect`. |
| `ResolvedCliConfigValue<T>`                         | The resolved/redacted shape those two return.                                   |
| `cliConfigValueSourceAt`                            | Looks up a `LoadedCliConfig.valueOrigins` entry for one path.                   |

**Encoding**

| Export                                            | What it is                            |
| ------------------------------------------------- | ------------------------------------- |
| `encodeCliConfigToJson` / `encodeCliConfigToToml` | Serialize a `CliConfig` back to text. |

**Defaults & sparse diff**

| Export                                    | What it is                                          |
| ----------------------------------------- | --------------------------------------------------- |
| `getDefaultCliConfig`                     | The schema-derived default `CliConfig`.             |
| `omitDefaultValues` / `subtractCliConfig` | Strip-default helpers over an `EffectiveConfig`.    |
| `EffectiveConfig` / `SparseCliConfig`     | The operand/result types for the two helpers above. |

**ProjectConfig converters**

| Export                                                           | What it is                                                                                                                          |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `toProjectConfig`                                                | Dispatcher over the two normalizers below.                                                                                          |
| `fromConfigDocument`                                             | Projects a `CliConfig` (or `CliConfigWithRawPresence` pair) onto `ProjectConfig`.                                                   |
| `fromApiProjectConfig`                                           | Translates a Management API v2 project-config response into `ProjectConfig`.                                                        |
| `attachApiResponse`                                              | Re-attaches `_apiResponse` after a round-trip that dropped it.                                                                      |
| `unmappedApiFields`                                              | The API fields this package version doesn't map — call after `fromApiProjectConfig` if you care whether it understood the response. |
| `comparableProjectConfigPaths` / `isComparableProjectConfigPath` | Registry-derived field paths a diff consumer can safely compare.                                                                    |

**Config diff classification**

| Export                     | What it is                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `diffProjectConfig`        | Pure, synchronous classification between a local and remote `ProjectConfig` projection (see ADR 0022).        |
| `DiffProjectConfigOptions` | The `{ local, remote }` options `diffProjectConfig` accepts.                                                  |
| `ConfigChange`             | A single classified path-level difference.                                                                    |
| `ConfigChangeClass`        | `"update" \| "remote_only" \| "local_only"`.                                                                  |
| `ConfigChangeCounts`       | Per-class counts summarizing a `ConfigChangeSet`.                                                             |
| `ConfigChangeSet`          | `diffProjectConfig`'s result: classified changes plus the `masked`/`unmanaged` visibility buckets and counts. |

**JSON Schema generators + URLs**

| Export                                                | What it is                                                |
| ----------------------------------------------------- | --------------------------------------------------------- |
| `toCliConfigJsonSchema` / `toProjectConfigJsonSchema` | Render each shape's JSON Schema (draft 2020-12) document. |
| `CLI_CONFIG_SCHEMA_URL` / `PROJECT_CONFIG_SCHEMA_URL` | The `$id`/`$schema` URL for each generated document.      |

**Errors**

| Export                                                          | What it is                                                              |
| --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `CliConfigParseError`                                           | A malformed `supabase/config.toml`/`.json`.                             |
| `CliProjectEnvParseError`                                       | A malformed `.env`/`.env.local` file.                                   |
| `DuplicateRemoteProjectIdError` / `InvalidRemoteProjectIdError` | A `[remotes.*]` block problem.                                          |
| `ProjectConfigParseError`                                       | A Management API v2 response, or a caller argument, that failed to map. |

**Constants**

| Export                                                                                             | What it is                               |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `edgeFunctionDenoConfigFileName` / `edgeFunctionEntrypointFileName` / `edgeFunctionsDirectoryName` | Edge Functions on-disk layout filenames. |

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
  [ADR 0021](https://github.com/supabase/cli/blob/develop/docs/adr/0021-projectconfig-convergence-semantics.md) for the push-precedence
  and sentinel-pruning semantics this applies.
- `fromApiProjectConfig(input)` — translation of a Management API v2 project-config response (the
  full envelope, its `data` object, or bare `data.attributes`) via registry-driven renames,
  boolean inversions, and unit conversions; lenient toward API keys this package version doesn't
  yet know, and never reports a secret field's plaintext. Attaches a deep-frozen copy of the raw
  attributes as a non-enumerable `_apiResponse` (invisible to encodes and structural walks, never
  persisted — see [ADR 0019](https://github.com/supabase/cli/blob/develop/docs/adr/0019-config-api-response-passthrough.md)). Throws
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

> **Caution:** a key that isn't one of the seven hosted sections (or a field this schema version
> doesn't yet model) does not fail validation — it is silently dropped from `result.value` rather
> than rejected or preserved. Keep using your own `candidate` afterward if you need the original,
> unfiltered value.

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

`./io` re-exports this package's entire pure surface (`export * from "."`, the same way `./effect`
does) alongside its seven Promise-returning functions, so one import from `@supabase/config/io` is
enough — no separate import from `.` needed to also name an error class, `CliConfigSchema`, or any
other pure export (those are all synchronous, exactly as on `.`). What `./io` adds on top — the
seven facade functions — is Promise-returning; among same-named `./effect` counterparts, only
`resolveCliConfigValue`/`resolveCliConfigSubtree` stay synchronous here, since they come from the
pure surface rather than the facade.

`loadCliConfig`, `findCliProjectRoot`, `findCliProjectPaths`, and `loadCliProjectEnvironment`
resolve to `null` — they never reject — when there is simply no project or config file to find.
Rejection always means something was found but couldn't be read or understood (malformed config,
malformed env file, an OS-level failure); it never means "missing". `loadCliConfigFile` and
`saveCliConfig` have no such "missing" case (they name an exact path), so they only ever resolve or
reject.

A rejected `loadCliConfig`, `loadCliConfigFile`, or `saveCliConfig` call from `./io` can reject
with any of:

- `CliConfigParseError` — a malformed `supabase/config.toml`/`.json`
- `DuplicateRemoteProjectIdError` — two `[remotes.*]` blocks declare the same `project_id`
- `InvalidRemoteProjectIdError` — a `[remotes.*]` block's `project_id` isn't a valid project ref
- `CliProjectEnvParseError` — a malformed `.env`/`.env.local` file
- `PlatformError` (from `effect/PlatformError`) — a host/OS failure surfaced by the underlying
  `FileSystem` service

The four package-owned classes are plain Effect `Data.TaggedError` classes; `PlatformError` is
Effect's own error class rather than one of this package's — but all five are classes, so a catch
block can distinguish any of them with `instanceof`. What each carries:

- `DuplicateRemoteProjectIdError` and `InvalidRemoteProjectIdError` set a real `error.message`
  (verbatim the Go CLI's wording for the same failures).
- `PlatformError` sets `error.message` too, describing the failing filesystem operation, alongside
  `.module`/`.method`/`.description`.
- `CliConfigParseError` and `CliProjectEnvParseError` carry structured fields instead of prose —
  their `error.message` is empty. Build user-facing text from `CliConfigParseError.path`/`.format`/
  `.cause` (the `.cause` is typically a TOML or schema issue that itself carries line/column
  location info worth surfacing) and `CliProjectEnvParseError.path`/`.line`.

(`ProjectConfigParseError` is not part of this contract — it's thrown synchronously by the
`ProjectConfig` converters on the pure surface, and is documented in that section.)

```ts
import {
  CliConfigParseError,
  DuplicateRemoteProjectIdError,
  loadCliConfig,
} from "@supabase/config/io";

try {
  const loaded = await loadCliConfig(process.cwd());
  if (loaded === null) {
    // no supabase/config.toml or config.json in this project — not an error
    return;
  }
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
`./internal` carries no such guarantee. See [AGENTS.md](https://github.com/supabase/cli/blob/develop/packages/config/AGENTS.md) for how that contract is
enforced (export-surface snapshots, purity walkers, and a base-vs-head type-surface diff advisory
at PR time). Releases themselves are cut by an independent pipeline: conventional commits scoped to
`packages/config/` compute the next version, published to npm under the `latest` dist-tag and
tagged `config-v<version>`, and every publish is human-approved against a type-surface diff of the
previously published version.

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

- [CLI config loading](https://github.com/supabase/cli/blob/develop/packages/config/docs/cli-config-loading.md)

## Development (contributors)

This section is for contributors to the supabase/cli monorepo, not consumers of the published
package.

Repo-wide quality checks run from the repository root:

```sh
pnpm check:all
pnpm fix:all
```

Package-local checks and development commands run from `packages/config`:

```sh
pnpm types:check
pnpm run test        # Run tests
pnpm run build       # Compile dist/, generate schema.json/project-schema.json
```

See [AGENTS.md](https://github.com/supabase/cli/blob/develop/packages/config/AGENTS.md) for the build pipeline and contract-enforcement details.

## License

MIT — see the bundled [LICENSE](https://github.com/supabase/cli/blob/develop/packages/config/LICENSE) file.
