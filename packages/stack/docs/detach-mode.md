# Detach Mode

## Context

The local stack currently runs in the foreground, blocking the terminal. Users (both humans and AI agents) need a way to start the stack in the background and manage it via CLI commands. This design combines insights from process-compose (Go) and Prisma CLI (Node.js) detach implementations, adapted for our Effect-based Bun monorepo.

---

## Design Decisions

- **Approach**: Fork daemon process with Unix socket management API (Prisma-style fork + process-compose-style HTTP API)
- **Named instances**: Auto-derived from project directory basename, overridable with `--name`
- **Log access**: On-demand streaming via SSE from daemon process (LogBuffer already exists in process-compose)
- **MVP commands**: `start --detach`, `stop`, `status`/`ls`, `logs`
- **Future commands**: `restart`, `attach` (reconnect interactive TUI), per-service control
- **Package boundaries**: Daemon code in `@supabase/local`, CLI commands in `@supabase/cli`, `@supabase/process-compose` untouched
- **Cross-platform**: Works on macOS, Linux, and Windows 10+ (Unix sockets supported since Build 17063)

---

## Architecture

```
User runs: supa start --detach
                │
                ▼
        ┌──────────────┐
        │   CLI (cli/)  │  Forks daemon, waits for IPC "started" msg,
        │  start -d     │  writes state file, prints connection info, exits
        └───────┬───────┘
                │ fork (detached, stdio: ignore)
                ▼
        ┌──────────────────┐
        │  Daemon Process   │  Lives in @supabase/local
        │  (daemon.ts)      │
        │                   │
        │  ┌─────────────┐  │
        │  │ createStack()│  │  Creates full Stack (Orchestrator, ApiProxy, etc.)
        │  └──────┬──────┘  │
        │         │          │
        │  ┌──────▼──────┐  │
        │  │ Mgmt HTTP    │  │  Unix socket: ~/.supabase/stacks/<name>/daemon.sock
        │  │ Server       │  │  Endpoints: /health, /status, /stop, /logs
        │  └─────────────┘  │
        └──────────────────┘
```

### State Directory

```
~/.supabase/stacks/
  └── my-project/                # derived from project dir basename
      ├── state.json             # pid, ports, socketPath, startedAt, projectDir
      └── daemon.sock            # Unix domain socket for management API
```

### State File Format

```json
{
  "pid": 12345,
  "name": "my-project",
  "projectDir": "/Users/jgoux/Code/myapp",
  "apiPort": 54321,
  "dbPort": 54322,
  "socketPath": "/Users/jgoux/.supabase/stacks/my-project/daemon.sock",
  "startedAt": "2026-03-03T10:00:00Z",
  "url": "http://127.0.0.1:54321",
  "dbUrl": "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  "publishableKey": "eyJ...",
  "secretKey": "eyJ...",
  "anonJwt": "eyJ...",
  "serviceRoleJwt": "eyJ...",
  "dockerContainerNames": ["supa-postgres-54321", "supa-postgrest-54321", "supa-auth-54321"]
}
```

The `publishableKey`, `secretKey`, `anonJwt`, and `serviceRoleJwt` fields are needed so CLI
commands like `status` can display connection info without querying the daemon. The
`dockerContainerNames` field enables crash recovery — `supa stop` can force-remove orphaned
Docker containers even when the daemon process is dead and unreachable via the socket.

---

## Package Changes

### `@supabase/process-compose` — No changes

### `@supabase/local` — New additions

| File                  | Purpose                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/daemon.ts`       | Shared daemon logic: `runDaemon(platformFactory)`. IPC handling, lifecycle, signal management            |
| `src/daemon-bun.ts`   | Bun daemon entry point. Imports Bun platform factory, calls `runDaemon()`. Forked by CLI (Bun)           |
| `src/daemon-node.ts`  | Node daemon entry point. Imports Node platform factory, calls `runDaemon()`. For Node consumers          |
| `src/DaemonServer.ts` | Management HTTP server (Effect-based, Unix socket). Exposes the in-process `Stack` over HTTP             |
| `src/RemoteStack.ts`  | Implements the `LocalStack` Effect Service interface over HTTP/SSE, connecting to a daemon's Unix socket |
| `src/StateManager.ts` | Read/write/scan state files in `~/.supabase/stacks/`. Stale state detection (dead PID + failed health)   |
| `src/internals.ts`    | Export new modules for CLI consumption                                                                   |

### Transparent Effect Service interface

The CLI uses Effect V4 and already consumes `LocalStack` as an Effect Service (via
`internals.ts`). Rather than using the Promise-based `Stack` interface, the CLI and
`RemoteStack` both operate at the Effect level.

There are two layers of API:

- **`LocalStack`** (Effect Service) — used by CLI and other Effect consumers.
  Returns `Effect`s and `Stream`s. This is the internal API.
- **`Stack`** (Promise-based) — used by non-Effect library consumers via `createStack()`.
  Returns `Promise`s and `AsyncIterable`s. This public API is unchanged.

`RemoteStack` implements the same `LocalStack` Effect Service interface, but backed
by HTTP/SSE over a Unix socket instead of in-process orchestration. The CLI switches
between them via **Layers** — no branching in CLI code:

```
// Foreground: provide the in-process layer
const layer = LocalStack.layer(config).pipe(Layer.provide(...));

// Detached: provide the remote layer
const layer = RemoteStack.layer(socketPath);

// CLI code is identical — just consumes the LocalStack tag
Effect.gen(function* () {
  const stack = yield* LocalStack;
  yield* stack.start();
  yield* stack.subscribeAllLogs().pipe(Stream.runForEach(renderLog));
});
```

`RemoteStack` translates each Effect/Stream method to the corresponding HTTP call:

| LocalStack method          | RemoteStack transport                                       |
| -------------------------- | ----------------------------------------------------------- |
| `start()`                  | `POST /start` → `Effect`                                    |
| `stop()`                   | `POST /stop` → `Effect`                                     |
| `getInfo()`                | `GET /status` → `Effect` (extract connection info)          |
| `getAllStates()`           | `GET /status` → `Effect` (extract service states)           |
| `getState(name)`           | `GET /status` → `Effect` (filter by name)                   |
| `allStateChanges()`        | `GET /status/stream` (SSE → `Stream`)                       |
| `stateChanges(name)`       | `GET /status/stream` (SSE → `Stream`, filter by name)       |
| `waitReady(name)`          | `GET /status/stream` (SSE → `Stream`, take until ready)     |
| `waitAllReady()`           | `GET /status/stream` (SSE → `Stream`, take until all ready) |
| `subscribeAllLogs()`       | `GET /logs` (SSE → `Stream`)                                |
| `subscribeLogs(name)`      | `GET /logs/:name` (SSE → `Stream`)                          |
| `logHistory(name, limit?)` | `GET /logs/:name/history?limit=N` → `Effect`                |
| `startService(name)`       | `POST /services/:name/start` → `Effect`                     |
| `stopService(name)`        | `POST /services/:name/stop` → `Effect`                      |
| `restartService(name)`     | `POST /services/:name/restart` → `Effect`                   |

Note: `start()`, per-service control, and `logHistory` are included for completeness.
In the MVP, the CLI only uses a subset (status, logs, stop). The full mapping ensures
`RemoteStack` is a drop-in replacement for `LocalStack` in any Effect consumer.

Benefits of using Effect throughout:

- **`Stream`** instead of `AsyncIterable` — composable with `Stream.runForEach`, `Stream.take`, timeouts, etc.
- **`Effect`** instead of `Promise` — typed errors, cancellation, retries
- **Layer system** handles the wiring — the CLI never checks "am I foreground or detached?"
- SSE response body maps naturally to `Stream` (via `Stream.fromReadableStream` or `Stream.async`)

**Daemon entry points** follow the same split as `bun.ts`/`node.ts`:

- `daemon.ts` exports `runDaemon(platformFactory)` — shared logic, not executable
- `daemon-bun.ts` — Bun entry point, forked by CLI
- `daemon-node.ts` — Node entry point, for Node consumers

**Daemon lifecycle (`runDaemon`):**

1. Receive serializable `StackConfig` via IPC message from parent
2. Call `createStack(config, platformFactory)` — reuses existing API
3. Call `stack.start()`
4. Start management HTTP server on Unix socket
5. Send IPC `{ type: "started", info: { url, dbUrl, ... } }` to parent
6. Parent disconnects — daemon keeps running
7. On SIGTERM/SIGINT or POST `/stop`: call `stack.dispose()`, clean up state files, exit

**IPC startup handshake:**

IPC (Inter-Process Communication) is how the CLI and daemon exchange data during startup.
When `child_process.fork()` creates the daemon, it establishes a built-in IPC channel
between parent and child. They send JSON messages via `process.send()` / `process.on("message")`.

This channel is only used for the initial startup handshake — once the daemon confirms
it's ready (or reports an error), the CLI disconnects the channel. All subsequent
communication (stop, status, logs) happens over the Unix socket HTTP API instead.

```
CLI (parent)                          Daemon (child)
     │                                      │
     │── fork(daemon.ts, {                  │
     │     detached: true,                  │
     │     stdio: "ignore"                  │
     │   }) ───────────────────────────────▶│
     │                                      │── createStack(config)
     │                                      │── stack.start()
     │                                      │── start mgmt HTTP server
     │                                      │
     │◀── { type: "started", info: ... } ───│  (IPC message: "I'm ready")
     │                                      │
     │── child.disconnect()  ──────────────▶│  (close IPC channel)
     │── child.unref()  ───────────────────▶│  (allow parent to exit)
     │                                      │
     │  CLI prints connection info & exits  │  Daemon keeps running independently
     │                                      │  Managed via Unix socket from now on
```

If the daemon fails to start, it sends `{ type: "error", error: ... }` instead,
and the CLI displays the error and exits with a non-zero code.

**Management HTTP endpoints:**

| Endpoint                 | Method | Description                                           |
| ------------------------ | ------ | ----------------------------------------------------- |
| `/health`                | GET    | Liveness check (200 OK)                               |
| `/status`                | GET    | All service states + connection info (JSON)           |
| `/status/stream`         | GET    | SSE stream of all service state changes               |
| `/stop`                  | POST   | Graceful shutdown → dispose + exit                    |
| `/logs`                  | GET    | SSE stream of all logs                                |
| `/logs/:service`         | GET    | SSE stream for one service                            |
| `/logs/:service/history` | GET    | Recent log entries for one service (JSON, `?limit=N`) |

### `@supabase/cli` — New/modified commands

**Modified: `src/commands/start/`**

- New flags: `--detach` / `-d`, `--name` / `-n`
- When `--detach`: fork daemon, wait for IPC "started", write state file, print connection info, exit
- When foreground (default): unchanged behavior

**New: `src/commands/stop/`**

- Args: `[name]` (positional, optional — resolved from cwd if omitted)
- Flags: `--all` (stop all running stacks)
- Reads state file, sends POST `/stop` to daemon socket, waits for process exit
- With `--all`: scans all stacks, stops each one

**New: `src/commands/status/`**

- Scans `~/.supabase/stacks/`, checks each daemon's health, displays table
- Columns: name, status (running/crashed), ports, uptime, projectDir

**New: `src/commands/logs/`**

- Args: `[name]` (positional, optional — resolved from cwd if omitted)
- Flags: `--service <name>` (optional, filter to one service)
- Connects to daemon SSE endpoint, streams to stdout

### Stack name resolution

When a command like `supa stop` or `supa logs` is run without an explicit `--name`,
the CLI needs to figure out which stack the user is referring to. This must work from
any subdirectory within the project (e.g. `src/components/`), and must be zero-config
(no anchor file required).

**Algorithm:**

1. Read all `~/.supabase/stacks/*/state.json` files → collect their `projectDir` values
2. Walk from `cwd` upward: `cwd`, `parent(cwd)`, `parent(parent(cwd))`, ...
3. At each level, check if the absolute path matches any stack's `projectDir`
4. First match wins → use that stack's name and socket path

**Examples:**

- cwd = `/Users/jgoux/Code/myapp/src/components/`
- Stack `myapp` has `projectDir: "/Users/jgoux/Code/myapp"`
- Walk: `.../src/components/` (no match) → `.../src/` (no match) → `.../myapp/` (match!)
- Resolved stack: `myapp`

**Edge cases:**

- No match after walking to filesystem root → error: "No running stack found for this directory"
- Multiple stacks match (nested projects) → innermost (first) match wins
- Explicit `--name` always takes precedence, skipping resolution entirely

---

## Error Handling

| Scenario                                | Behavior                                                                                                                                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Port already in use                     | Daemon sends IPC error before parent exits; CLI shows error                                                                                                                                                |
| Name collision (already running)        | State file exists + daemon alive → error with connection info                                                                                                                                              |
| Daemon crashes                          | State becomes stale. `status` detects dead PID, shows "crashed". `stop` cleans up state + Docker containers                                                                                                |
| Orphaned Docker containers              | `stack.dispose()` calls `dockerForceRemove()`. On crash, `stop` reads state, force-removes known containers                                                                                                |
| Ctrl+C during `start --detach`          | If daemon hasn't started: kill child. If started: daemon keeps running                                                                                                                                     |
| Foreground start while detached running | `supa start` (foreground) checks StateManager first. If a daemon is running for the same project, error with "Stack already running in detached mode. Use `supa stop` first or `supa logs` to see output." |
| Detached start while foreground running | Port allocation will fail (ports already bound), daemon sends IPC error. No special detection needed — the existing port conflict handling covers this.                                                    |

---

## Testing Strategy

1. **Unit tests** on `StateManager` — pure file operations, mock filesystem
2. **Integration tests** on `RemoteStack`/`DaemonServer` — test HTTP API with real Unix socket, verify Effect/Stream round-trip
3. **Integration tests** on CLI handlers — mock `LocalStack` via `Layer.succeed`, assert on output/state (same pattern as existing CLI tests)
4. **E2e tests** — spawn real `supa start --detach`, verify startup, `supa status` shows it, `supa stop` stops it

---

## Verification

1. `supa start --detach` — daemon starts, connection info printed, terminal returns
2. `supa status` — shows running stack with name, ports, uptime
3. `supa logs` — streams real-time logs from daemon
4. `supa stop` — graceful shutdown, Docker containers removed, state cleaned up
5. `supa start --detach && supa start --detach` — second invocation shows "already running"
6. Kill daemon with `kill <pid>`, then `supa status` — shows "crashed", `supa stop` cleans up

---

## Future Improvements

### Reattach (`supa attach [name]`)

Reconnects an interactive TUI to a running detached daemon. The HTTP daemon design
makes this straightforward — the attach command is just an HTTP client rendering a TUI,
connecting to the same endpoints that `supa status` and `supa logs` use.

```
supa attach [name]
     │
     ▼
  1. Read state file → find daemon socket
  2. GET /status → render current service states
  3. GET /logs → open SSE stream → render logs in real-time
  4. Same interactive TUI as foreground mode, but fed by HTTP
     instead of in-process Effect streams
     │
     ▼
  On Ctrl+C → just disconnect (daemon keeps running)
```

Key difference from foreground mode:

- **Foreground**: TUI consumes in-process `LocalStack` Effect Service (Effect `Stream`s)
- **Attached**: TUI consumes `RemoteStack` Effect Service (same `Stream` interface, backed by SSE over Unix socket)

Ctrl+C when attached means **detach** (daemon keeps running), not stop. The user ran
detached intentionally — if they want to stop, they use `supa stop`. This matches
`tmux`/`screen` behavior.

No additional daemon-side work is required — the management API already exposes
everything the TUI needs.

### Restart (`supa restart [name]`)

Restart all services in a running detached stack without tearing down the daemon.
Requires a new `POST /restart` endpoint on the management API that calls
`stack.stop()` followed by `stack.start()`.

### Per-service control

Expose per-service start/stop/restart for detached stacks:

- `supa service start <service> [--name <stack>]`
- `supa service stop <service> [--name <stack>]`
- `supa service restart <service> [--name <stack>]`

Requires new management API endpoints: `POST /services/:name/start`, `/stop`, `/restart`.
The underlying `stack.startService()`, `stack.stopService()`, `stack.restartService()`
methods already exist.

### File-based log persistence

Optionally write logs to disk in addition to in-memory buffering, for post-crash analysis.
Could be enabled via a `--persist-logs` flag on `supa start --detach`. Logs would go to
`~/.supabase/stacks/<name>/logs/`.

---

## Research: Prior Art

### Process-Compose (Go)

Source: `.repos/process-compose/`

**Detach mechanism**: Self re-exec with `Setsid: true` (`src/cmd/project_runner_unix.go:13-44`). Strips `--detached` flag, adds `-t=false`, redirects stdio to `/dev/null`.

**Management**: Full HTTP API (28 REST endpoints) over Unix domain sockets (`/tmp/process-compose-<PID>.sock`). WebSocket log streaming. CLI acts as HTTP client (`src/client/client.go`).

**Key commands**: `attach` (reconnect TUI), `down` (stop), `process start/stop/restart`, `logs`, `list`.

**Key patterns**:

- Self-re-exec with session detach (not fork)
- PID-based socket naming for unique identification
- Full HTTP API enables rich remote management
- No PID file — uses socket existence for discovery

### Prisma CLI (Node.js)

Source: `@prisma/cli-dev` npm package (v0.15.0), `@prisma/dev/internal/daemon`

**Detach mechanism**: `child_process.fork()` with `{detached: true, stdio: "ignore"}`. IPC for startup coordination (`"started"`/`"error"` messages), then `disconnect()`/`unref()`.

**State management**: Filesystem-based `ServerState` (`@prisma/dev/internal/state`). Named instances with glob matching. `ServerState.scan()`, `isServerRunning()`, `killServer()`, `deleteServer()`.

**Key commands**: `ls` (list), `start <glob>`, `stop <glob>`, `rm <glob>`.

**Key patterns**:

- `fork()` + IPC for startup coordination, then disconnect/unref to release
- Persistent state store for tracking instances across CLI invocations
- Named instances with glob-based matching for multi-project support
- No HTTP API — management through state files + process signals

### Comparison

| Aspect          | process-compose    | Prisma                | Our approach            |
| --------------- | ------------------ | --------------------- | ----------------------- |
| Detach method   | Re-exec + Setsid   | fork + detached       | fork + detached         |
| Management IPC  | HTTP + Unix socket | State files + signals | HTTP + Unix socket      |
| Log streaming   | WebSocket          | None                  | SSE                     |
| Named instances | Socket path        | `--name` flag         | Auto-derived + `--name` |
| Windows support | No                 | Yes                   | Yes                     |
