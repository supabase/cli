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

The managed supervisor owns the port lease, service processes, and one complete
loopback HTTP application. It records `starting`, `running`, `failed`, and
`stopped` in `stack.json`. `SupervisorSession` owns one command queue and actor
fiber; stop requests from HTTP, signals, startup failure, and explicit disposal
all join that serialized state machine.

The application is assembled before the deterministic listener binds and has
only three routes:

- `GET /owner` projects the lifecycle state, readiness, owner session, and
  daemon CLI version;
- `POST /stop` accepts an ownership id and exact owner session id, returns a
  flushed `202`, and lets the caller wait for that session to end; and
- `POST /rpc` serves same-version Effect RPC over framed NDJSON when
  `SupervisorSession.runtimeStack` has published the runtime. Requests carry
  the expected ownership id and owner session; a stale session fence is
  rejected before a handler runs. Before runtime publication, handlers
  fail fast with typed `StackUnavailableError`.

Graceful remote stop therefore uses the stable session-fenced control route,
waits for the targeted owner session and document transition, then lets the
owner dispose the runtime before releasing control. A stale delayed stop gets
`409` from the new owner and cannot tear it down.

Every shutdown source submits to one session actor. Once accepted, the actor
publishes `stopping`, interrupts and joins startup, attempts runtime stop and
disposal, closes the runtime scope, persists terminal state, and closes the
ownership listener last, even when an earlier step fails. It preserves the
first cleanup failure and its exact `Cause` after all steps have run. Node and
Bun close listeners gracefully after flushing the
accepted `202`; the stable client drains that response and then polls the exact
session fence, so listener shutdown cannot be stranded by an unread body.

If the owner is gone, the next lifecycle operation acquires control for the
stack id, force-removes deterministic Docker containers, reconciles persisted
assignments, and records `stopped`. It does not probe PIDs or trust stale
runtime artifacts. The control endpoint is deterministic from the stack id and
is validated before an attached client connects.

The endpoint is runtime coordination state, not the public API proxy URL. Node,
Bun, and compiled-Bun children use the same static application and lifecycle
composition; the same server owns every lifecycle phase.

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
startup/reattach/launch-update over RPC, stop during every startup phase,
session-fenced stop, upgrade restart with actual
excluded-service and sticky-port preservation, cancellation, failed-step
cleanup, and delete. The process-compose and stack suites cover supervised
child trees, Docker cleanup hooks, one-shot exit observation, and
Node/Bun/compiled-Bun re-entry. Node and Bun control adapters exercise the
same conflict classification. Leak helpers compare managed document and
runtime roots, temporary Postgres paths, processes, and containers before and
after each journey.

## Platform notes

Unix and Linux use process-group supervision where available; Windows uses the
platform tree-termination backend. Docker services and structured probes do not
depend on Bash wrappers. The control transport is provided by the Node/Bun
platform adapter, while managed identity and cleanup remain platform-neutral.
