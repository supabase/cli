# @supabase/stack

Programmatic local Supabase for TypeScript. `createStack()` returns a ready stack with Postgres
running and a stable local gateway. Supabase sidecars are available through that gateway and are
prepared and started only when first used.

## Quick start

```ts
import { createClient } from "@supabase/supabase-js";
import { createStack } from "@supabase/stack";

await using stack = await createStack();
const supabase = createClient(stack.url, stack.publishableKey);

const { data, error } = await supabase.from("todos").select();
```

There is no second startup step: once `createStack()` resolves, Postgres and the local API gateway
are ready. The first request to `/rest/v1`, `/auth/v1`, `/storage/v1`, `/realtime/v1`, or another
service route prepares that service's binary or image, adds it to the supervisor, starts it, and
waits for readiness before forwarding the request.

Use `await using` when possible. Otherwise call `await stack.dispose()` in `finally`; cleanup is
strict and rejects if processes, containers, or auto-managed paths could not be removed.

## Selecting services

Postgres is always present. `services` explicitly controls which sidecars are available. When it
is omitted in `auto` or `docker` mode, every Supabase sidecar is available lazily. There are no
presets.

```ts
await using stack = await createStack({
  services: ["postgrest", "auth", "realtime"],
});
```

Configuration for an unselected service is rejected, which keeps the effective stack explicit:

```ts
await using stack = await createStack({
  services: ["postgrest", "auth"],
  postgrest: { schemas: ["public", "api"] },
  auth: { siteUrl: "http://localhost:3000" },
});
```

`native` mode defaults to the native-capable `postgrest` and `auth` sidecars. Docker-only services
must be used with `auto` or `docker` mode.

## Starting services eagerly

Use `startServices` when a test needs selected services ready before `createStack()` returns. This
does not change which services are available.

```ts
await using stack = await createStack({
  services: ["postgrest", "auth", "storage", "imgproxy"],
  startServices: ["postgrest", "auth"],
});
```

Dependencies are activated automatically. For example, eagerly starting `imgproxy` also starts
`storage`, but both must be listed in `services`.

## Parallel tests

Every omitted port is allocated automatically. Allocation is leased through a cross-process
registry, so independent test workers can safely create stacks concurrently.

```ts
import { afterAll, beforeAll, describe, test } from "vitest";
import { createStack, type StackHandle } from "@supabase/stack";

describe.concurrent("feature", () => {
  let stack: StackHandle;

  beforeAll(async () => {
    stack = await createStack({ services: ["postgrest"] });
  });

  afterAll(async () => {
    await stack.dispose();
  });

  test("uses an isolated database", async () => {
    // stack.dbUrl and stack.url are unique to this stack
  });
});
```

Provide `postgres.dataDir` when data should survive disposal. Otherwise Stack creates and removes
an isolated temporary data directory.

## Configuration

```ts
const stack = await createStack({
  mode: "auto", // "native" | "auto" | "docker"
  port: 54321, // gateway port; optional
  postgres: {
    port: 54322, // optional
    dataDir: "./supabase-data", // optional
    version: "17.6.1.143",
  },
  services: ["postgrest", "auth", "edge-runtime"],
  startServices: ["postgrest"],
  projectDir: ".",
  functions: { noVerifyJwt: false },
});
```

`auto` prefers native binaries and falls back to Docker. `docker` forces containers. All explicit
ports are checked and leased atomically before startup; a conflict rejects creation.

## Stack handle

Connection properties:

- `url`: stable HTTP and WebSocket gateway URL
- `dbUrl`: PostgreSQL connection string
- `publishableKey`: opaque client key accepted by the local gateway
- `secretKey`: opaque privileged key accepted by the local gateway

Lifecycle methods:

```ts
await stack.stop();
await stack.start(); // restart after stop; waits for Postgres and startServices
await stack.startService("auth");
await stack.stopService("auth");
await stack.restartService("auth");
await stack.dispose();
```

Readiness, status, and logs:

```ts
await stack.ready({ timeout: 30_000 });
await stack.serviceReady("auth", { timeout: 10_000 });

const status = await stack.getStatus();
for await (const state of stack.statusChanges()) console.log(state);
for await (const entry of stack.logs()) console.log(entry);
const recentAuthLogs = await stack.logHistory("auth", 100);
```

`ready()` waits only for services that were actually started. Available lazy services remain
`Pending` until first use or an explicit `startService()` call.

For preload-required extensions, `ensureExtensionPreload(name)` persists the required
`shared_preload_libraries` entry and restarts Postgres only when necessary. It does not execute
`CREATE EXTENSION`.

## Prefetching

Prefetch assets in a test runner's global setup when cold-start download time is undesirable:

```ts
import { prefetch } from "@supabase/stack";

await prefetch({ services: ["postgres", "postgrest", "auth"] });
```

Prefetching is optional; normal stack startup and first-use activation prepare only what is needed.

## Advanced entry points

The root package is the primary public interface and selects Bun or Node automatically:

```ts
import { createStack } from "@supabase/stack";
```

Infrastructure that already owns a pre-initialized Postgres data directory can use the deeper
constructor. It is intentionally kept off the root interface:

```ts
import { createProvisionedStack } from "@supabase/stack/provisioned";

const stack = await createProvisionedStack({
  stackRoot: "/var/lib/supabase/pods/example/stack",
  dataDir: "/var/lib/supabase/pods/example/data",
  postgresPassword: "postgres",
  services: ["postgrest"],
});
```

Effect consumers can use `@supabase/stack/effect` for the lower-level stopped controller and
layer APIs.

Long-lived hosts that manage many named stacks can use Fleet. It keeps stable database and API
endpoints while entire stacks suspend, and adds copy-on-write provisioning, reset, and fork:

```ts
import { createFleet } from "@supabase/stack/fleet";

await using fleet = await createFleet();
const pod = await fleet.createPod({ start: false });
```

Fleet is intended for CLI-daemon and environment-hosting workloads. Prefer direct `createStack()`
instances for ordinary parallel tests; see [Fleet](./docs/fleet.md) for the decision guide.

## Errors

Public methods reject with `StackError`, whose `code` distinguishes failures such as
`SERVICE_NOT_FOUND`, `SERVICE_NOT_READY`, `BUILD_ERROR`, `BINARY_NOT_FOUND`, `DOWNLOAD_ERROR`,
`PORT_CONFLICT`, and `PORT_ALLOCATION`.

## Architecture

- [Architecture](./docs/architecture.md)
- [Fleet](./docs/fleet.md)
- [Detached mode](./docs/detach-mode.md)
- [Resource cleanup](./docs/resource-leak-mitigations.md)
