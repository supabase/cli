# `@supabase/stack`

An Effect-based local Supabase runtime with individually identified services, explicit composition, and a detached owner process. See [the architecture](ARCHITECTURE.md) for lifecycle and ownership rules.

The package accepts service configuration directly. Loading CLI configuration, migrations, seeds, and command presentation belong to the CLI.

## Standalone services

The Promise entrypoint accepts plain configuration:

```ts
import { create } from "@supabase/stack";
import { postgres } from "@supabase/stack/commands";

const stack = await create({
  projectRoot: process.cwd(),
  runtime: "native", // or "docker" / "podman"
  stateRoot: "/tmp/example-stack/state",
  cacheRoot: "/tmp/example-stack/cache",
});

const database = await stack.services.create({
  service: "database",
  config: {
    version: "17",
    databasePassword: "local-password",
    jwtSecret: "local-development-secret-at-least-32-characters",
    jwtExpiry: 3600,
  },
  endpoints: { sql: { port: "auto" } },
});

await database.start(); // process launched
await database.ready(); // initialization and health completed
const { databaseUrl } = await database.credentials({ from: "runtime" });

if (databaseUrl === undefined) throw new Error("Database endpoint missing");
await stack.commands.run(postgres.psql({ major: 17 }), {
  args: ["--dbname", databaseUrl, "--command", "SELECT 1"],
  stdout: (bytes) => {
    process.stdout.write(bytes);
  },
  stderr: (bytes) => {
    process.stderr.write(bytes);
  },
});

// Runs recipe initialization without registering a service instance.
const { authDatabaseUrl } = await database.credentials({ from: "runtime" });
if (authDatabaseUrl === undefined) throw new Error("Auth database URL missing");
await stack.commands.run({ type: "auth.initialize", databaseUrl: authDatabaseUrl });

await database.stop();
await database.saveSnapshot("baseline");
await stack.close(); // disconnects this client
```

`start` and `ready` are separate operations. `restart({ config })` replaces recipe configuration while retaining the instance identity and endpoint intentions. A health failure leaves a launched process running and observable; it does not prevent `stop`. Database snapshots require a stopped instance with wake disabled. `saveSnapshot(key)` publishes complete data to managed backend storage and replaces the previous entry for that key; `restoreSnapshot(key)` returns `false` on a miss and `true` after restoring a compatible entry. Managed retention may evict older keys, while snapshots survive destruction of the source stack. Other service handles have no snapshot methods.

Creating a service records its definition. Configured public ports are bound during startup and retained across normal stop/start and owner reopening. An occupied saved port reports a conflict instead of moving. Omitted public endpoints are not exposed.

Native public listeners bind to loopback. Docker and Podman public proxies bind all interfaces so services inside the container network can reach them; those listeners are reachable from the LAN according to the host firewall.

Functions configuration requires bootstrap source. Database versions belong in `config.version`; other recipes accept an optional top-level artifact `version`.

On Linux, native Functions project files must be outside `/tmp`: Edge Runtime uses a private filesystem at that path. Docker and Podman mount project files at a separate runtime path.

`open({ id, stateRoot, cacheRoot })` reconnects to a saved stack. The package stores the stack document at `<stateRoot>/<id>/state.json` and service data at `<stateRoot>/<id>/data/<instance-id>`. `discover({ stateRoot })` lists saved definitions and port assignments separately from live-owner availability. Offline definitions are not live lifecycle observations.

Pass `startOwner: true` to `open` when live status and other owner-backed operations are needed; this starts only the detached owner and does not start services.

`create({ ..., startOwner: true })` registers the stack and then starts its owner immediately; if the owner fails to launch or the launch is interrupted, `create` removes the registration it just saved, unless an owner already holds the stack, and fails with the launch error.

`destroy` normally returns `{ runtimeCleanup: "complete" }`. When no owner is running and the stack's container engine reports that its daemon cannot be reached, `destroy` removes the local registration and host data anyway and returns `{ runtimeCleanup: "skipped", engine, cleanupCommands }`; its containers and any database data in engine volumes remain, and `cleanupCommands` are the shell commands that remove them once the engine is running. If some host data cannot be deleted by the current user, `destroy` fails before removing anything so it can be retried with the engine running.

The stack owns database, Functions bootstrap, and command-job directories below its data directory. Storage uploads remain at the caller-supplied Storage `filePath` and are preserved when the stack is destroyed; the caller owns that directory. Host metadata remains under `stateRoot`; native database data uses host files. Docker database data normally uses a managed volume, while existing host data is retained through the host-backed fallback. A host marker records the selected Docker storage and detects a missing or mismatched volume; deleting that volume loses the associated database data. Native snapshot entries live below `cacheRoot`. Docker snapshots share the managed data volume in a separate namespace derived from `cacheRoot`, so they survive source destruction and can use filesystem cloning. A Docker cache hit requires the same daemon, `stateRoot`, and `cacheRoot`. There is no portable tar snapshot API.

Omitted database `jwtSecret` and `rootKey` inputs use the shared local-development values exported
as `DEFAULT_LOCAL_JWT_SECRET` and `DEFAULT_POSTGRES_ROOT_KEY`. Explicit values override these defaults.
The effective root key is supplied through a stack-owned file for both native and container runtimes.

Native PostgreSQL refuses to run as uid 0. When the stack runs as root inside a detected agent sandbox (Claude Code), or `SUPABASE_NATIVE_POSTGRES_USER=<name>` names a non-root system user, only the PostgreSQL process runs as that user: the instance data directory, root key file, socket directory, and the bundle's `pgsodium_getkey.sh` are chowned to it, and the instance directory, the PostgreSQL bundle directory, and their ancestors receive traverse-only (`o+x`) permission, which the artifact cache and stack state keep when they restrict their roots to the owner. Running as root elsewhere fails before PostgreSQL launches.

## Composition and operation scope

Registering a service does not add it to the application composition. For a fresh composition, `composition.supabase` registers the selected recipes and supplies their standard bindings:

```ts
const services = await stack.composition.supabase([
  {
    service: "database",
    config: {
      version: "17",
      databasePassword: "local-password",
      jwtSecret: "local-development-secret-at-least-32-characters",
      jwtExpiry: 3600,
    },
    endpoints: { sql: { port: "auto" } },
  },
  {
    service: "rest",
    config: { databaseUrl: "postgresql://configured-by-composition" },
    endpoints: { http: { port: "auto" } },
  },
]);
await stack.composition.start();
```

The factory accepts one instance of each selected recipe, binds its configured public endpoints, and wires managed inputs such as REST's database URL. When the database SQL endpoint is configured, Functions receives the saved database URL as an ordinary input too; recompose the composition after rotating database credentials to refresh that value. This binding does not make Functions wait for database readiness. Database is eager; Functions are lazy without an idle timeout; other public services are lazy with a 60-second idle timeout. Services without public endpoints are eager. A managed URL binding requires its producer's endpoint to be configured. The factory also supplies ordinary host/runtime API URLs to Auth, Studio, and Functions without adding dependencies from those URLs. It rejects an already configured composition.

The whole-stack E2E suite covers the default lazy lifecycle and reopen, all-eager startup, idle and wake, and parallel stack isolation for native and Docker runtimes. Run one runtime with `pnpm --filter @supabase/stack test:e2e:run src/whole-stack.native.e2e.test.ts` or the corresponding Docker test file.

For multiple instances or custom dependencies, configure members and bindings explicitly instead:

```ts
const rest = await stack.services.create({
  service: "rest",
  config: { databaseUrl: "postgresql://configured-by-composition" },
  endpoints: { http: { port: "auto" } },
});

await stack.composition.configure({
  members: [
    { id: database.id, activation: "eager" },
    { id: rest.id, activation: "lazy", idleMillis: 60_000 },
  ],
  dependencies: [
    {
      from: database.id,
      to: rest.id,
      bindings: [{ output: "authenticatorUrl", input: "databaseUrl" }],
    },
  ],
});
await stack.composition.start();
```

Bindings supply ordinary configuration values; a URL alone never creates a dependency. An independent REST instance can instead receive an external database URL. Lazy members receive public listeners before their processes start. Public traffic starts an armed instance and waits for health; inspector connections can attach before health succeeds. Explicit stop disables wake. An individual restart runs the instance explicitly; restart the composition to reapply its lazy policy.

- Instance methods affect that instance, subject to dependency checks.
- Composition methods affect selected members; startup also includes declared prerequisites.
- `stack.stop()` stops every owned instance and attached command and returns after confirming owner exit. It requires a live owner; an unavailable owner cannot confirm cleanup.
- `stack.destroy()` additionally removes owned data and registrations, and also waits for owner exit.
- `stack.close()` disposes the client and invalidates its active observation iterators. Stopping the last instance leaves the owner available.

Exit confirmation is bounded. If cleanup is acknowledged but owner exit cannot be confirmed, the operation fails with `operation: "shutdown-exit"` and the owner PID in the message. A failed or cancelled call does not guarantee that teardown has completed. Do not start or restart the same stack concurrently with whole-stack shutdown; separate stacks remain independent.

Disposable test stacks need explicit teardown; closing a client does not own their lifetime:

```ts
try {
  // Exercise the stack.
} finally {
  try {
    await stack.destroy();
  } finally {
    await stack.close();
  }
}
```

Each service exposes `status`, `followStatus`, `logs`, and `credentials`. Observations include the currently bound public endpoints, including listeners for sleeping services. Credentials default to host addressing. Use `from: "runtime"` for a URL passed to a service or command container.

## Effect consumers

The Effect entrypoint exposes the same operations as Effects and Streams. Database secrets use `Redacted` in the Effect configuration:

```ts
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import * as Stack from "@supabase/stack/effect";

const program = Effect.gen(function* () {
  const stack = yield* Stack.open({ id, stateRoot, cacheRoot });
  const database = yield* stack.services.get(databaseId);
  yield* database.start;
  yield* database.ready;
  return yield* database.status;
});

await Effect.runPromise(
  program.pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);
```

Cancelling an admitted lifecycle caller ends its wait; the owner finishes the operation. Cancelling an attached command ends that job and cleans up its resources. Command input and output stream with backpressure; the result contains a job ID and exit code, not collected output. Promise output sinks should return a Promise when the destination requires waiting for capacity.

For disposable Effect test fixtures, `acquireUseRelease` runs teardown on failure and interruption while retaining typed cleanup errors:

```ts
const test = Effect.acquireUseRelease(
  Stack.create(options),
  (stack) => exerciseStack(stack),
  (stack) => stack.destroy,
);
```

The owner supports normal stop/start persistence. Unexpected owner death does not trigger resource adoption, orphan removal, or interrupted-operation recovery. CLI integration is maintained separately from this package.
