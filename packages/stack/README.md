# `@supabase/stack`

The local Supabase stack runtime. Its public API is a greenfield,
Effect-native managed runtime; implementation modules are private to the
package.

The supported entrypoints are:

- `@supabase/stack` — Promise facade
- `@supabase/stack/effect` — Effect-native API
- `@supabase/stack/testing` — test helpers

Stacks are managed identities: closing a handle does not stop a running stack. Creating or opening a
handle starts nothing, and a stopped stack retains no Supervisor, workload, container, network, or
listener. Status and retained logs remain available directly from durable state while stopped; a
later start on the same handle launches a fresh Supervisor.
With no configuration override, all capabilities are enabled, PostgreSQL is the only eager
capability, and every other capability is lazy. Starting the stack therefore launches only
PostgreSQL by default; capabilities configured as eager join its startup dependency closure.
The remaining lazy capabilities activate through the stack's listeners on demand for the current
running session.

Artifact preparation is controlled independently from capability activation through the optional
top-level `preparation` setting:

```ts
await stack.start({ config: { preparation: "on-demand" } });
```

The default `"background"` mode prepares all enabled lazy artifacts after PostgreSQL has started,
without launching those services. A single Supervisor-owned background operation runs with bounded
concurrency, is canceled and awaited by `stop()` or `destroy()`, and keeps completed cache entries.
`"on-demand"` skips that background work for callers that want full lazy preparation. In either
mode, activating a lazy service prepares its requested dependency closure concurrently, while
explicit `stack.prepare(...)` remains available as a cache-only warmup. Eager capabilities remain
independent of this preparation policy. The setting is persisted with the stack definition and
survives `openStack()` and restart. Changing it for a running stack follows the existing
stop-before-change configuration rule.

Running status includes an artifacts array for the current session. Each entry identifies a
workload and capability and reports `queued`, `preparing`, `downloading`, `ready`, or
`failed`; `failed` includes an error message and can be retried by activating the capability again.
`preparing` covers validation, verification, and extraction around the transfer. During stopping
or destroying, status may retain active preparation until teardown clears it. Once stopped, status
reports an empty array even when completed artifacts remain in the cache.

Explicit `stack.prepare(...)` accepts a synchronous `onProgress` callback for
caller-owned preparation. It receives the same phase values, including `ready` when an artifact is
available while its capability remains dormant. This transfer-local callback is not reconstructed by
a separate status request.

The package's end-to-end contract is exercised through the same public Stack API in native and
Docker modes. It begins from the PostgreSQL-only default, progressively activates every service with
realistic traffic, and verifies stop/start cycles, stable ports, and persistent data. The
CLI is not involved in these runtime tests.

Podman is supported only on local Linux hosts and must be selected explicitly; the runtime does not
auto-detect container engines.

`createTestStack` gives each test stack a unique temporary project root and identity while sharing
the managed state root used by ordinary package and CLI callers. Automatic ports therefore
coordinate across all default callers. Helper project roots and identities remain isolated; a
temporary test stack is excluded from the current CLI project-scoped listing but appears in an
unfiltered package `listStacks()` result. A failed destroy retains the affected project root and
managed state for recovery.

Callers can warm selected native artifacts or container images with `stack.prepare(...)` while a
stack is stopped or running; explicit preparation is cache-only and cancellation does not affect
completed entries.
Each capability may opt into eager activation in `StackConfig`; omitted settings keep every
non-PostgreSQL capability lazy. Prepared artifacts are not automatically pruned. `followLogs(...)`
provides filterable live entries through a stateless client-polled cursor.

Database reset is intentionally outside the current API. Applying migrations, declarative schemas,
and seeds remains the caller's responsibility. The runtime bootstrap only reconciles the `_realtime`
schema owner, closed database role passwords, and JWT settings in one transaction; the slim database
artifact owns its initialization and migrations.
