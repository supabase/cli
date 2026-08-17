# Stack architecture

`@supabase/stack` has two intentionally separate runtime surfaces:

- the direct `createStack`/foreground API for an in-process stack; and
- the managed detached API used by the CLI and sibling worktrees.

The managed API is a small coordination layer. It does not contain a second
service registry, SQLite adapter, repository contract, or compatibility facade.
The managed document, manager, supervisor, and control transport are the
authoritative state and lifecycle path.

## Entrypoints

The root entrypoint (`@supabase/stack`) is Promise-based and exposes direct
stack creation. `@supabase/stack/effect` exposes the Effect layers consumed by
the CLI. `@supabase/stack/managed` exposes managed identity, control,
document, manager, and lifecycle operations. `@supabase/stack/testing` contains
runtime test seams only; production contract fixtures are not part of the
managed API.

Node and Bun entrypoints bind the same platform-neutral implementation to
their filesystem, path, process, HTTP, and control-transport services.

## Direct runtime

`createStack` allocates a private port lease, resolves a stack configuration,
starts local services, and returns a scoped handle. The foreground Effect layer
owns service processes and releases its lease when the scope closes. Direct
stacks never inspect or reserve managed documents.

## Managed document and identity

Every managed stack has one document under the configured managed state root:

```text
<supabase-home>/managed/stacks/<stack-id>/stack.json
```

The document records the deterministic stack identity (project, checkout,
branch context, and name), workspace path, sticky-port assignments and intent,
launch selections, lifecycle, and runtime control endpoint. A stopped document
remains available for inspection and restart; deletion removes that document
and its managed data root.

Identity comes from Git checkout metadata where available and from an explicit
ordinary-folder marker otherwise. The marker and document are private,
unreleased storage owned by the current build. There is no migration layer or
parallel `stack.json` format.

## Managed lifecycle

The CLI calls the lifecycle facade (`connectManagedStack`, `updateManagedLaunch`,
`stopManagedStack`, and `deleteManagedStack`). Read-only connect/status paths
probe the owner without binding; mutating paths acquire deterministic control
ownership:

1. A managed supervisor acquires ownership for the stack id.
2. The supervisor resolves the stack, allocates/reuses ports from the document,
   starts the local `Stack`, and records `starting` then `running`.
3. The parent receives the loopback control endpoint and can attach through the
   same endpoint. Runtime requests use the deterministic endpoint derived from
   the stack id; a persisted endpoint is accepted only when it matches.
4. Launch updates are owner-gated. An attached client posts `/managed/launch` to
   the owner; the owner writes the document through the manager.
5. Stop asks the owner to stop and polls the manager document until `stopped`.
   If no owner exists, the facade acquires ownership, performs deterministic
   Docker cleanup, and records `stopped` without PID probing.
6. Delete requires owned control and removes only a stopped managed document.
   Explicit destructive deletion can also purge an invalid document; ordinary
   status and start still fail loudly on corruption.

Control ownership is the liveness authority. PID files, process scans, and a
second metadata file are not part of managed lifecycle decisions.

## Detached transport

The supervisor child hosts `DaemonServer` on a deterministic local loopback TCP
endpoint derived from the managed stack id. `RemoteStack` is the typed client for stack status, service
operations, logs, and graceful stop. The shared fetch-based HTTP client works
in Node and Bun; only listener binding is platform-specific. `ApiProxy`
continues to own the public service URL, and the control endpoint is never
exposed as the user-facing API.

The endpoint uses 14 bits of the stack id in the loopback range
`49152..65535`. A rare hash collision or unrelated listener therefore makes a
mutation fail with a typed conflict. Read-only liveness treats it as non-live
and never claims the address. This intentionally favors a small single-user
localhost mechanism; the control protocol has no token authentication.

The parent sends one managed start message containing the resolved daemon
configuration, the raw project document for port intent, and launch
metadata. Managed-only fields are split from the generic daemon config before
serialization so they cannot leak into runtime service configuration.

## Ports and launch metadata

Sticky port fields have explicit `exact` or `automatic` intent. Startup derives
active and disabled fields from the enabled-service configuration and preserves
the raw project document. A sibling worktree has its own stack
document: an explicit request asks for that exact port and conflicts with a live
owner, while omitted fields receive independent automatic allocations. Launch metadata stores
mode, pinned service versions, excluded services, and the update-notification
fingerprint consumed by the CLI.

## Cleanup and failure handling

The owner records lifecycle transitions before and after startup. On startup
failure it records `failed` and releases the lease. On graceful stop it closes
the runtime before recording `stopped`; stale owners use best-effort Docker
container removal keyed by the managed stack id. Data and runtime paths are
under the managed stack directory and are removed only by an explicit delete or
the corresponding cleanup operation.

Typed failures are limited to errors reachable from these public surfaces:
configuration/port failures, control transport failures, managed identity and
document failures, and lifecycle failures such as `NoRunningStackError` or
`ManagedStackAttachedError`. Private supervisor implementation errors are
converted at the boundary and are not a public error registry.

## Testing boundary

Integration tests exercise the consumed surfaces: manager identity and sibling
worktree allocation, supervisor detached start/reattach/launch-update/stop,
and lifecycle stale-owner recovery. Unit tests remain for pure port/document
algorithms and platform seams. The test entrypoint exposes only the
`DaemonServer` and transport seams needed to build those journeys; it does not
recreate a repository or contract-fixture implementation.
