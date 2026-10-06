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
  runtime: "native", // or "docker"
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

`start` and `ready` are separate operations. `restart({ config })` replaces recipe configuration while retaining the instance identity and endpoint intentions. A health failure leaves a launched process running and observable; it does not prevent `stop`. Database snapshots require a stopped instance with wake disabled. `saveSnapshot(key)` publishes complete data to managed backend storage and replaces the previous entry for that key; `restoreSnapshot(key)` returns `false` on a miss and `true` after restoring a compatible entry. By default snapshots live in the shared cache, whose retention may evict older keys, and survive destruction of the source stack. `{ scope: "instance" }` keeps a snapshot with the instance instead: it is never evicted, restores only into that instance, survives `resetData`, and is removed when the instance is destroyed. Other service handles have no snapshot methods.

Creating a service records its definition. Configured public ports are bound during startup and retained across normal stop/start and owner reopening. An occupied saved port reports a conflict instead of moving. Automatic ports avoid every port reserved in the per-user port registry (see Public ports); a fixed port another stack holds is a conflict that names that stack. Omitted public endpoints are not exposed.

Native public listeners bind to loopback. Docker public proxies bind all interfaces so services inside the container network can reach them; those listeners are reachable from the LAN according to the host firewall.

Functions use a package-provided, self-contained Edge Runtime main service unless the configuration supplies `bootstrap` source; only an explicit `bootstrap` is saved with the service definition. Database versions belong in `config.version`; other recipes accept an optional top-level artifact `version`.

On Linux, native Functions project files must be outside `/tmp`: Edge Runtime uses a private filesystem at that path. Docker mounts project files at a separate runtime path.

`open({ id, stateRoot, cacheRoot })` reconnects to a saved stack. The package stores the stack document at `<stateRoot>/<id>/state.json` and service data at `<stateRoot>/<id>/data/<instance-id>`. `discover({ stateRoot })` lists saved definitions separately from live-owner availability. It skips each entry that cannot be read or decoded and reports it to `onInvalidState(id, error)`; only a failure to read `stateRoot` itself fails discovery. Port allocation skips the same entries. Offline definitions are not live lifecycle observations.

`find({ stateRoot, projectRoot, name })` derives the stack ID with the same identity rules as `create` and reads only that stack; `find({ stateRoot, id })` reads a known ID. It returns the saved definition with the live owner's endpoint, if any, or nothing when no such stack is saved. Unlike `discover`, an unreadable state document fails the call instead of being skipped. The Effect entrypoint's `StackId` schema validates an ID before lookup.

Pass `startOwner: true` to `open` when live status and other owner-backed operations are needed; this starts only the detached owner and does not start services. The owner writes its output to `<stateRoot>/<id>/owner.log`, which each owner start truncates; owner start and connection failures name that file. A client drives only an owner of its own release; other operations fail and ask you to stop or destroy the stack, which work across releases.

### Lifetimes

`create` defaults to `lifetime: "detached"`: the stack and its owner outlive the creating client. `create({ ..., lifetime: "session" })` starts the owner immediately and ties the stack to the creating client. Closing that client, or its process exiting for any reason, destroys the stack: instances stop, data and registrations are removed, and port reservations are released. Other clients may attach to a running session stack but cannot start its owner. A session stack whose owner has stopped is disposable: the next owner start in the state root removes it, and creating a stack with the same identity replaces it.

`create({ ..., startOwner: true })` starts a detached stack's owner immediately and lets it register the stack under its lease, as a session stack always does. If the owner fails to start or the launch is interrupted before it reports ready, the owner removes that registration and `create` fails with the launch error, so a failed launch leaves no stack behind.

`destroy` normally returns `{ runtimeCleanup: "complete" }`. When no owner is running and a new owner cannot start because the stack's container engine reports that its daemon cannot be reached, `destroy` confirms that no owner holds the stack's lease and leaves the registration, port reservations and host data untouched, returning `{ runtimeCleanup: "skipped", engine }`. When an owner does run but a labelled container cannot be removed (for example one on a different daemon) or an instance's data cannot be removed, `destroy` likewise keeps the stack registered and fails, listing what remains. Either way, retry `destroy` once the engine is reachable; there is no `cleanupCommands` field.

The stack owns database, Functions bootstrap, and command-job directories below its data directory. Storage uploads remain at the caller-supplied Storage `filePath` and are preserved when the stack is destroyed; the caller owns that directory. Host metadata remains under `stateRoot`; native database data uses host files. Docker database data normally uses a managed volume, while existing host data is retained through the host-backed fallback. A host marker records the selected Docker storage and detects a missing or mismatched volume; deleting that volume loses the associated database data. Native snapshot entries live below `cacheRoot`. Docker snapshots share the managed data volume in a separate namespace derived from `cacheRoot`, so they survive source destruction and can use filesystem cloning. A Docker cache hit requires the same daemon, `stateRoot`, and `cacheRoot`. There is no portable tar snapshot API.

Omitted database `jwtSecret` and `rootKey` inputs use the shared local-development values exported
as `DEFAULT_LOCAL_JWT_SECRET` and `DEFAULT_POSTGRES_ROOT_KEY`. Explicit values override these defaults.
The effective root key is supplied through a stack-owned file for both native and container runtimes.

The native artifact cache holds one immutable, content-addressed generation per published archive at `cacheRoot/<key>/<archive sha256>/`, published by renaming a lock-guarded `cacheRoot/<key>/.staging/<uuid>/content` into place. A generation is never modified after publish. `Artifacts.use` is the one scoped launch-time operation: it takes a SHARED lock on the generation's `cacheRoot/<key>/<digest>.lock` file before resolving or preparing it, and every consumer (service launch, startup commands, the PostgreSQL handover, one-shot commands, and the native launcher itself) uses the returned paths only inside that scope. Each pin holds its own connection, and the SQLite lock a pin takes excludes retirement whether the pin belongs to this process or another. After a cache miss publishes a generation, a sweep over the whole cache root retires a generation only once it is both unlocked and untouched for 30 days; cache hits never sweep, and digest lock files are never deleted. A stale, lock-guarded staging directory left by a killed preparer is reaped by the next cache miss, never by age.

Native PostgreSQL refuses to run as uid 0. When the stack runs as root inside a detected agent sandbox (Claude Code, Modal Sandbox), or `SUPABASE_NATIVE_POSTGRES_USER=<name>` names a non-root system user, only the PostgreSQL process runs as that user: the instance data directory, root key file, socket directory, and the bundle's `pgsodium_getkey.sh` are chowned to it, and the instance directory and its ancestors outside the generation (the artifact cache and stack state roots, which otherwise stay restricted to their owner) receive traverse-only (`o+x`) permission. A directory inside the generation itself is never chmodded; it must already carry that bit from the archive, or the handover fails naming the path. The `pgsodium_getkey.sh` chown is the one accepted exception to generation immutability: the packaged init script hard-codes that cached path and `chmod +x`s it, which only its owner may do. Running as root elsewhere fails before PostgreSQL launches.

Native PostgreSQL listens only on its socket and reads a stack-generated HBA file, written to the socket directory on every launch, instead of `PGDATA/pg_hba.conf`. The socket directory is `pg-<digest>` under the validated per-user runtime root, where the digest derives from the data root and instance id, so nothing about it is persisted: launch replaces a leftover and stop removes it. Destroying the instance removes it before the instance is unregistered, so a failed removal keeps the instance registered and a retry removes it; orphan recovery of a session stack runs the same destroy. A runtime root that is a symlink, belongs to another user or is writable by others is never trusted: removal warns and leaves its socket directories in place. It trusts `supabase_admin`, including through the proxied loopback database port, and requires `scram-sha-256` passwords from every other role.

### Public ports

Every public port is reserved, before any listener binds it, in one SQLite registry per OS user at
`<passwd home>/.supabase/ports.sqlite`. The home is resolved once per process straight from the OS
user database (`getent passwd <uid>` on Linux, `dscacheutil -q user -a uid <uid>` on macOS), never
`$HOME` or `SUPABASE_HOME`, and with no override; a process cannot steer the registry's location by
setting its own environment. The registry is the only saved port assignment (the stack's `state.json` holds none) and the only authority on which stack owns a port across
every state root on the machine, so a stopped stack keeps its ports across other
stacks' starts, and a restart reuses the same ports or fails with a `StackError` whose `conflict`
field names the port, the endpoint, and either the live holder (`{ stackId, stateRoot }`) or
`"foreign"` for a process outside the registry. A fixed or previously saved port is never silently
reassigned; only automatic allocation tries another candidate. A reservation is released when
deleting an individual service releases the endpoints only it owned, or when a stack-wide `destroy`
has removed the registration; a failed `destroy` keeps every reservation, and stopping a stack or killing its
owner leaves them in place. A reservation whose owning stack's `state.json` is confirmed gone (`ENOENT`, for example
after deleting its state root) is reclaimed lazily by the next stack that needs its port.

Known limitations: on macOS, BSD, and Windows, where the kernel allows overlapping binds, a loopback
probe before the real bind narrows but cannot close the race with a foreign process binding in the
same window; two of this user's stacks can never collide, because the registry excludes them. An
unmounted or otherwise temporarily unreachable state root looks identical to a deleted one and can
be reclaimed the same way. The registry does not reserve across OS users; isolation between users'
stacks still relies only on the kernel refusing a second bind. A native backend's own (never public)
ports are reserved directly from 10000–19999, disjoint from the public auto range and below the OS
ephemeral range on every supported platform; this is not configurable, and a public port pinned
inside it is rejected. A host whose ephemeral range has been widened to overlap 10000–19999
reintroduces the ephemeral-port race this reservation exists to avoid.

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

The factory accepts one instance of each selected recipe, binds its configured public endpoints, and wires managed inputs such as REST's database URL. When the database SQL endpoint is configured, Functions receives the saved database URL as an ordinary input too; recompose the composition after rotating database credentials to refresh that value. This binding does not make Functions wait for database readiness. Database is eager; Studio is lazy with a 5-minute idle timeout; other public services, Functions included, are lazy with a 60-second idle timeout. Services without public endpoints are eager. Pass `{ eager: true }` to start every member eagerly. A managed URL binding requires its producer's endpoint to be configured. The factory also supplies ordinary host/runtime API URLs to Auth, Studio, and Functions without adding dependencies from those URLs. It rejects an already configured composition.

Inputs that the composition binds or the owner fills from the stack credentials, such as REST's `databaseUrl` or a JWT secret, are optional in creation configuration. Starting or restarting an instance without a required input that was neither bound nor provided fails before any lifecycle change with a `ServiceError` whose `operation` is `"input"` and whose message names the input; a running instance keeps running.

To recompose a stopped stack, pass the IDs to keep in `reuseIds`. `composition.plan(services)` compares requested creations with every saved instance of the same kinds without contacting the owner or changing state. Each entry reports its instance `id`, `service`, whether it is a composition `member`, and a `change`: `unchanged`, `changed` with the differing config `paths`, or `incompatible` with the `paths` of an endpoint, artifact version, or PostgreSQL major-version change that the saved instance cannot adopt. Inputs that the composition or the stack credentials supply are ignored, an automatic API port is compared as the shared fixed port the composition would assign, and a PostgreSQL major alias matches its pinned version. Recomposing with `reuseIds` replaces a `changed` instance's configuration while keeping its identity, data, and ports.

The whole-stack E2E suite covers the default lazy lifecycle and reopen, all-eager startup, idle and wake, and parallel stack isolation for native and Docker runtimes, split into a `lifecycle` and an `idle-parallel` file per runtime. Run one runtime with a filter such as `pnpm --filter @supabase/stack test:e2e:run src/whole-stack.native` (matches both native files) or target one file, for example `src/whole-stack.docker.idle-parallel.e2e.test.ts`.

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

Bindings supply ordinary configuration values; a URL alone never creates a dependency. An independent REST instance can instead receive an external database URL. Lazy members receive public listeners before their processes start. Public traffic starts an armed instance and waits for health, up to a 120-second wake budget; inspector connections can attach before health succeeds. A prerequisite stays awake while any dependent runs. A crashed instance stays armed and the next request wakes it again; after repeated failures it fails fast for a 30-second cooldown, until the cooldown elapses or an explicit start. Explicit stop disables wake. An individual restart runs the instance explicitly; restart the composition to reapply its lazy policy.

- Instance methods affect that instance, subject to dependency checks.
- Composition methods affect selected members; startup also includes declared prerequisites.
- `stack.stop()` stops every owned instance and attached command and returns after confirming owner exit. Without a live owner it does not start one: it reclaims the stack's leftover workloads under the stack lease, and fails if another process holds the lease or the cleanup fails. An instance's `stop()` without a live owner has nothing to stop and returns without starting one.
- `stack.destroy()` additionally removes owned data and registrations, and also waits for owner exit.
- `stack.close()` disposes the client and invalidates its active observation iterators. Closing the creating client of a session stack destroys the stack. Stopping the last instance leaves the owner available.

Exit confirmation is bounded. If cleanup is acknowledged but owner exit cannot be confirmed, the operation fails with `operation: "shutdown-exit"` and the owner PID in the message. A failed or cancelled call does not guarantee that teardown has completed. Do not start or restart the same stack concurrently with whole-stack shutdown; separate stacks remain independent.

Each service exposes `status`, `followStatus`, `logs`, and `credentials`. Observations include the currently bound public endpoints, including listeners for sleeping services. Credentials default to host addressing. Use `from: "runtime"` for a URL passed to a service or command container.

## Testing

`@supabase/stack/testing` creates a disposable, ready stack for a test:

```ts
import { createTestStack } from "@supabase/stack/testing";

await using test = await createTestStack({ services: ["database", "rest"] });
const { databaseUrl } = await test.services.database.credentials();

await test.checkpoint("seeded"); // after loading fixtures
// Exercise the stack.
await test.reset("seeded"); // discard writes made since the checkpoint
```

The stack is a session stack composed with `composition.supabase` and `{ eager: true }`; each selected service is configured for local development with every endpoint on an automatic port, and `test.services` holds a typed handle per selected kind. Select a kind by name, or pass `{ service, config, endpoints }` to override part of its configuration. Disposal destroys the stack, then closes the client and removes the temporary project root. A session stack is also destroyed when the test process exits.

Every test stack for the current OS user shares one state root and the package's artifact cache root under the OS temp directory, so their ports are coordinated and Docker uses one data volume; each gets a unique temporary project root and name. Pass `stateRoot`, `cacheRoot`, or `projectRoot` to override them. The runtime comes from `runtime`, then `SUPABASE_STACK_TEST_RUNTIME`, then the platform default: native where the catalog publishes native artifacts and Docker elsewhere. A startup failure names the state of each registered service and the owner log.

`checkpoint(name)` stops the composition, saves the database data as an instance-scoped snapshot, and starts the composition again. `reset(name)` stops it, clears the database data, restores that snapshot, and waits until every service is ready. Checkpoints are never evicted by other stacks' snapshots and are removed when the test stack is destroyed.

Effect tests use the scoped `makeTestStack`, which destroys the stack when its scope closes:

```ts
import { makeTestStack } from "@supabase/stack/testing";

const test = Effect.gen(function* () {
  const { services } = yield* makeTestStack({ services: ["database"] });
  yield* exercise(services.database);
}).pipe(Effect.scoped);
```

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

The Promise entrypoint is derived from this one: each Effect becomes a call that accepts `{ signal }`, each Effect-returning function takes the same arguments plus a trailing `{ signal }` (a `signal` inside any other options object, such as command or composition options, is ignored), each Stream becomes an async iterable, and `Redacted` configuration values become plain strings. `commands.run` takes Promise-returning sinks and an async-iterable `stdin`.

Cancelling an admitted lifecycle caller ends its wait; the owner finishes the operation. Cancelling an attached command ends that job and cleans up its resources. Command input and output stream with backpressure; the result contains a job ID and exit code, not collected output. Promise command sinks should return a Promise when the destination requires waiting for capacity.

The owner supports normal stop/start persistence. When an owner dies unexpectedly, its native processes die with it. Its containers remain until the next owner start in the same `stateRoot` removes them; that start also destroys session stacks whose owner is gone. Unexpected owner death does not trigger resource adoption or interrupted-operation recovery. CLI integration is maintained separately from this package.
