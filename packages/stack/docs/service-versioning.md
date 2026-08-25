# Service Versioning in the Supabase CLI

The TypeScript CLI resolves service versions from a small set of explicit inputs and records the
launch selection in the managed stack document. Runtime ownership and liveness are separate from
version resolution: a stack is live only while its managed control endpoint has an owner.

## Resolution flow

```text
DEFAULT_VERSIONS
      |
      v
linked project cache + checkout-local overrides
      |
      v
managed launch metadata (versions + exclusions)
      |
      v
supervisor resolves and starts the stack
```

The important separation is:

- `project.json` caches linked remote service versions for the current checkout.
- `local-versions.json` contains optional checkout-local overrides.
- `--service-version service=version` applies a one-run override.
- `launch` in the managed document is the persisted baseline and records exclusions and update
  notification state for one managed stack.

The managed document is stored under the global CLI home:

```text
<SUPABASE_HOME>/managed/stacks/<stack-id>/stack.json
```

It contains the stack identity, assigned ports and intents, lifecycle, runtime control endpoint,
and launch metadata. There is no second state or metadata file. Start, status, logs, update,
services, and stop all go through the managed lifecycle facade. The stable cross-build control
protocol is `GET /owner` plus session-fenced `POST /stop`; runtime operations use same-version
Effect RPC over HTTP/NDJSON at `POST /rpc`. A running document without an owned control endpoint
is stale and can be reclaimed by the next lifecycle operation.

## Built-in defaults and remote versions

`ServiceCatalog.ts` defines `DEFAULT_VERSIONS` for the services in a CLI release. These defaults
are used for unlinked projects, services without a remote probe, and new stacks before a user
selects a different version.

When a project is linked, the CLI refreshes `.supabase/project.json` with the service versions it
can probe. The currently supported remote probes are:

| Service     | Source                                  |
| ----------- | --------------------------------------- |
| `postgres`  | Management API project database version |
| `postgrest` | Tenant REST probe                       |
| `auth`      | Tenant health probe                     |
| `storage`   | Tenant storage version probe            |

Other local services remain on the catalog defaults unless a launch override is provided. The
artifact provider (Docker or a supported native release) is selected by the service catalog and is
independent of stack lifecycle and control ownership.

## Checkout-local inputs

The linked cache remains checkout-local and gitignored:

```text
<project-root>/.supabase/project.json
<project-root>/.supabase/local-versions.json
```

`project.json` is refreshed by `supabase link` and by `supabase stack update`. The optional
`local-versions.json` file overrides the candidate baseline for that checkout. These files do not
replace managed launch metadata and do not describe whether a stack is running.

For ports, raw values and their origins are read from `supabase/config.toml`. Omitted sticky ports
remain automatic; explicitly configured values are persisted as exact intents in each managed
document. Sibling worktrees have independent stack identities: an explicit request asks for that
exact port and conflicts with a live sibling using it, while automatic allocations are selected
independently. Runtime-only service ports are allocated by the managed supervisor for that run and
are not written to `stack.json`.

## Commands

### `supabase start`

Start resolves the candidate versions, applies local and command-line overrides, and records the
resulting launch selection in the managed document. Starting an existing stack reuses its persisted
launch baseline unless an explicit update or override changes it. Port intent is read from the raw
project config before defaults are applied so automatic and exact values remain distinguishable.
After startup, the managed summary is authoritative for launch updates: the caller must not
overwrite persisted mode, pinned versions, exclusions, or sticky port assignments with defaults from
the new CLI build.

### `supabase stack status`

Status reads the managed document and probes `/owner` before reporting a running stack. When the
owner CLI version matches, it may use the runtime RPC projection for detailed service state. A mismatched
owner is reported as a degraded owner/document summary with an instruction to run `supabase start`;
status never restarts a live stack and does not attempt runtime RPC against the mismatched version. It
compares the persisted launch baseline with the current candidate versions and reports when
`supabase stack update` can adopt newer linked or default versions.

### `supabase stack update`

Update refreshes the linked cache when the project is linked, computes the candidate baseline, and
updates `launch.versions` through the same-version `UpdateLaunch` RPC when the stack is running. A
stopped stack is updated directly through the manager. It does not maintain a project-level copy of
pinned versions and does not restart the runtime. If the owner CLI version differs, update fails with an
upgrade-required diagnostic rather than restarting the stack.

### `supabase stop`

Stop asks the managed control owner to stop the runtime, waits for the document to record
`stopped`, and waits for control ownership to be released. Normal stop keeps the managed document
for the next start. `--no-backup` then removes the document and its managed runtime artifacts after
deterministic cleanup.

## User stories

### Fresh start

An unlinked project with no overrides starts from `DEFAULT_VERSIONS` and persists that launch
selection in its managed document.

### Linked project

`supabase link` and `supabase stack update` refresh the checkout-local linked cache. Existing managed
stacks keep their persisted launch baseline until the user explicitly runs update.

### Checkout-local experimentation

Values in `.supabase/local-versions.json` override the candidate baseline for that checkout. A
`--service-version` flag has the highest precedence for that invocation only.

### CLI upgrades

New stacks can adopt newer catalog defaults immediately. Existing stacks remain pinned until update
changes their managed launch metadata. When `supabase start` encounters an incompatible live owner,
it performs an explicit stop/start upgrade restart after preflight. The restart is authorized only by that
explicit operation: it preflights while the old owner is live, stops the exact captured session through
the stable `ControlClient`, waits for that session to release ownership, and launches an ordinary child.
Persisted exclusions are reapplied to effective runtime
service policies before preflight, active-port calculation, allocation, configuration resolution, and
startup—not merely copied into `stack.json`. The upgrade restart preserves durable stack identity and
creation metadata, data roots, runtime mode and container runtime, pinned service versions,
exclusions, and sticky port assignments. It never invokes destructive deletion. Connect-only commands
never restart the stack; they report the upgrade requirement instead.

### Team collaboration

Linked caches and local overrides are checkout-local and gitignored. Sibling worktrees have separate
managed documents and control identities, while the global managed home provides deterministic
lookup and conflict checks without a project-local second state format.

## Service inventory

The local catalog currently represents:

- `postgres`, `postgrest`, `auth`, `realtime`, `storage`
- `imgproxy`, `mailpit`, `pgmeta`, `studio`, `analytics`, `vector`, `pooler`

Only the services with remote probes listed above are copied into `project.json`; all services can
still be selected through launch metadata when a supported artifact is available.

## Future work

The main missing hosted-version improvement is a Management API route that exposes all service
versions directly. Adding that route should only change the linked-cache adapter and candidate
resolution; managed lifecycle, control ownership, and the single-document launch model remain the
same.
