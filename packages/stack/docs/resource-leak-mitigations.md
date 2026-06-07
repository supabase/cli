# Resource Leak Mitigations

## Goal

The local stack must clean up all resources when startup fails, when the CLI exits normally, when
the foreground process is interrupted, and when detached-mode daemons are stopped later.

The main leak classes we harden against are:

- orphaned child processes (`postgres`, `postgrest`, `auth`, `docker run`, detached daemons)
- orphaned Docker containers
- leaked auto-managed Postgres data directories
- stale stack state and socket files
- one-shot orchestration races that leave dependents hanging

## Mitigations

### 1. Shared stack disposal path

`Stack.dispose()` routes through one shared cleanup path in `src/cleanup.ts`.

That path:

- runs `stack.stop()` inside `Effect.uninterruptible`
- force-removes exact persisted Docker cleanup targets as a safety net
- retries removal of auto-managed PGDATA directories for a short period

This gives foreground CLI, detached daemon shutdown, and `createStack()` the same cleanup behavior.
The exact Docker cleanup targets are no longer inferred from the public `StackInfo` shape. They are
produced during preparation/build, stored as internal runtime metadata, and persisted for daemon
crash recovery through `StateManager` metadata updates.

### 2. Foreground signal-aware disposal

Foreground `start` paths install a local signal cleanup effect in
`supabase/src/commands/start/signal.ts`.

That effect:

- listens for `SIGINT` and `SIGTERM`
- runs `stack.dispose()` uninterruptibly
- interrupts the foreground Effect only after disposal has started

The attached and non-interactive foreground start handlers both race their main work against this
signal-aware disposal path.

Additionally, the CLI entrypoint avoids the usual global `runMain` interrupt path for `start` and
uses an explicit runner instead. That keeps cleanup owned by the command-level disposal logic.

### 3. Platform-neutral supervised services

`@supabase/process-compose` now supports declarative service supervision through
`ServiceDef.supervision`.

When supervision is enabled, the orchestrator launches a small supervisor process instead of the
service command directly. That supervisor:

- spawns the real service command
- forwards service stdout and stderr back to the orchestrator
- detects abrupt parent death through its stdin pipe closing
- terminates the full child tree on shutdown or orphaning
- runs orphan-safe cleanup actions after forced teardown

This replaces the old Bash parent-watch wrapper and moves lifecycle ownership into
`@supabase/process-compose`.

### 4. Cross-platform tree termination backends

The supervisor uses platform-specific termination internally:

- Unix: process-group signaling for the supervised child tree
- Windows: `taskkill /T /F` for tree termination

That keeps the service definition API platform-neutral while still using the strongest available
backend per host.

Outside the supervisor path, the orchestrator now only signals the direct child process it spawned.
Full child-tree ownership is reserved for supervised services.

### 5. Service cleanup hooks

`@supabase/process-compose` service defs can still register a normal `cleanup` Effect.

We use this for Docker-backed services so the normal stop path has a second line of defense:

- signal the service
- wait for exit
- run `docker rm -f <container>`

The new supervisor cleanup actions cover abrupt parent death; the existing `cleanup` Effect covers
the ordinary orchestrator-managed path.

### 6. Shell-free exec probes

`@supabase/process-compose/src/HealthProbe.ts` now supports structured exec probes with
`command`, `args`, and `env`.

We use that for checks such as:

- `pg_isready` with explicit arguments and library-path env
- `docker exec ... pg_isready` without relying on `sh -c`
- file checks and similar probe helpers as direct commands with explicit arguments

### 7. Better one-shot exit observation

`@supabase/process-compose/src/Orchestrator.ts` has a one-shot fallback that avoids hangs when very
short-lived processes exit before `handle.exitCode` resolves cleanly.

That fallback now:

- waits for the handle's `isRunning` signal instead of probing raw OS PIDs
- gives `handle.exitCode` a short grace window to report the real exit code
- only falls back to exit code `0` if the handle never reports one

This prevents failed one-shot services from being misclassified as clean exits.

### 8. Detached startup cleanup without Unix group kill

Pending detached-daemon startup cleanup in `src/layers.ts` now terminates the daemon through a
direct child shutdown helper instead of `process.kill(-pid, ...)`.

That keeps the pre-registration cleanup path compatible with the new supervised-service model:

- the parent kills the daemon process directly
- any supervised service children see their owner disappear and self-clean

### 9. Stronger leak regression coverage

We keep leak-focused helpers in `tests/helpers/leaks.ts` to diff before and after snapshots of:

- stack state directories
- daemon sockets
- temp Postgres data directories
- tracked processes tied to a test home dir
- Docker containers

The CLI and stack leak regressions assert that these artifacts disappear after stop, interrupt, or
test shutdown.

## Where each mitigation applies

### Foreground CLI

- local `SIGINT` and `SIGTERM` disposal in CLI handlers
- shared `Stack.dispose()` cleanup
- supervised services in `process-compose`
- Docker cleanup hooks

### Detached daemon mode

- shared `Stack.dispose()` cleanup
- state-manager cleanup for daemon state and socket files
- supervised services in `process-compose`
- direct-child pending-startup cleanup

### Direct library usage via `createStack()`

- runtime finalizer calls shared cleanup
- `stack.dispose()` uses the same shared cleanup path
- supervised services still protect descendants if the owning process dies abruptly

## Platform status

### macOS

Supported for leak mitigation.

Native binaries and Docker fallback services are covered by the current supervision model.

### Linux

Supported for leak mitigation.

The same supervised-service design applies to native binaries and Docker fallback services.

### Windows

Leak mitigation and service supervision are now designed to be platform-neutral.

In particular, Docker-backed stacks do not depend on host-side Bash wrappers anymore:

- Docker services launch directly as `docker` commands
- exec probes can run without `sh -c`
- abrupt-parent-death cleanup is handled by the process-compose supervisor
- child-tree teardown uses a Windows backend instead of Unix negative-PID signaling

Current limitation:

- detached daemon transport is still Unix-socket based (`daemon.sock`, `fetch({ unix })`, socket
  server bind by path)

So the current claim is:

- macOS: supported
- Linux: supported
- Windows leak mitigation for supervised services: supported in design, including Docker fallback
- Windows detached transport and discovery: separate follow-up work

## Current confidence level

Validated by targeted and package-level test runs using `bun run test`.

That verification includes:

- process-compose supervision runtime and structured exec probe tests
- stack service-definition and builder tests for the new supervision model
- leak-focused CLI and stack regressions on the current host platform
