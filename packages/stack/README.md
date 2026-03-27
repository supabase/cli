# @supabase/stack

Programmatic local Supabase stack for TypeScript. Create a local Supabase runtime from code, then control lifecycle, status, and logs through a small async handle.

## Features

- **Single entry point** -- `createStack()` resolves config and returns a handle; `start()` prepares assets, starts services, and waits for readiness
- **Preparation-aware startup** -- cold-cache startup can surface `Downloading` before normal runtime states like `Starting`, `Initializing`, and `Healthy`
- **Native binaries with Docker fallback** -- uses native services when available and falls back to Docker images automatically
- **Automatic port allocation** -- all ports are optional and auto-assigned to avoid conflicts
- **API proxy with opaque keys** -- SDKs use `publishableKey`/`secretKey` (like production), translated to JWTs internally
- **`AsyncDisposable` support** -- use `await using` for automatic cleanup
- **Streaming logs and status** -- real-time `AsyncIterable` streams for service state changes and log output
- **Per-service lifecycle control** -- start, stop, and restart individual services independently

## Installation

```sh
bun add @supabase/stack
```

## Quick Start

```typescript
import { createStack } from "@supabase/stack";

// Zero config — all settings have sensible defaults
const stack = await createStack();
await stack.start();

const supabase = createClient(stack.url, stack.publishableKey);
// ...
await stack.dispose();
```

### With explicit config

```typescript
import { createStack } from "@supabase/stack";
import { createClient } from "@supabase/supabase-js";

const stack = await createStack({
  jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
  postgres: { dataDir: "./supabase-data" },
});

await stack.start();

// Use supabase-js like you would against a hosted project
const supabase = createClient(stack.url, stack.publishableKey);
const { data } = await supabase.from("todos").select("*");

// Clean up
await stack.dispose();
```

### With `await using`

```typescript
{
  await using stack = await createStack({
    jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
    postgres: { dataDir: "./supabase-data" },
  });
  await stack.start();

  // Use the stack...
  // Automatic graceful shutdown when the block exits (even on throw)
}
```

## Configuration

`createStack` accepts a config object with shared settings at the top level and per-service settings nested under Supabase services such as `postgres`, `postgrest`, `auth`, `realtime`, `storage`, `studio`, and more.

### Top-level settings

| Field            | Type                             | Required | Default  | Description                                                                                                                                                     |
| ---------------- | -------------------------------- | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`           | `"native" \| "auto" \| "docker"` | No       | `"auto"` | Resolution mode. `"native"` requires native binaries, `"auto"` tries native first and falls back to Docker, and `"docker"` uses Docker images for all services. |
| `jwtSecret`      | `string`                         | No       |          | Secret for JWT signing (min 32 characters). Defaults to a well-known dev secret                                                                                 |
| `port`           | `number`                         | No       |          | API proxy port (auto-allocated if omitted)                                                                                                                      |
| `publishableKey` | `string`                         | No       |          | Custom opaque publishable key                                                                                                                                   |
| `secretKey`      | `string`                         | No       |          | Custom opaque secret key                                                                                                                                        |

### `postgres`

Optional. When omitted, uses all defaults (ephemeral temp data directory, auto-allocated port).

| Field     | Type     | Required | Description                                                                                 |
| --------- | -------- | -------- | ------------------------------------------------------------------------------------------- |
| `dataDir` | `string` | No       | Directory for Postgres data (PGDATA). Ephemeral temp dir if omitted (cleaned up on dispose) |
| `port`    | `number` | No       | Postgres port (auto-allocated if omitted)                                                   |
| `version` | `string` | No       | Postgres version (default: `17.6.1.081`)                                                    |

### `postgrest`

Optional. Omit to include with defaults, set to `false` to exclude.

| Field             | Type       | Default                    | Description                               |
| ----------------- | ---------- | -------------------------- | ----------------------------------------- |
| `schemas`         | `string[]` | `["public"]`               | Database schemas to expose                |
| `extraSearchPath` | `string[]` | `["public", "extensions"]` | Additional Postgres `search_path` entries |
| `maxRows`         | `number`   | `1000`                     | Maximum rows returned per request         |
| `version`         | `string`   | `14.5`                     | PostgREST version                         |

### `auth`

Optional. Omit to include with defaults, set to `false` to exclude.

| Field         | Type     | Default                    | Description                        |
| ------------- | -------- | -------------------------- | ---------------------------------- |
| `port`        | `number` | auto                       | Auth service port                  |
| `siteUrl`     | `string` | `http://localhost:3000`    | Auth redirect URL (your app's URL) |
| `jwtExpiry`   | `number` | `3600`                     | JWT expiry in seconds              |
| `externalUrl` | `string` | `http://127.0.0.1:${port}` | Auth external URL                  |
| `version`     | `string` | `2.188.0-rc.15`            | Auth version                       |

### Full config example

```typescript
const stack = await createStack({
  jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
  port: 54321,
  postgres: { port: 54322, dataDir: "/tmp/data", version: "17.6.1.081" },
  postgrest: { schemas: ["public", "custom"], maxRows: 500, version: "14.5" },
  auth: { port: 9999, siteUrl: "http://myapp.dev:3000", jwtExpiry: 7200 },
});
```

## Docker Mode

Set `mode: "docker"` to force all services to run in Docker containers, bypassing native binary resolution:

```typescript
const stack = await createStack({
  mode: "docker",
});
```

This is useful for:

- Environments where native binaries aren't available
- Testing Docker-based service behavior
- CI/CD pipelines that prefer containerized services

Docker mode requires Docker to be installed and running.

## Stack API

### Connection Info

| Property         | Type     | Description                                   |
| ---------------- | -------- | --------------------------------------------- |
| `url`            | `string` | API proxy URL (e.g. `http://127.0.0.1:54321`) |
| `dbUrl`          | `string` | PostgreSQL connection string                  |
| `publishableKey` | `string` | Opaque API key for `supabase-js`              |
| `secretKey`      | `string` | Opaque API key for privileged operations      |

### Lifecycle

```typescript
await stack.start(); // Prepare assets, start all services, block until ready
await stack.stop(); // Graceful dependency-ordered shutdown
await stack.dispose(); // stop() + release runtime resources
```

`dispose()` is also called automatically by `[Symbol.asyncDispose]` when using `await using`.

Calling `stop()` or `dispose()` multiple times is safe -- all operations are idempotent.

On a cold cache, `start()` may spend time downloading binaries or pulling Docker images before any
service process exists. During that phase, `getStatus()` / `statusChanges()` can surface
`Downloading` for the affected public services.

### Per-Service Lifecycle

```typescript
await stack.stopService("auth"); // Stop a single service
await stack.startService("auth"); // Restart it (blocks until ready)
await stack.restartService("auth"); // Stop + start in one call
```

Common service names include `"postgres"`, `"postgrest"`, `"auth"`, `"realtime"`, `"storage"`,
`"imgproxy"`, `"mailpit"`, `"pgmeta"`, `"studio"`, `"analytics"`, `"vector"`, and `"pooler"`.

Internal helper processes are projected away from the public stack API. For example, `postgres-init`
is treated as an implementation detail of `postgres`, so callers only see the public `postgres`
service and its projected status.

### Readiness

```typescript
await stack.ready(); // Wait for all services
await stack.ready({ timeout: 30_000 }); // With timeout (ms)
await stack.serviceReady("postgres"); // Wait for one service
await stack.serviceReady("auth", { timeout: 10_000 });
```

Note: `start()` already blocks until all services are ready. Use `ready()` and `serviceReady()` after manually starting individual services.

### Status

```typescript
const statuses = await stack.getStatus(); // All public services
const status = await stack.getServiceStatus("auth"); // One public service

// Stream real-time state changes
for await (const state of stack.statusChanges()) {
  console.log(`${state.name}: ${state.status}`);
}
```

`StackServiceState` includes the public service `name`, projected `status` (for example
`"Downloading"`, `"Healthy"`, or `"Initializing"`), process metadata, and any surfaced error.

### Logs

```typescript
// Stream all logs in real time
for await (const entry of stack.logs()) {
  console.log(`[${entry.service}] ${entry.message}`);
}

// Stream logs for a specific service
for await (const entry of stack.serviceLogs("postgres")) {
  console.log(entry.message);
}

// Get buffered log history
const history = await stack.logHistory("auth", 100);
```

## Platform Support

The package uses export conditions so Bun and Node.js consumers import from the same root:

```typescript
import { createStack } from "@supabase/stack";
```

The runtime selects the Bun or Node.js implementation automatically. Both expose the same `createStack(config): Promise<Stack>` API.

## Prefetching

Pre-download binaries and Docker images before they're needed — useful in test `globalSetup` to avoid download delays during test execution:

```typescript
// vitest.config.ts globalSetup
import { prefetch } from "@supabase/stack";

export async function setup() {
  await prefetch();
}
```

Prefetch specific services or versions:

```typescript
await prefetch({ services: ["postgres", "postgrest"] });
await prefetch({ versions: { postgres: "17.4.1.045" } });
```

## Service Versions

Default versions are used when no `version` field is specified per service:

| Service   | Default Version |
| --------- | --------------- |
| Postgres  | `17.6.1.081`    |
| PostgREST | `14.5`          |
| Auth      | `2.188.0-rc.15` |

Override versions per service:

```typescript
const stack = await createStack({
  jwtSecret: "...",
  postgres: { dataDir: "/tmp/data", version: "17.4.1.045" },
  postgrest: { version: "14.4" },
  auth: { version: "2.180.0" },
});
```

## Error Handling

All `Stack` methods throw `StackError` on failure, a standard `Error` subclass with a `code` field:

```typescript
import { StackError } from "@supabase/stack";

try {
  await stack.startService("nonexistent");
} catch (err) {
  if (err instanceof StackError) {
    console.error(err.code); // "SERVICE_NOT_FOUND"
    console.error(err.message); // Human-readable description
  }
}
```

| Code                | Description                                  |
| ------------------- | -------------------------------------------- |
| `SERVICE_NOT_FOUND` | Referenced a service that doesn't exist      |
| `SERVICE_NOT_READY` | Service failed to become healthy             |
| `BUILD_ERROR`       | Failed to build the service dependency graph |
| `BINARY_NOT_FOUND`  | No binary available for the current platform |
| `DOWNLOAD_ERROR`    | Binary download failed                       |
| `PORT_CONFLICT`     | Requested port is already in use             |
| `PORT_ALLOCATION`   | Failed to allocate a free port               |

## Examples

### Test setup with `beforeAll` / `afterAll`

```typescript
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createStack } from "@supabase/stack";
import { createClient } from "@supabase/supabase-js";

describe("my app", () => {
  let stack;
  let supabase;

  beforeAll(async () => {
    stack = await createStack({
      jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
      postgres: { dataDir: "/tmp/test-supabase" },
    });
    await stack.start();
    supabase = createClient(stack.url, stack.publishableKey);
  }, 120_000);

  afterAll(async () => {
    await stack?.dispose();
  }, 30_000);

  test("queries data", async () => {
    const { data, error } = await supabase.from("todos").select("*");
    expect(error).toBeNull();
  });
});
```

### Streaming logs during debugging

```typescript
const stack = await createStack({
  jwtSecret: "...",
  postgres: { dataDir: "/tmp/data" },
});
await stack.start();

// Print postgres logs as they arrive
for await (const entry of stack.serviceLogs("postgres")) {
  process.stdout.write(entry.message + "\n");
}
```

### Excluding services

```typescript
const stack = await createStack({
  jwtSecret: "...",
  postgres: { dataDir: "/tmp/data" },
  auth: false, // Only run Postgres and PostgREST
});
```

## Architecture

For a detailed look at internals, see:

- [docs/architecture.md](./docs/architecture.md)
- [docs/detach-mode.md](./docs/detach-mode.md)
- [docs/resource-leak-mitigations.md](./docs/resource-leak-mitigations.md)
