# `@supabase/stack`

Local Supabase stack runtime for Node and Bun. The package has a direct
in-process API and a managed detached API used by the CLI.

## Direct stack

```ts
import { createStack } from "@supabase/stack";

await using stack = await createStack({ projectDir: process.cwd() });
await stack.start();
console.log((await stack.getInfo()).url);
```

The direct handle owns its service processes and port lease. It does not read
managed state or coordinate with sibling worktrees.

## Managed stack

Managed callers use `@supabase/stack/managed` (or the conditional managed Bun
and Node entrypoint) and supply a state root to the manager layer:

```ts
import { managedStackManagerLayer } from "@supabase/stack/managed";

const layer = managedStackManagerLayer({ stateRoot: "/absolute/managed" });
```

The manager persists one document per deterministic stack id under
`<stateRoot>/stacks/<id>/stack.json`. It owns identity discovery, sticky-port
intent, lifecycle transitions, and control ownership. The lifecycle facade
provides `connectManagedStack`, `updateManagedLaunch`, `stopManagedStack`, and
`deleteManagedStack` so consumers do not manipulate documents or control
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
    launch: { mode: "auto", versions: {}, excludedServices: [] },
  });
```

`daemonLayer` starts the managed supervisor. `connectLayer` attaches through
the persisted deterministic control endpoint; `stopDaemon` and the discovery
helpers delegate to the managed lifecycle facade. No CLI metadata file or PID
polling is involved.

## Managed document

The private document records:

- workspace, checkout, branch-context, local-project, and stack-name identity;
- exact or automatic sticky-port assignments;
- launch mode, pinned versions, excluded services, and notification
  fingerprint;
- lifecycle (`starting`, `running`, `stopped`, `failed`, or `deleting`); and
- runtime control endpoint and protocol version while running.

The format is unreleased internal state. It has no compatibility adapter or
SQLite/repository contract. A fresh build owns the current document format.

`workspaceId` identifies local repository or ordinary-folder lineage. It is
unrelated to a remote Supabase project or its `project_id`. In a Git checkout,
`localProjectKey` is the canonical project-root path relative to the checkout
root, normalized with `/` and `.` at the root. Sibling nested projects can
therefore run independent default stacks. Documents store the canonical
project root. Renaming a local project directory intentionally creates a new
identity; no migration is attempted.

## Detached control

The supervisor child hosts `DaemonServer` on the deterministic local control
endpoint. `RemoteStack` provides status, service operations, logs, and graceful
stop. A managed launch update is sent to `/managed/launch` and is written by
the owner under control ownership. The configured API proxy remains the
user-facing service URL.

See [the architecture guide](docs/architecture.md) and
[detached mode](docs/detach-mode.md) for lifecycle and transport details.

## Testing

Integration tests exercise real manager, supervisor, control, and lifecycle
journeys, including sibling worktrees, reattach, launch updates, graceful
stop, stale-owner recovery, and deletion. Unit tests cover pure port/document
algorithms and platform seams. `@supabase/stack/testing` exposes only the
runtime seams needed to build those tests.
