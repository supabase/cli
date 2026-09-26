# `@supabase/stack`

An Effect-based local Supabase runtime with individually identified services, explicit composition, and a detached owner process. See [the architecture](ARCHITECTURE.md) for lifecycle and ownership rules.

The package accepts service configuration directly. Loading CLI configuration, migrations, seeds, and command presentation belong to the CLI.

## Standalone services

The Promise entrypoint accepts plain configuration:

```ts
import { create, postgres } from "@supabase/stack";

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
await stack.tools.run(postgres.psql({ major: 17 }), {
  args: ["--dbname", databaseUrl, "--command", "SELECT 1"],
  stdout: (bytes) => {
    process.stdout.write(bytes);
  },
  stderr: (bytes) => {
    process.stderr.write(bytes);
  },
});

await database.stop();
await database.saveSnapshot("baseline");
await stack.close(); // disconnects this client
```

`start` and `ready` are separate operations. `restart({ config })` replaces recipe configuration while retaining the instance identity and endpoint intentions. A health failure leaves a launched process running and observable; it does not prevent `stop`. Database snapshots require a stopped instance with wake disabled. `saveSnapshot(key)` publishes complete data to managed backend storage and replaces the previous entry for that key; `restoreSnapshot(key)` returns `false` on a miss and `true` after restoring a compatible entry. Managed retention may evict older keys, while snapshots survive destruction of the source stack. Other service handles have no snapshot methods.

Creating a service records its definition. Configured public ports are bound during startup and retained across normal stop/start and owner reopening. An occupied saved port reports a conflict instead of moving. Automatic ports avoid numbers saved by any stack under the same `stateRoot`; a fixed port is decided by binding it, so another stack's saved port blocks only while something listens on it; that conflict names the stack that saved the port. Omitted public endpoints are not exposed.

Native public listeners bind to loopback. Docker and Podman public proxies bind all interfaces so services inside the container network can reach them; those listeners are reachable from the LAN according to the host firewall.

Functions use a package-provided, self-contained Edge Runtime main service unless the configuration supplies `bootstrap` source; only an explicit `bootstrap` is saved with the service definition. Database versions belong in `config.version`; other recipes accept an optional top-level artifact `version`.

On Linux, native Functions project files must be outside `/tmp`: Edge Runtime uses a private filesystem at that path. Docker and Podman mount project files at a separate runtime path.

`open({ id, stateRoot, cacheRoot })` reconnects to a saved stack. The package stores the stack document at `<stateRoot>/<id>/state.json` and service data at `<stateRoot>/<id>/data/<instance-id>`. `discover({ stateRoot })` lists saved definitions and port assignments separately from live-owner availability. It skips each entry that cannot be read or decoded and reports it to `onInvalidState(id, error)`; only a failure to read `stateRoot` itself fails discovery. Port allocation skips the same entries. Offline definitions are not live lifecycle observations.

`find({ stateRoot, projectRoot, name })` derives the stack ID with the same identity rules as `create` and reads only that stack; `find({ stateRoot, id })` reads a known ID. It returns the saved definition with the live owner's endpoint, if any, or nothing when no such stack is saved. Unlike `discover`, an unreadable state document fails the call instead of being skipped. The Effect entrypoint's `StackId` schema validates an ID before lookup.

Pass `startOwner: true` to `open` when live status and other owner-backed operations are needed; this starts only the detached owner and does not start services. The owner writes its output to `<stateRoot>/<id>/owner.log`, which each owner start truncates; owner start and connection failures name that file. A client drives only an owner of its own release; other operations fail and ask you to stop or destroy the stack, which work across releases.

### Lifetimes

`create` defaults to `lifetime: "detached"`: the stack and its owner outlive the creating client. `create({ ..., lifetime: "session" })` starts the owner immediately and ties the stack to the creating client. Closing that client, or its process exiting for any reason, destroys the stack: instances stop, data and registrations are removed, and port claims are released. Other clients may attach to a running session stack but cannot start its owner. A session stack whose owner has stopped is disposable: the next owner start in the state root removes it, and creating a stack with the same identity replaces it.

`create({ ..., startOwner: true })` starts a detached stack's owner immediately and lets it register the stack under its lease, as a session stack always does. If the owner fails to start or the launch is interrupted before it reports ready, the owner removes that registration and `create` fails with the launch error, so a failed launch leaves no stack behind.

`destroy` normally returns `{ runtimeCleanup: "complete" }`. When no owner is running and a new owner cannot start because the stack's container engine reports that its daemon cannot be reached, `destroy` takes the stack's lease, so no owner can start meanwhile, and removes the local registration, port claims and host data anyway and returns `{ runtimeCleanup: "skipped", engine, cleanupCommands }`; its containers and any database data in engine volumes remain, and `cleanupCommands` are the shell commands that remove them once the engine is running. If some host data cannot be deleted by the current user, `destroy` fails before removing anything so it can be retried with the engine running.

The stack owns database, Functions bootstrap, and tool-job directories below its data directory. Storage uploads remain at the caller-supplied Storage `filePath` and are preserved when the stack is destroyed; the caller owns that directory. Host metadata remains under `stateRoot`; native database data uses host files. Docker database data normally uses a managed volume, while existing host data is retained through the host-backed fallback. A host marker records the selected Docker storage and detects a missing or mismatched volume; deleting that volume loses the associated database data. Native snapshot entries live below `cacheRoot`. Docker snapshots share the managed data volume in a separate namespace derived from `cacheRoot`, so they survive source destruction and can use filesystem cloning. A Docker cache hit requires the same daemon, `stateRoot`, and `cacheRoot`. There is no portable tar snapshot API.

Omitted database `jwtSecret` and `rootKey` inputs use the shared local-development values exported
as `DEFAULT_LOCAL_JWT_SECRET` and `DEFAULT_POSTGRES_ROOT_KEY`. Explicit values override these defaults.
The effective root key is supplied through a stack-owned file for both native and container runtimes.

Native PostgreSQL refuses to run as uid 0. When the stack runs as root inside a detected agent sandbox (Claude Code), or `SUPABASE_NATIVE_POSTGRES_USER=<name>` names a non-root system user, only the PostgreSQL process runs as that user: the instance data directory, root key file, socket directory, and the bundle's `pgsodium_getkey.sh` are chowned to it, and the instance directory, the PostgreSQL bundle directory, and their ancestors receive traverse-only (`o+x`) permission, which the artifact cache and stack state keep when they restrict their roots to the owner. Running as root elsewhere fails before PostgreSQL launches.

Native PostgreSQL listens only on its socket and reads a stack-generated HBA file, written to the socket directory on every launch, instead of `PGDATA/pg_hba.conf`. It trusts `supabase_admin`, including through the proxied loopback database port, and requires `scram-sha-256` passwords from every other role.

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
    config: {},
    endpoints: { http: { port: "auto" } },
  },
]);
await stack.composition.start();
```

The factory accepts one instance of each selected recipe, binds its configured public endpoints, and wires managed inputs such as REST's database URL. When the database SQL endpoint is configured, Functions receives the saved database URL as an ordinary input too; recompose the composition after rotating database credentials to refresh that value. This binding does not make Functions wait for database readiness. Database is eager; Functions are lazy without an idle timeout; other public services are lazy with a 60-second idle timeout. Services without public endpoints are eager. Pass `{ eager: true }` to start every member eagerly. A managed URL binding requires its producer's endpoint to be configured. The factory also supplies ordinary host/runtime API URLs to Auth, Studio, and Functions without adding dependencies from those URLs. It rejects an already configured composition.

Inputs that the composition binds or the owner fills from the stack credentials, such as REST's `databaseUrl` or a JWT secret, are optional in creation configuration. Starting or restarting an instance without a required input that was neither bound nor provided fails before any lifecycle change with a `ServiceError` whose `operation` is `"input"` and whose message names the input; a running instance keeps running.

To recompose a stopped stack, pass the IDs to keep in `reuseIds`. `composition.plan(services)` compares requested creations with every saved instance of the same kinds without contacting the owner or changing state. Each entry reports its instance `id`, `service`, whether it is a composition `member`, and a `change`: `unchanged`, `changed` with the differing config `paths`, or `incompatible` with the `paths` of an endpoint, artifact version, or PostgreSQL major-version change that the saved instance cannot adopt. Inputs that the composition or the stack credentials supply are ignored, an automatic API port is compared as the shared fixed port the composition would assign, and a PostgreSQL major alias matches its pinned version. Recomposing with `reuseIds` replaces a `changed` instance's configuration while keeping its identity, data, and ports.

The whole-stack E2E suite covers the default lazy lifecycle and reopen, all-eager startup, idle and wake, and parallel stack isolation for native and Docker runtimes. Run one runtime with `pnpm --filter @supabase/stack test:e2e:run src/whole-stack.native.e2e.test.ts` or the corresponding Docker test file.

For multiple instances or custom dependencies, configure members and bindings explicitly instead:

```ts
const rest = await stack.services.create({
  service: "rest",
  config: {},
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
- `stack.stop()` stops every owned instance and attached tool and returns after confirming owner exit. Without a live owner nothing runs, so it returns without starting one; an instance's `stop()` behaves the same way.
- `stack.destroy()` additionally removes owned data and registrations, and also waits for owner exit.
- `stack.close()` disposes the client and invalidates its active observation iterators. Closing the creating client of a session stack destroys the stack. Stopping the last instance leaves the owner available.

Exit confirmation is bounded. If cleanup is acknowledged but owner exit cannot be confirmed, the operation fails with `operation: "shutdown-exit"` and the owner PID in the message. A failed or cancelled call does not guarantee that teardown has completed. Do not start or restart the same stack concurrently with whole-stack shutdown; separate stacks remain independent.

A session stack is destroyed when its creating client closes. A detached test stack needs explicit teardown, because closing a client does not own its lifetime:

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

Each service exposes `status`, `followStatus`, `logs`, and `credentials`. Observations include the currently bound public endpoints, including listeners for sleeping services. Credentials default to host addressing. Use `from: "runtime"` for a URL passed to a service or tool container.

## Effect consumers

The Effect entrypoint exposes the same operations as Effects and Streams. `create` and `open` return a handle that lasts until the enclosing `Scope` closes; closing the creating scope of a session stack destroys it. Database secrets use `Redacted` in the Effect configuration:

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
  program.pipe(
    Effect.scoped,
    Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)),
  ),
);
```

Cancelling an admitted lifecycle caller ends its wait; the owner finishes the operation. Cancelling an attached tool ends that job and cleans up its resources. Tool input and output stream with backpressure; the result contains a job ID and exit code, not collected output. Promise tool sinks should return a Promise when the destination requires waiting for capacity.

For disposable Effect test fixtures, `acquireUseRelease` runs teardown on failure and interruption while retaining typed cleanup errors:

```ts
const test = Effect.acquireUseRelease(
  Stack.create(options),
  (stack) => exerciseStack(stack),
  (stack) => stack.destroy,
);
```

The owner supports normal stop/start persistence. When an owner dies unexpectedly, its native processes die with it. Its containers remain until the next owner start in the same `stateRoot` removes them; that start also destroys session stacks whose owner is gone. Unexpected owner death does not trigger resource adoption or interrupted-operation recovery. CLI integration is maintained separately from this package.
