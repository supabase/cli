# CLI Config Loading

This document explains how the CLI's on-disk config document loading works, across
`@supabase/config` and the CLI.

## Vocabulary

- `CliConfig`: the persisted config-file document (`supabase/config.toml` / `supabase/config.json`)
  — the full local superset, including local-only sections (`studio`, ports, `edge_runtime`,
  `analytics`, …) plus `[remotes.*]` overrides. Owned by `@supabase/config`.
- `ProjectConfig`: the hosted-project subset — the sections a hosted project manages (`api`,
  `auth`, `db`, `realtime`, `storage`, `workers`, `experimental`), produced by `toProjectConfig`
  from either a `CliConfig` document or a Management API v2 project-config response (CLI-2230).
  Sparse by design: it carries only what its source actually said, so it composes with the
  subtraction core (`subtractCliConfig`/`omitDefaultValues`, operand type `EffectiveConfig`)
  without fabricating drift from schema defaults. An API-sourced value may speak for fewer
  fields than the section list implies — `realtime` maps no fields today, and `workers`/
  `experimental` have no v2 project-config API counterpart at all — so a comparison consumer
  should restrict itself to `comparableProjectConfigPaths`/`isComparableProjectConfigPath`
  rather than treating a section's presence in that list as a per-field guarantee. Owned by
  `@supabase/config` (`packages/config/src/project-config/`).
- `CliSettings`: the CLI's effective runtime settings bundle (platform `apiUrl`, `dashboardUrl`,
  access token, telemetry flags, `supabaseHome`, `noKeyring`, `debug`). Lives in `apps/cli`, not
  this package.
- `CliProjectEnvironment`: the merged env map for the active project (`supabase/.env` +
  `.env.local` + ambient `process.env`).
- `CliProjectPaths`: the discovered filesystem paths for the active project.
- `CliProjectContext`: apps/cli's runtime bundle of discovered paths + merged env for the active
  project.
- `LegacyCliSettings`: apps/cli's legacy shell's own equivalent of `CliSettings` — same role,
  scoped to the legacy shell, and pending deletion once the legacy/next shells consolidate.
  Defined at `apps/cli/src/legacy/config/legacy-cli-settings.service.ts`.

The `Cli*` prefix is a rule, not a per-name coincidence: it names the local checkout side — what
the CLI reads, writes, or resolves about itself on disk. A bare `Project*` name is reserved for the
hosted Supabase project. Value-helpers follow the config family regardless of their inputs, not the
shape of whatever they're passed — `resolveCliConfigValue` is `Cli*`-named for this reason. See
[ADR 0020](../../../docs/adr/0020-config-naming-vocabulary.md) for the full decision record.

Within `CliConfig` itself, `project_id` is overloaded by position: the root-scope `project_id` is
a local identifier that defaults to the working directory name when running `supabase init` (see
`packages/config/src/base.ts`), while a `[remotes.<label>].project_id` is the hosted project's
ref — the value that binds that remote block to a specific persistent Supabase branch.

The `Cli*` prefix names the local checkout side — what the CLI reads, writes, or resolves about
itself on disk. A bare `Project*` name is reserved for the hosted Supabase project side. (Deliberate
exceptions live in apps/cli: services that describe the hosted project itself or the CLI's link to
it — `ProjectLinkRemote`, `ProjectLinkState` (both in `next/config`), and legacy's
`ProjectRefResolver` (exported as `LegacyProjectRefResolver`, carrying the legacy shell's own
separate mandatory prefix) — keep the bare `Project*` root under this same rule.)

## The `/io` facade

`@supabase/config` (`.`), `@supabase/config/effect`, and `@supabase/config/io` are the package's
three published entrypoints (see the package README's "Entrypoints" section for the full
contract). `./io` is the one whose names diverge from the vocabulary above: it is a Promise-based
facade over `./effect`'s programs, for non-Effect consumers, and its seven exports (verified
against `packages/config/src/node.ts`/`bun.ts`) are:

- `loadCliConfig`
- `saveCliConfig`
- `loadCliConfigFile`
- `findCliProjectRoot`
- `findCliProjectPaths`
- `loadCliProjectEnvironment`
- `inferFunctionsManifest`

Every name here matches its `./effect` counterpart one-to-one (only the return type changes,
`Effect` to `Promise`) — the subpath itself (`/io` vs `/effect`) is what conveys Promise-vs-Effect.
`findCliProjectRootFor`/`findCliProjectPathsFor`/`loadCliProjectEnvironmentFor`/
`loadFunctionsManifest` were the pre-CLI-2234 names: the first three carried a `For` suffix their
`./effect` counterparts didn't, and the fourth wrapped `./effect`'s `inferFunctionsManifest` under
an unrelated verb. CLI-2234 renamed all four to match.

## Overview

There is no global, fully-resolved config snapshot. Most `env(NAME)` references inside `CliConfig`
are substituted automatically when the file is loaded (see "Raw Config Loading" below). A narrow
set of fields are deliberately left as literal `env(NAME)` strings through decode, and are resolved
by a caller later, on demand (see "Lazy `env(NAME)` Resolution" below).

## Project Discovery

Project discovery (`findCliProjectPaths`/`findCliProjectRoot`, exported from
`@supabase/config/effect`) starts from the current working directory and, by default, walks
upward until it finds the nearest ancestor containing one of:

- `supabase/config.toml`
- `supabase/config.json`

The first match wins. A caller that already holds an authoritative, pre-resolved root — for
example one derived from an explicit `--workdir`/`SUPABASE_WORKDIR` — can pass `{ search: false }`
to check only that exact directory, with no ancestor climb.

Within one discovered `supabase/` directory, `config.json` takes precedence over `config.toml`
when both files exist.

This produces a `CliProjectPaths` (the type is exported from `@supabase/config`):

- `projectRoot`: the matched ancestor directory
- `supabaseDir`: `${projectRoot}/supabase`
- `configPath`: the selected config file path
- `envPath`: `${supabaseDir}/.env`
- `envLocalPath`: `${supabaseDir}/.env.local`

Only the nearest matched `supabase/` directory is used. The loader does not merge config or env
files from higher ancestors.

This discovery behavior is intentionally narrower than the CLI's broader project-state discovery
(see "CLI-owned Repo State" below). `@supabase/config` only cares about committed project config
and env files under `supabase/`.

## Config Files and Env Files

The project-scoped files are:

- `supabase/config.toml` or `supabase/config.json`
- `supabase/.env`
- `supabase/.env.local`

Their intended roles are:

- `config.toml` or `config.json`: the shared, committed `CliConfig` document
- `.env`: managed or shared project env values
- `.env.local`: user-editable local overrides

The CLI can run from any subdirectory inside a monorepo, but once a project is discovered, all
config and env loading is scoped to that project's `supabase/` directory.

The loader never merges config from multiple ancestor projects. One discovered project root
defines the full config/env scope for that invocation.

## Config File Selection and Saving

`loadCliConfig()` and `loadCliConfigFile()` (both exported from `@supabase/config/effect`) apply
these rules:

- `loadCliConfig(cwd)` discovers the project, then:
  - if both `supabase/config.json` and `supabase/config.toml` exist, JSON wins
  - the returned `LoadedCliConfig.ignoredPaths` reports the shadowed config file path
  - if only one config file exists, that file is loaded
  - if no config file exists in the discovered project, loading returns `null`
- `loadCliConfigFile(path)` loads one explicit file path directly instead of discovering or
  choosing between sibling formats, so its own `ignoredPaths` is always empty

`saveCliConfig()` uses these rules:

- if the discovered project already has `config.json`, save back to JSON
- otherwise if it already has `config.toml`, save back to TOML
- otherwise default new writes to `supabase/config.json`
- callers can still force a format explicitly via `SaveCliConfigOptions.format`
- after writing, it removes the sibling config file in the other format, if one exists, so a
  project never ends up with both after a save

The saved file may also preserve a top-level `"$schema"` key as editor metadata: when a caller
doesn't pass an explicit `schemaRef`, saving reuses whatever `$schema` the project's existing
config file already had. That key does not participate in runtime config semantics.

## Env Loading and Precedence

`loadCliProjectEnvironment()` (exported from `@supabase/config/effect`) loads project env in this
order:

1. `supabase/.env`
2. `supabase/.env.local`
3. `process.env` passed in as `baseEnv`

The resulting precedence is:

- `process.env` wins over `.env.local`
- `.env.local` wins over `.env`
- `.env` provides the lowest-priority project values

The loader returns a `CliProjectEnvironment` object (the type is exported from
`@supabase/config`) containing:

- `paths`
- `values`: the merged effective env map
- `loadedPaths`
- `sources`: per-key provenance (`.env`, `.env.local`, or `ambient`)

The `ambient` source label just means the value came from `process.env`.

## Raw Config Loading

`CliConfig` is loaded by parsing the TOML/JSON file and decoding it against `CliConfigSchema`.

Before decoding, most string values matching `env(NAME)` are substituted automatically using the
resolved `CliProjectEnvironment` — this is required so numeric and boolean fields don't crash the
strict decoder when their TOML/JSON value is still a string. Substitution also coerces the
resulting string to the field's declared type: a numeric field is parsed as a number, a boolean
field accepts Go's `TRUE`/`FALSE`/`1`/`0`/`t`/`f`/… spellings, and a string-array field is split on
`,`. A missing or empty-string env var leaves the literal `env(NAME)` untouched rather than
substituting an empty value.

A narrow set of fields are exempt from that pre-decode substitution and keep the literal
`env(NAME)` string all the way through decode — currently only the per-function passthrough values
at `functions.<name>.env.<VAR_NAME>`. Those fields are resolved later, on demand, by a caller — see
"Lazy `env(NAME)` Resolution" below.

Schema defaults still provide true runtime defaults, and Effect schema filters still validate
cross-field feature contracts such as `enabled => required sibling fields`. Raw config loading
fails when a feature block is structurally invalid, but not just because a field still contains a
literal, unresolved `env(NAME)`.

## Lazy `env(NAME)` Resolution

A caller can also resolve `env(NAME)` references explicitly, after config is loaded. The package
exposes two helpers, under the same names from both `.` (plain, synchronous) and
`@supabase/config/effect` (Effect-typed; the Effect-typed variant wins when both are in scope via
`@supabase/config/effect`, since explicit named exports take precedence over a star re-export of
the same name). Neither has a failure mode: an unresolved `env(NAME)` reference is preserved
verbatim rather than rejected or thrown (see "Lazy `env(NAME)` Resolution" behavior below).

- `resolveCliConfigValue(value, cliProjectEnv, configPath)`
- `resolveCliConfigSubtree(value, cliProjectEnv, pathPrefix)`

Resolution only applies to exact whole-string matches of the form:

```txt
env(NAME)
```

It does not interpolate inside larger strings.

These helpers do two things at once:

1. Substitute any string that is still a literal `env(NAME)` reference — this only matters for the
   deferred fields from the previous section, since everything else was already substituted at
   load time — using `cliProjectEnv.values`. Like the pre-decode substitution, a missing or
   empty-string env var leaves the literal untouched rather than failing.
2. Wrap every schema-secret-marked (`x-secret`) leaf that resolved to a real value in
   `Redacted<string>` — except a leaf that is still an unresolved literal `env(NAME)` reference,
   which passes through as a plain string so a caller can see the missing reference.

`resolveCliConfigSubtree` walks recursively through objects, arrays, and records, so it also
resolves and redacts leaves nested inside `[remotes.*]` blocks.

An optional `goViperCompat` flag switches the `env(NAME)` matcher from the default, strict
`SCREAMING_SNAKE_CASE`-only pattern to Go/viper's case-agnostic `^env\((.*)\)$` form; only the
Go-parity legacy shell sets it. The public `resolveCliConfigValue`/`resolveCliConfigSubtree` on
`.`/`./effect` take no options parameter at all (CLI-2234) — `goViperCompat` is internal-only,
typed on `InternalResolveCliConfigOptions`, a package-internal type that is not itself exported.
`@supabase/config/internal` re-exports these same runtime functions re-typed to additionally
accept it; `apps/cli`'s Go-parity call sites import from there instead.

Callers such as `functions serve`/`functions dev`, `secrets set`, and `start` call these resolvers
on the subtrees they actually need (e.g. `auth`, `edge_runtime`, `functions`), so dormant
config — like a disabled Twilio block whose `auth_token` is still `env(TWILIO_AUTH_TOKEN)` because
that variable was never set — never has to resolve at load time, and no caller pays for resolving
or redacting a subtree it doesn't use.

Neither resolver ever fails: an unresolved `env(NAME)` reference is returned as a plain string,
not a typed failure.

## Secret Handling

Secret sensitivity is derived from schema annotations: fields wrapped in the package's internal
`secret()` helper (e.g. `auth.jwt_secret`, `edge_runtime.secrets.*`) carry an `x-secret`
annotation.

Behavior:

- decoding never wraps a value in `Redacted` — schema decode only ever produces plain strings,
  whether that string is a resolved secret or, for the deferred fields above, still a literal
  `env(NAME)`
- `CliProjectEnvironment.values` stays a plain string map, for substitution and file IO
- `resolveCliConfigValue`/`resolveCliConfigSubtree` are the only place secret-marked values get
  wrapped in `Redacted<string>`, and only once they've resolved to a real value

This keeps persisted config and merged env serializable, while still protecting resolved runtime
values once a caller pulls them out for use.

## Minimal Config Semantics

All `CliConfig` keys are optional at input time.

Decoding `{}` produces the full effective config using schema defaults (`getDefaultCliConfig()`, a
memoized decode of `{}`). Saving strips values that are equal to those same defaults — function
config subtracts its own entry-level defaults separately, since the default config's own
`functions` map is empty — so a saved file stays sparse instead of expanding into a
fully-populated template.

That gives the config system two properties at once:

- legacy default compatibility
- minimal input: a file containing only `project_id = "..."` is valid `CliConfig` input
- stable round-tripping: decoding a saved file and re-encoding it reproduces the same sparse
  output, since both sides derive from the same schema defaults

`@supabase/config` also exposes `subtractCliConfig()`/`omitDefaultValues()` as a standalone, pure
API over this same subtraction, for comparing two _effective_ configs (e.g. a project's local
config against its Management-API-reported effective config) without hand-rolling default
stripping.

## CLI Composition

The CLI builds runtime state in two layers:

1. `CliProjectContext`
2. `CliSettings`

### `CliProjectContext`

`CliProjectContext` is the CLI's discovered-project runtime bundle. It contains:

- `paths`: the discovered `CliProjectPaths`, when a project was found
- `projectEnv`: the merged `CliProjectEnvironment`, when a project was found

It is built by calling `loadCliProjectEnvironment` for the nearest discovered project from `cwd`.
If no `supabase/config.*` exists, both fields stay absent — `CliProjectContext` does not invent a
project from `.supabase/` alone.

### `CliSettings`

`CliSettings` contains effective CLI runtime settings such as:

- `apiUrl`, `dashboardUrl`, `projectHost` — the platform endpoints
- `accessToken`
- `supabaseHome`
- `noKeyring`
- `debug` and telemetry flags (`telemetryDebug`, `telemetryDisabled`, `telemetryPosthogHost`,
  `telemetryPosthogKey`, `doNotTrack`)

Its values are derived from:

- `CliProjectContext.projectEnv.values`, when a project exists
- otherwise `process.env`

This allows project-scoped env files to influence CLI behavior while keeping CLI runtime settings
distinct from the `CliConfig` document.

## CLI-owned Repo State

The CLI also keeps machine-local project state outside `@supabase/config`'s scope, in two places
(see `apps/cli/docs/supabase-home.md` for the full layout):

- a repo-local `.supabase/` directory, sibling to `supabase/`, holding checkout-specific caches:
  linked remote project metadata (`project.json`), checkout-local service-version overrides
  (`local-versions.json`), and, for ordinary non-Git folders, a workspace-identity marker
  (`identity.json`) — Git checkouts keep that identity in Git metadata instead and don't write
  that marker
- the global `SUPABASE_HOME` directory, holding managed-stack metadata and runtime state, keyed by
  stack identity — the canonical local-project key relative to the enclosing Git checkout, plus
  workspace identity — not the config-discovered project root

Neither is part of `@supabase/config`'s input.

Important distinction:

- `@supabase/config` discovers committed config only from `supabase/config.toml` or
  `supabase/config.json`
- the CLI may still resolve a project root from the nearest `.supabase/project.json` when it needs
  to find local machine state for commands like `link`, `unlink`, `start`, `stop`, `status`,
  `stack list`, `stack update`, or `logs`

In other words, `.supabase/` broadens the CLI's own project-state discovery, but it does not
broaden config loading semantics in `@supabase/config`.

## What Belongs in `CliConfig` vs `CliSettings`

`CliConfig` should contain committed project intent:

- local stack settings
- auth, db, studio, storage, and function config
- shared dev workflow settings that belong to the repo

`CliSettings` should contain runtime CLI settings that are not part of the committed project
contract:

- access token
- the platform endpoints
- `supabaseHome` and keyring behavior
- debug and telemetry flags

The important rule is semantic overlap, not storage overlap. A value does not belong in
`CliConfig` just because it can be sourced from env.

For example:

- `CliSettings.apiUrl` is the Supabase platform Management API base URL
- `CliConfig.studio.api_url` is the local API URL used by Studio

Those are different meanings and should remain separate.

`ProjectConfig` — the hosted-project subset (CLI-2230) — sits alongside these two: it converges
the same committed-intent fields from either a `CliConfig` document or a Management API response,
without the local-only sections (`studio`, ports, `edge_runtime`, `analytics`, `[remotes.*]`, …)
that only make sense for a local checkout. See the Vocabulary entry above for its sparse
semantics and comparison contract.

## Process Env as Input

The system still tracks value provenance for:

- precedence
- diagnostics (`CliProjectEnvironment.sources`)
- env file writes

But `process.env` is treated as infrastructure input, not as an application-level service or
domain abstraction.

So the public architecture intentionally stays at:

- `CliConfig`
- `CliProjectEnvironment`
- `CliProjectPaths`
- `CliProjectContext`
- `CliSettings`
- `ProjectConfig`
