# `@supabase/stack`

Local Supabase stack runtime for Node and Bun. The package offers a direct
in-process API and a managed supervisor API for detached CLI workflows.

## Direct stack

```ts
import { createStack } from "@supabase/stack";

await using stack = await createStack({ projectDir: process.cwd() });
await stack.start();
console.log((await stack.getInfo()).url);
```

`createStack` resolves configuration, reserves ports, and builds a scoped
handle. `stack.start()` starts services; disposing the handle stops them and
releases its lease. When `mode` is omitted, creation uses Docker mode with a
usable Docker or Podman service and otherwise selects native mode. An explicit
mode never falls back to the other one.

## Managed stack

Managed callers use `@supabase/stack/managed` (or the conditional managed Bun
and Node entrypoint) and provide a state root to the manager layer:

```ts
import { managedStackManagerLayer } from "@supabase/stack/managed";

const layer = managedStackManagerLayer({ stateRoot: "/absolute/managed" });
```

The manager persists one document per deterministic stack id under
`<stateRoot>/stacks/<id>/stack.json`. It owns identity discovery, sticky-port
intent, lifecycle transitions, and control ownership. The lifecycle facade
provides `connectManagedStack`, `updateManagedLaunch`, `stopManagedStack`, and
`deleteManagedStack`, so consumers do not manipulate documents or control
routes directly.

The CLI normally uses `@supabase/stack/effect`:

```ts
import { daemonLayer, connectLayer, stopDaemon } from "@supabase/stack/effect";

const runtime =
  yield *
  daemonLayer({
    cacheRoot: cliConfig.supabaseHome,
    projectDir: projectRoot,
    name: "default",
    portIntents,
    launch: { mode: "docker", versions: {}, excludedServices: [] },
  });
```

`daemonLayer` starts the managed supervisor and returns a remote `Stack` layer;
`connectLayer` reattaches through the deterministic control endpoint;
`stopDaemon` and the discovery helpers delegate to the managed lifecycle
facade. No CLI metadata file or PID polling is involved.

Managed ownership is exposed by one deterministic loopback HTTP listener. The
stable cross-build control protocol is `GET /owner` plus session-fenced
`POST /stop`; runtime operations use same-version Effect RPC over framed NDJSON
at `POST /rpc`. The complete application is installed before the listener
binds, and runtime RPC is available only after the supervisor publishes a
running lifecycle state.

The CLI version must exactly match the daemon CLI version before a remote
runtime client is constructed. Released and preview CLI versions are immutable
and unique, so the version is the compatibility identity. An incompatible owner is never spoken to
over RPC: connect-only commands report an actionable upgrade requirement, and
only an explicit `supabase start` may preflight, stop the exact old owner
session, and start the current version. Replacement preserves the managed
identity and launch metadata, data roots, runtime mode, pinned service
versions, exclusions, and sticky port assignments; it never deletes the
managed stack. Existing connections briefly disconnect during this normal
stop/start replacement.

After a managed supervisor claims a stack, its persisted Docker, Podman, or
native selection remains pinned even if startup later fails. Retry after
restoring or starting that runtime; delete and recreate the stack to choose a
different execution mode. Deletion removes the stack's managed data.

For the end-to-end lifecycle, identity, ports, service execution, transport,
compiled-Bun re-entry, and testing boundary, see [How `@supabase/stack` works](docs/architecture.md).
