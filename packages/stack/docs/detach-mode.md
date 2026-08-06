# Detached stack mode

Detached mode runs the same local `Stack` Implementation in a background process and exposes its
Effect Interface over HTTP and server-sent events on a Unix-domain socket. Foreground and detached
callers share configuration resolution, preparation, topology, lifecycle, readiness, state
projection, and cleanup behavior.

## Process model

```mermaid
sequenceDiagram
    participant CLI
    participant Child as "Daemon process"
    participant HTTP as "DaemonServer on Unix socket"
    participant Stack as "Local Stack"

    CLI->>Child: detached fork with IPC
    CLI->>Child: DaemonStartMessage(config, socketPath)
    Child->>Stack: resolve config and build foreground daemon layer
    Child->>HTTP: bind generation-scoped Unix socket
    Child->>Child: atomically claim state.json
    Child-->>CLI: DaemonStartedMessage(state)
    CLI->>HTTP: POST /start through RemoteStack
    HTTP->>Stack: Stack.start()
    CLI-->>CLI: parent command exits; daemon remains
```

`daemonLayer()` performs the parent side:

1. resolves stack identity and durable/runtime roots;
2. rejects an already-live state claim and removes stale live state;
3. creates a generation-specific socket path;
4. forks the runtime-specific daemon entrypoint with an IPC channel;
5. sends a schema-defined start message and waits up to 30 seconds for acknowledgement;
6. unrefs the child only after the daemon has bound its server and atomically claimed live state;
7. returns a `RemoteStack` layer connected to the reported socket.

Until acknowledgement, the parent owns the child and terminates it if setup fails or is
interrupted. This avoids leaving an unregistered daemon behind.

The daemon side in `daemon.ts`:

1. receives the start message over IPC;
2. resolves the final configuration and port lease;
3. releases unused port reservations;
4. builds `foregroundDaemonLayer`, including `Stack`, `ApiProxy`, and `StateManager`;
5. binds `DaemonServer` to the Unix socket;
6. atomically creates `state.json` and acknowledges the parent;
7. waits for `/stop`, `SIGINT`, or `SIGTERM`;
8. disposes the management runtime and stack runtime.

The daemon is acknowledged before `POST /start` starts service processes. Startup and readiness
errors therefore travel through the same `Stack` transport as later lifecycle calls.

## Stack identity and paths

A stack is identified by canonical project directory plus stack name (`default` when omitted).
The package supports two durable layouts:

- Library default: `<cacheRoot>/projects/<project-hash>/stacks/<name>/`.
- Explicit `projectStateRoot`: `<projectStateRoot>/stacks/<name>/`.

The current CLI passes its discovered project home (`<project-root>/.supabase`) as
`projectStateRoot`, so CLI-managed stacks use:

```text
<project-root>/.supabase/
  project.json
  local-versions.json
  stacks/
    <name>/
      stack.json
      state.json
      data/
```

Direct `@supabase/stack` daemon callers that do not supply `projectStateRoot` use the hashed
cache-root layout instead. Documentation must not conflate these two valid modes.

Runtime sockets use a short temporary path independent of either durable layout:

```text
/tmp/supabase/s-<stack-root-hash>/daemon-<generation>.sock
```

On Windows, the system temporary directory replaces `/tmp`. The generation suffix prevents an old
daemon from unlinking a replacement daemon's socket during delayed shutdown.

## Durable metadata and live state

`stack.json` is durable metadata. It records:

- schema version and update time;
- allocated ports;
- the pinned complete service version manifest;
- launch mode and excluded services;
- exact cleanup targets once preparation/build has produced them;
- the last version-update notification fingerprint, when present.

`state.json` is the live-daemon claim. It records:

- PID, project directory, stack name, and start time;
- API/database ports and the full allocated port set;
- generation socket path;
- user-facing URLs, keys, JWTs, and service endpoints;
- versions for services enabled in this run.

`StateManager.claim()` uses an exclusive hard-link operation so concurrent daemons cannot both own
the same name. A stale PID causes live state and its runtime directory to be removed; durable
metadata and service data remain.

## The transport Adapter

`DaemonServer` exposes the local `Stack` Interface on the Unix socket. Current routes include:

- `/health`, `/status`, and `/status/stream`;
- `/start`, `/stop`, and `POST /ready`;
- per-service start, stop, restart, and readiness;
- merged and per-service live logs plus buffered history;
- functions and Edge Runtime reload.

State and log streams use SSE. Readiness routes use `POST` with a validated readiness-policy body;
omitting an override sends the explicit `inherit` representation. Ordinary responses and typed
failures use validated JSON shapes. `RemoteStack` decodes that transport back into the same Effect
`Stack` Interface used in foreground mode, including `ServiceNotFoundError`, `ServiceReadyError`,
`StackBuildError`, and `StackReadinessError`.

The management socket is not the public local API endpoint. `ApiProxy` still owns the configured
HTTP API port inside the daemon process.

## Lifecycle and cleanup

Detached mode relies on changes in `@supabase/process-compose`; it is not isolated to the stack
package. In particular:

- desired state distinguishes inactive lazy definitions from explicitly stopped definitions;
- stable state streams survive restart generations;
- `updateServiceDefinition()` supports Edge Runtime reload;
- supervisor runtimes watch owner loss and clean child trees/external resources;
- definition cleanup, exact stack cleanup targets, and orphan cleanup form an idempotent defense in
  depth.

On normal `/stop`, the daemon gracefully stops the stack, signals HTTP shutdown after the response
has had time to flush, disposes both managed runtimes, and removes live state/runtime paths.

A readiness deadline is terminal for that local runtime: the stack disposes its scoped resources,
the daemon returns the typed timeout response, and then the daemon shuts down. This prevents later
requests from relaunching processes after cleanup has already run. The boundary is deliberately
fail-closed across the whole daemon, rather than isolated to the service that timed out: once
processes and port leases are being released, the management and proxy servers cannot safely keep
advertising a usable runtime. This terminal path does not drain unrelated in-flight requests to
otherwise healthy services; callers must reconnect after starting a fresh daemon.

If the daemon has died, CLI stop/status detects a stale PID. Stop can use cleanup targets persisted
in `stack.json` to force-remove known Docker containers before removing the stale state. This
crash-recovery metadata is deliberately separate from user-facing `/status` connection data.

## Package entrypoints

| File                  | Reachability and role                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/daemon.ts`       | Shared daemon protocol and lifecycle; receives runtime-specific HTTP-server factories.                        |
| `src/daemon-bun.ts`   | Bun daemon Adapter. Exported as `@supabase/stack/daemon-bun` for compiled CLI dispatch.                       |
| `src/daemon-node.ts`  | Node daemon Adapter. Intentionally file-URL-only: `node.ts` resolves its path and passes it to `daemonLayer`. |
| `src/DaemonServer.ts` | Unix-socket HTTP/SSE Adapter over `Stack`.                                                                    |
| `src/RemoteStack.ts`  | Remote Effect `Stack` Adapter over that transport.                                                            |
| `src/layers.ts`       | Foreground, foreground-daemon, forked-daemon, and connect layer composition.                                  |
| `src/StateManager.ts` | Durable metadata, live-state claims, scanning, stale-state removal, and deletion.                             |
| `src/effect.ts`       | Effect-facing exports consumed by the CLI and advanced callers.                                               |

There is no `internals.ts`. `daemon-node.ts` is not a package export because Node root consumers
reach it by the file URL returned from `node.ts`; it is listed under `knip.entry` in `package.json`
so static unused-code analysis preserves that live entrypoint.

## Compiled executable re-entry

In development, `child_process.fork(entrypoint)` can execute the selected `.ts` daemon file through
Bun or Node. In a Bun single-file executable, `process.execPath` is the compiled CLI itself, and a
script-path argument does not replace its baked entrypoint. The fork therefore sets:

```text
SUPABASE_STACK_RUN_DAEMON=1
```

The compiled CLI entrypoint sees that marker and dynamically imports
`@supabase/stack/daemon-bun`, which invokes `runDaemon()` in the re-entered process. Supabase daemon
selection stays in the CLI/stack layer; generic process supervision uses its own protocol.

`@supabase/process-compose` uses three variables for its separate supervisor re-entry protocol:

- `PROCESS_COMPOSE_SUPERVISOR_SELF_DISPATCH` enables compiled self-dispatch for supervisor spawns;
- `PROCESS_COMPOSE_RUN_SUPERVISOR` selects the supervisor path in the re-entered executable;
- `PROCESS_COMPOSE_SUPERVISOR_CONFIG` carries its encoded configuration.

The exact protocol and cleanup behavior are documented in
[process-compose architecture](../../process-compose/docs/architecture.md#compiled-bun-self-dispatch).

These explicit dispatch contracts were introduced after:

- [CLI-1452](https://linear.app/supabase/issue/CLI-1452/compiled-bun-compile-next-binary-cant-run-supabase-functions-dev), where compiled functions development depended on unsafe runtime paths/native binding discovery;
- [CLI-1453](https://linear.app/supabase/issue/CLI-1453/compiled-bun-compile-next-binary-start-detach-daemon-fork-ignores), where detached startup re-entered the normal CLI instead of the daemon.

Runtime sources or native dependencies needed by the single-file executable must therefore be
statically reachable or explicitly embedded. Development-mode success alone does not verify this
contract.

## CLI integration

The CLI resolves the canonical project before selecting a stack, so management commands work from
nested directories. Current detached workflows include:

- `supabase start --detach`;
- `supabase stop`;
- `supabase status`;
- `supabase stack list`;
- `supabase stack update`;
- `supabase logs`;
- functions development reconnect/reload flows.

Version selection and durable metadata behavior are described in
[service versioning](./service-versioning.md).

## Testing

- `StateManager` tests cover atomic claims, stale-state cleanup, metadata compatibility, and path
  layouts.
- `DaemonServer` and `RemoteStack` integration tests cover JSON/SSE translation and typed failures
  on real Unix sockets.
- Entry-point tests pin Bun/Node export selection and daemon paths.
- Targeted CLI e2e tests cover detached start, status, logs, stop, and live compiled-binary behavior.
