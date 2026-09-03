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
PostgreSQL; traffic through the stack's listeners activates REST, Auth, Realtime, Storage,
Functions, Studio, Mail, Analytics, or Pooler on demand for the current running session.

The package's end-to-end contract is exercised through the same public Stack API in native and
Docker modes. It begins from the PostgreSQL-only default, progressively activates every service with
realistic traffic, and verifies stop/start cycles, stable ports, and persistent data. The
CLI is not involved in these runtime tests.

Podman is supported only on local Linux hosts and must be selected explicitly; the runtime does not
auto-detect container engines.

Callers can warm selected native artifacts or container images with `stack.prepare(...)` while a
stack is stopped; preparation is cache-only and cancellation does not affect completed entries.
Each capability may opt into eager activation in `StackConfig`; omitted settings keep every
non-PostgreSQL capability lazy. `followLogs(...)` provides filterable live entries through a
stateless client-polled cursor.

Database reset is intentionally outside the current API. Applying migrations, declarative schemas,
and seeds remains the caller's responsibility.
