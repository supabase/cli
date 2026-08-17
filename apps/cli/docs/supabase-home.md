# Supabase CLI State Layout

The CLI keeps authored project configuration in `supabase/`, checkout-local link and version
caches in `.supabase/`, and managed runtime state in the global `SUPABASE_HOME` directory.

By default:

```text
SUPABASE_HOME = ~/.supabase
```

The path can be overridden with the `SUPABASE_HOME` environment variable.

## State roots

### Project files

User-authored configuration and migrations live in the repository:

```text
<project-root>/
  supabase/
    config.toml
    migrations/
    functions/
```

The CLI discovers the active project from the nearest ancestor containing `supabase/config.toml`
(or the legacy config filename where supported), then uses that project root for command identity.

### Checkout-local caches

Gitignored checkout metadata lives beside the project:

```text
<project-root>/.supabase/
  project.json
  local-versions.json
```

`project.json` is the linked remote version cache. `local-versions.json` contains optional
checkout-local service-version overrides. Neither file records whether a local stack is running.
For ordinary non-Git folders, `.supabase/identity.json` stores the managed workspace identity. Git
checkouts keep checkout identity in Git metadata instead and do not use that marker.

### Global managed runtime

Managed stack documents and runtime artifacts are shared through the global CLI home:

```text
<SUPABASE_HOME>/
  access-token
  telemetry.json
  traces/
  bin/
  managed/
    stacks/
      <stack-id>/
        stack.json
        data/
        logs/
        runtime/
```

`stack.json` is the single durable managed record. It contains stack identity, sticky port intents
and assignments, lifecycle, runtime control endpoint, and launch metadata (mode, versions,
exclusions, and update-notification fingerprint). Runtime-only service ports are allocated for the
supervisor run and are not persisted as sticky intents. The deterministic loopback control endpoint
and ownership protocol are the liveness authority; a stale document is reclaimed by a subsequent
managed lifecycle operation.

There is no project-local `stacks/<name>` directory, `state.json`, daemon socket file, or second
StateManager metadata format.

## Service-version inputs

The candidate baseline is computed from linked versions in `.supabase/project.json` and the CLI's
`DEFAULT_VERSIONS` catalog. Runtime precedence is:

1. `supabase start --service-version service=version` for one invocation;
2. checkout-local values in `.supabase/local-versions.json`;
3. the managed document's `launch.versions` baseline;
4. catalog defaults for values not supplied by the preceding sources.

`supabase stack update` refreshes the linked cache when possible and updates `launch` through the
managed lifecycle (directly when stopped, or through the owner control route when running). It does
not write a second project-level pinned-version file.

## Port intents

Raw `supabase/config.toml` values and their origins are loaded before defaults are applied. Explicit
sticky values are persisted as `exact` intents in each managed document. Omitted values remain
`automatic`; sibling worktrees have independent stack identities and allocations, while live exact
port conflicts are rejected by the manager. Runtime-only service ports are selected by the managed
supervisor and are not written to the document.

## Command behavior

- `supabase start` resolves launch metadata and port intents, acquires managed control, and records
  the document before starting services.
- `supabase status`, `logs`, and `services` attach through the deterministic control endpoint and
  report only a live owner as running.
- `supabase stop` asks the owner to stop, waits for `stopped` and control release, and keeps the
  document by default. `--no-backup` removes it after deterministic cleanup.
- `supabase stack list` enumerates healthy managed documents and checks control ownership for live
  status; `--project-dir` scopes the result to one checkout.

## Auth, telemetry, and binaries

Auth, telemetry, traces, and downloaded binaries remain machine-global under `SUPABASE_HOME`.
Legacy installer artifacts may coexist under that root, but they are not part of managed stack
coordination.

## Related docs

- [CLI Code Structure](./code-structure.md)
- [Service Versioning](../../../packages/stack/docs/service-versioning.md)
- [Project Config Loading](../../../packages/config/docs/project-config-loading.md)
