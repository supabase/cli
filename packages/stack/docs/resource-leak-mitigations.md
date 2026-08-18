# Resource leak mitigations

The local stack must release processes, Docker containers, port leases, data
directories, and managed runtime files when startup fails, a foreground command
is interrupted, or a detached owner is stopped or crashes.

## Shared disposal

`Stack.dispose()` uses the shared cleanup path in `src/cleanup.ts`:

- run `stack.stop()` uninterruptibly;
- force-remove the exact Docker container names derived from the managed stack
  id; and
- retry removal of auto-managed Postgres directories.

Foreground and detached runtimes use this path. Managed lifecycle state is
recorded by `ManagedStackManager` in the single stack document; cleanup does not
write a second StateManager metadata file.

## Detached owner cleanup

The managed supervisor owns the port lease, service processes, and local control
endpoint. It records `starting`, `running`, `failed`, and `stopped` in
`stack.json`. Graceful stop calls the owner through `RemoteStack` and waits for
the document to become `stopped` before a caller may delete it.

If the owner is gone, the next lifecycle operation acquires control for the
stack id, force-removes deterministic Docker containers, reconciles persisted
assignments, and records `stopped`. It does not probe PIDs or trust stale
runtime artifacts.
The control endpoint is deterministic from the stack id and is validated before
an attached client connects.

The child uses `DaemonServer` over the deterministic loopback TCP control
transport. The endpoint is runtime coordination state, not the public API
proxy URL.

## Process supervision

`@supabase/process-compose` service definitions use declarative supervision:

- a supervisor owns the child process tree;
- stdout and stderr are forwarded to the orchestrator;
- abrupt parent death closes the supervisor's owner pipe; and
- platform-specific termination and cleanup actions tear down descendants.

Docker-backed service definitions retain a normal cleanup hook (`docker rm -f`)
as a second line of defense after signal-based shutdown. Structured exec probes
use explicit commands and arguments rather than shell strings.

## Foreground and signals

Foreground start installs a command-level `SIGINT`/`SIGTERM` cleanup effect and
waits for disposal to begin before interrupting the main Effect. Direct
`createStack()` callers receive the same finalizer through the scoped handle.

## Regression coverage

Integration tests cover manager port/document cleanup, detached supervisor
startup/reattach/launch-update/stop, stale-owner recovery, and delete. The
process-compose and stack suites cover supervised child trees, Docker cleanup
hooks, and one-shot exit observation. Leak helpers compare managed document and
runtime roots, temporary Postgres paths, processes, and containers before and
after each journey.

## Platform notes

Unix and Linux use process-group supervision where available; Windows uses the
platform tree-termination backend. Docker services and structured probes do not
depend on Bash wrappers. The control transport is provided by the Node/Bun
platform adapter, while managed identity and cleanup remain platform-neutral.
