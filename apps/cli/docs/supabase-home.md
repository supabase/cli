# Supabase CLI State Layout

This document describes how CLI-owned state is split between the repo-local `.supabase/`
directory and the global `SUPABASE_HOME`.

By default:

```text
SUPABASE_HOME = ~/.supabase
```

The path can be overridden with the `SUPABASE_HOME` environment variable.

## Goals

- keep committed project intent in `supabase/`
- keep checkout-specific machine state explicit and discoverable in `.supabase/`
- keep machine-global auth, telemetry, and binary caches in `SUPABASE_HOME`
- keep live runtime socket state under the OS temp directory

## Two State Roots

### Repo-local project state

Project-scoped local state lives next to the repo as a gitignored sibling of `supabase/`:

```text
<project-root>/
  supabase/
    config.json
    migrations/
    functions/
  .supabase/
    project.json
    local-versions.json
    stacks/
      default/
        stack.json
        state.json
        data/
```

This state is:

- local to one checkout
- readable by humans and agents directly from the repo root
- intentionally not committed

### Global CLI home

Machine-global state remains under `SUPABASE_HOME`:

```text
~/.supabase/
  access-token
  telemetry.json
  traces/
    <date>.ndjson
  bin/
    <service>/
      <version>/
        <platform>/
          ...
```

This state is shared across all local projects on the machine.

## Project Root Resolution

For project-local CLI state, the CLI resolves the active project root from `cwd` using this
order:

1. nearest ancestor containing `supabase/config.toml` or `supabase/config.json`
2. otherwise nearest ancestor containing `.supabase/project.json`
3. otherwise `cwd`

That means:

- `supabase link` and `supabase unlink` can work before `supabase init`
- `supabase start`, `supabase stop`, `supabase status`, `supabase stack list`, and `supabase logs`
  can be run from nested subdirectories inside a linked checkout
- stack persistence is no longer keyed by a hashed global project directory

`@supabase/config` still only discovers `supabase/config.*`. The broader `.supabase/project.json`
fallback is CLI-specific runtime behavior.

## Repo-local Files

### `project.json`

`.supabase/project.json` stores cached linked-remote metadata for the checkout.

Shape:

```json
{
  "ref": "abcdefghijklmnopqrst",
  "name": "my-project",
  "fetchedAt": "2026-03-25T12:34:56.000Z",
  "versions": {
    "postgres": "17.6.1.084",
    "postgrest": "14.4",
    "auth": "2.188.1",
    "storage": "1.43.3"
  }
}
```

This file is written by `supabase link` and removed by `supabase unlink`.

It is CLI runtime state, not committed project config. The linked project ref does not live in
`supabase/config.json`.

### `local-versions.json`

`.supabase/local-versions.json` stores optional checkout-local service version overrides.

Shape:

```json
{
  "updatedAt": "2026-03-23T10:15:00.000Z",
  "versions": {
    "auth": "2.180.0",
    "storage": "1.39.2"
  }
}
```

This is a power-user escape hatch. There is no dedicated top-level command for it yet. Advanced
users can edit it directly if they want persistent local overrides.

### `stacks/<name>/stack.json`

Each project can own multiple named local stacks:

```text
.supabase/stacks/
  default/
  preview/
  ci/
```

The implicit stack name is `default`.

`stack.json` is the durable per-stack metadata record. It stores:

- `schemaVersion`
- `updatedAt`
- `ports`
- the pinned baseline `services` manifest for that stack
- `lastNotifiedUpdateFingerprint` when the CLI has already warned about available updates

### `stacks/<name>/state.json`

`state.json` is the live runtime record for a running stack. It stores connection info,
service endpoints, process identifiers, and the exact service versions currently running.

It is written when the managed stack is running and removed on normal `supabase stop`.

### `stacks/<name>/data/`

`data/` stores persisted local service data for that stack.

The CLI does not currently persist stack logs under `.supabase/`; logs are buffered in memory by
the daemon and streamed on demand through `supabase logs`.

## Service Version Resolution

There are two separate concepts:

- the **candidate baseline**, computed from cached linked-remote versions plus CLI defaults
- the **pinned baseline**, stored in `.supabase/stacks/<name>/stack.json`

The candidate baseline is:

1. cached linked service versions from `.supabase/project.json`
2. CLI `DEFAULT_VERSIONS` as fallback for everything else

The pinned baseline is what a named stack actually uses by default on subsequent starts.

Runtime precedence is:

1. per-run `supabase start --service-version service=version`
2. checkout-local overrides from `.supabase/local-versions.json`
3. pinned stack versions from `.supabase/stacks/<name>/stack.json`

If a stack has never been started before and `stack.json` does not exist yet, the CLI creates it
from the current candidate baseline.

This keeps linked remote parity, persistent local experimentation, and one-off overrides separate
from committed project config.

## Local and Remote Sync Workflow

### `supabase init`

`supabase init` creates a minimal repo-scoped config file:

```text
supabase/config.json
```

with only a top-level `"$schema"` reference:

```json
{
  "$schema": "https://supabase.com/docs/cli/config.schema.json"
}
```

It does not link a remote project and does not create `.supabase/project.json`.

### `supabase link`

`supabase link` binds the local project to a remote Supabase project and refreshes the cached
linked metadata in `.supabase/project.json`.

If the linked remote service versions differ from any existing pinned stack metadata, `link`
warns and tells the user to run `supabase stack update`.

### `supabase stack update`

`supabase stack update` is the explicit adoption step for pinned local stack versions.

When the project is linked, it first fetches the latest remote service versions and rewrites
`.supabase/project.json`. It then recomputes the candidate baseline and writes the pinned stack
versions into `.supabase/stacks/<name>/stack.json`.

If the stack is currently running, `update` warns that the user must stop and start it again for
the new pinned versions to take effect.

### `supabase stack status`

`supabase stack status` is local-only. It does not make a network call.

It shows:

- a detailed running view when `state.json` exists and the daemon is alive
- a detailed stopped view when only `stack.json` exists
- whether pinned stack versions are up to date against the current candidate baseline

### `supabase stack list`

`supabase stack list` scans `.supabase/stacks/*/stack.json` for the current project and overlays
live `state.json` data when a daemon is running.

## What Is Not Under `.supabase/`

Not all runtime files live in the repo.

### Auth state

Auth is still machine-global today:

- keyring entry: `Supabase CLI/access-token`
- filesystem fallback: `~/.supabase/access-token`

### Telemetry and traces

Telemetry state remains in `SUPABASE_HOME`:

- `telemetry.json`
- `traces/`

### Shared binaries

Downloaded binaries remain shared across projects in:

```text
~/.supabase/bin/
```

### Live runtime sockets

Managed daemon runtime directories, including the live Unix socket path, still use the OS temp
directory:

```text
/tmp/supabase/
```

The durable stack record remains in the repo-local state directory:

```text
<project-root>/.supabase/stacks/<stack-name>/stack.json
```

## Ownership Rules

When deciding where something belongs, use this rule of thumb:

- user-authored project config belongs in the repository under `supabase/`
- checkout-specific machine state belongs in `.supabase/`
- machine-global auth, telemetry, and caches belong in `SUPABASE_HOME`
- live runtime temp/socket state belongs under the OS temp directory

## Related Docs

- [CLI Code Structure](./code-structure.md)
- [Service Versioning](../../../packages/stack/docs/service-versioning.md)
- [Project Config Loading](../../../packages/config/docs/project-config-loading.md)
