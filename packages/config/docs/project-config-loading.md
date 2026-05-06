# Project Config Loading

This document explains how Supabase project config loading works across `@supabase/config` and the CLI.

## Overview

There are three important runtime concepts:

- `ProjectConfig`: the persisted config shape from `supabase/config.toml` or `supabase/config.json`
- `ProjectEnvironment`: the merged env map for the active project
- `ProjectContext`: the CLI runtime bundle for the active project, including discovered paths, merged env, and raw config

`CliConfig` is separate from all of these. It contains effective CLI runtime settings such as access token, cache root, and debug or telemetry flags.

There is intentionally no global `ResolvedProjectConfig` anymore. `env(NAME)` values are resolved lazily when a caller explicitly asks to resolve a value or subtree.

## Project Discovery

Project discovery starts from the current working directory and walks upward until it finds the nearest ancestor containing one of:

- `supabase/config.toml`
- `supabase/config.json`

The first match wins.

Within one discovered `supabase/` directory, `config.json` takes precedence over `config.toml` when both files exist.

This produces:

- `projectRoot`: the matched ancestor directory
- `supabaseDir`: `${projectRoot}/supabase`
- `configPath`: the selected config file path
- `envPath`: `${supabaseDir}/.env`
- `envLocalPath`: `${supabaseDir}/.env.local`

Only the nearest matched `supabase/` directory is used. The loader does not merge config or env files from higher ancestors.

This discovery behavior is intentionally narrower than the CLI's broader project-state discovery.
`@supabase/config` only cares about committed project config and env files under `supabase/`.

## Config Files and Env Files

The project-scoped files are:

- `supabase/config.toml` or `supabase/config.json`
- `supabase/.env`
- `supabase/.env.local`

Their intended roles are:

- `config.toml` or `config.json`: shared structural project config
- `.env`: managed or shared project env values
- `.env.local`: user-editable local overrides

The CLI can run from any subdirectory inside a monorepo, but once a project is discovered, all config and env loading is scoped to that project's `supabase/` directory.

The loader never merges config from multiple ancestor projects. One discovered project root defines the full config/env scope for that invocation.

## Config File Selection and Saving

`loadProjectConfig()` and `loadProjectConfigFile()` use the discovered project root, then apply these rules:

- if both `supabase/config.json` and `supabase/config.toml` exist in that project, JSON wins
- the returned `LoadedProjectConfig.ignoredPaths` reports the shadowed config file path
- if only one config file exists, that file is loaded
- if no config file exists in the discovered project, loading returns `null`

`saveProjectConfig()` uses these rules:

- if the discovered project already has `config.json`, save back to JSON
- otherwise if it already has `config.toml`, save back to TOML
- otherwise default new writes to `supabase/config.json`
- callers can still force a format explicitly via `SaveProjectConfigOptions.format`

The saved file may also preserve a top-level `"$schema"` key as editor metadata. That key does not
participate in runtime config semantics.

## Env Loading and Precedence

`@supabase/config` loads project env in this order:

1. `supabase/.env`
2. `supabase/.env.local`
3. `process.env` passed in as `baseEnv`

The resulting precedence is:

- `process.env` wins over `.env.local`
- `.env.local` wins over `.env`
- `.env` provides the lowest-priority project values

The loader returns a `ProjectEnvironment` object containing:

- `paths`
- `values`: the merged effective env map
- `loadedPaths`
- `sources`: per-key provenance (`.env`, `.env.local`, or `ambient`)

The `ambient` source label just means the value came from `process.env`.

## Raw Config Loading

`ProjectConfig` is always loaded and validated as raw data first.

Important rules:

- literal `env(NAME)` strings are preserved in raw config
- schema defaults still provide true runtime defaults
- Effect schema filters still validate cross-field feature contracts such as `enabled => required sibling fields`

That means raw config loading can fail because a feature block is structurally invalid, but it does not fail just because some optional field contains `env(NAME)`.

## Lazy `env(NAME)` Resolution

`env(NAME)` resolution is now explicit and on-demand.

The package exposes two helpers:

- `resolveProjectValue(value, projectEnv, configPath)`
- `resolveProjectSubtree(value, projectEnv, pathPrefix)`

Resolution only applies to exact whole-string matches of the form:

```txt
env(NAME)
```

It does not interpolate inside larger strings.

`resolveProjectSubtree` walks recursively through:

- objects
- arrays
- records

If a selected value or subtree contains `env(NAME)` and `NAME` exists in `projectEnv.values`, the helper substitutes the env value.

If the selected value or subtree contains `env(NAME)` and `NAME` is missing, the helper fails immediately with `MissingProjectEnvVarError`.

This means dormant config can safely contain unresolved `env(NAME)` values as long as no caller chooses to resolve that part of the config.

Examples:

- loading a project with a disabled Twilio block that still contains `auth_token = "env(TWILIO_AUTH_TOKEN)"` is fine
- resolving `auth.jwt_secret` will fail immediately if it is `env(MISSING_SECRET)`
- resolving the full Twilio subtree will also fail if it still contains a missing env reference, even when `enabled = false`

In other words, the failure boundary is defined by what the caller chooses to resolve, not by project load.

## Secret Handling

Secret sensitivity is derived from schema annotations such as `x-secret`.

Behavior:

- raw config keeps plain strings, including literal `env(NAME)`
- merged env remains plain strings for substitution and file IO
- lazy resolution wraps secret-marked resolved values in `Redacted<string>`

This keeps persisted config serializable while still protecting resolved runtime values.

## Minimal Config Semantics

All project config keys are optional at input time.

Decoding `{}` produces the full effective legacy-compatible config using schema defaults. Saving strips values that are equal to defaults, so generated config stays sparse and minimal instead of expanding into a template.

That gives the project config system two properties at once:

- legacy default compatibility
- minimal `0`-config authoring
- stable round-tripping without expanding defaults into the saved file

The CLI's `supabase init` command now leans into that model by creating a minimal
`supabase/config.json` containing only:

```json
{
  "$schema": "https://supabase.com/docs/cli/config.schema.json"
}
```

That file is valid project config input. The `"$schema"` field is preserved for editor
autocomplete, but ignored by runtime config logic.

## CLI Composition

The CLI builds runtime state in two layers:

1. `ProjectContext`
2. `CliConfig`

### `ProjectContext`

`ProjectContext` is the discovered project runtime bundle. It contains:

- discovered project paths
- merged project env
- raw project config

It is built by loading raw project config and project env separately for the nearest discovered project from `cwd`.

If no `supabase/config.*` exists, `ProjectContext` remains config-scoped and does not invent a
project from `.supabase/` alone.

### `CliConfig`

`CliConfig` contains effective CLI runtime settings such as:

- platform API URL
- dashboard URL
- access token
- cache root
- keyring mode
- debug and telemetry flags

Its values are derived from:

- `ProjectContext.projectEnv.values` when a project exists
- otherwise `process.env`

This allows project-scoped env files to influence CLI behavior while keeping CLI runtime settings distinct from project config.

## CLI-owned Repo State

The CLI now also uses a repo-local `.supabase/` directory for checkout-specific machine state such
as:

- linked remote project metadata
- checkout-local service version overrides
- managed stack metadata and running state

That directory is a sibling of `supabase/`, not part of `@supabase/config` input.

Important distinction:

- `@supabase/config` discovers committed config only from `supabase/config.toml` or
  `supabase/config.json`
- the CLI may still resolve a project root from the nearest `.supabase/project.json` when it
  needs to find local machine state for commands like `link`, `unlink`, `start`, `stop`, `status`,
  `stack list`, `stack update`, or `logs`

In other words, `.supabase/` broadens CLI project-state discovery, but it does not broaden config
loading semantics in `@supabase/config`.

## What Belongs in `ProjectConfig` vs `CliConfig`

`ProjectConfig` should contain committed project intent:

- local stack settings
- auth, db, studio, storage, and function config
- shared dev workflow settings that belong to the repo

`CliConfig` should contain runtime CLI settings that are not part of the committed project contract:

- access token
- cache and state locations
- keyring behavior
- debug and telemetry flags
- platform endpoint overrides

The important rule is semantic overlap, not storage overlap. A value does not belong in `ProjectConfig` just because it can be sourced from env.

For example:

- `CliConfig.apiUrl` is the Supabase platform Management API base URL
- `ProjectConfig.studio.api_url` is the local API URL used by Studio

Those are different meanings and should remain separate.

## Process Env as Input

The system still tracks value provenance for:

- precedence
- diagnostics
- env file writes

But `process.env` is treated as infrastructure input, not as an application-level service or domain abstraction.

So the public architecture intentionally stays at:

- `ProjectConfig`
- `ProjectEnvironment`
- `ProjectContext`
- `CliConfig`
