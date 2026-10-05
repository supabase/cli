import { PgClient } from "@effect/sql-pg";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Context,
  Crypto,
  Data,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Path,
  Redacted,
  Schedule,
  Stream,
} from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as Net from "node:net"; // oxlint-disable-line effecttsgo/node-builtin-import -- forces an outstanding connection during a gated drain.
import { fileURLToPath } from "node:url";
import * as StackNamespace from "./StackNamespace.ts";
import {
  hasReason,
  launchHost,
  ownerClient,
  ownerExitProbe,
  waitForOwnerExit,
} from "./HostProcess.ts";
import { makeContainerRuntime, resolveEngineTarget } from "./runtime/Container.ts";
import { makeDockerDatabaseRoot } from "../tests/docker-fixture.ts";
import { shutdownOwner, watchLeaseRelease } from "../tests/owner.ts";
import { watchEntry } from "../tests/watch-entry.ts";

const shortRegistrationPollFixture = fileURLToPath(
  new URL("../tests/short-registration-poll-fixture.ts", import.meta.url),
);
const gatedDrainFixture = fileURLToPath(
  new URL("../tests/gated-drain-fixture.ts", import.meta.url),
);

class HostTestError extends Data.TaggedError("HostTestError")<{ readonly message: string }> {}

const hostTestError = (cause: unknown) =>
  new HostTestError({ message: cause instanceof Error ? cause.message : String(cause) });

const isHttpRefused = (port: number) =>
  Effect.callback<boolean, never>((resume) => {
    let socket: Net.Socket;
    try {
      socket = Net.connect(port, "127.0.0.1");
    } catch {
      resume(Effect.succeed(true));
      return Effect.void;
    }
    let response = "";
    const onConnect = () =>
      socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    const onData = (bytes: Buffer) => (response += bytes.toString());
    const settle = () => resume(Effect.succeed(response.length === 0));
    socket.once("connect", onConnect);
    socket.on("data", onData);
    socket.once("close", settle);
    socket.once("error", settle);
    return Effect.sync(() => {
      socket.off("connect", onConnect);
      socket.off("data", onData);
      socket.off("close", settle);
      socket.off("error", settle);
      socket.destroy();
    });
  });

/**
 * Opens a real TCP connection to the mail service's send endpoint and writes only the first half
 * of the request body, so the request stays genuinely in flight until `complete` sends the rest.
 */
const openPartialMailSend = (port: number, subject: string) =>
  Effect.gen(function* () {
    // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- raw wire payload split mid-body to hold the request open, not a domain model
    const payload = JSON.stringify({
      From: { Email: "sender@example.com" },
      To: [{ Email: "recipient@example.com" }],
      Subject: subject,
      Text: "drain test",
    });
    const splitAt = Math.ceil(payload.length / 2);
    const socket = yield* Effect.acquireRelease(
      Effect.callback<Net.Socket, HostTestError>((resume) => {
        let socket: Net.Socket;
        try {
          socket = Net.connect(port, "127.0.0.1");
        } catch (cause) {
          resume(Effect.fail(hostTestError(cause)));
          return Effect.void;
        }
        const onConnect = () =>
          socket.write(
            `POST /api/v1/send HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n${payload.slice(0, splitAt)}`,
            () => resume(Effect.succeed(socket)),
          );
        const onError = (cause: Error) => resume(Effect.fail(hostTestError(cause)));
        socket.once("connect", onConnect);
        socket.once("error", onError);
        return Effect.sync(() => {
          socket.off("connect", onConnect);
          socket.off("error", onError);
        });
      }),
      (socket) => Effect.sync(() => socket.destroy()),
    );
    const response = yield* Effect.callback<string, HostTestError>((resume) => {
      let buffer = "";
      const onData = (bytes: Buffer) => (buffer += bytes.toString());
      const onEnd = () => resume(Effect.succeed(buffer));
      const onError = (cause: Error) => resume(Effect.fail(hostTestError(cause)));
      socket.on("data", onData);
      socket.once("end", onEnd);
      socket.once("error", onError);
      return Effect.sync(() => {
        socket.off("data", onData);
        socket.off("end", onEnd);
        socket.off("error", onError);
      });
    }).pipe(Effect.forkChild({ startImmediately: true }));
    return {
      complete: () => socket.write(payload.slice(splitAt)),
      response: Fiber.join(response),
    };
  });

const helperImage =
  "public.ecr.aws/docker/library/debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251";

const docker = Effect.fn("StackHostContainerShutdownTest.docker")((args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make("docker", args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (Number(code) !== 0)
        return yield* Effect.die(`docker ${args.join(" ")} failed: ${stderr}`);
      return stdout.trim();
    }),
  ),
);

const stateFor = (root: string) =>
  Layer.build(StackNamespace.layer({ root })).pipe(
    Effect.map((context) => Context.get(context, StackNamespace.Service)),
  );

const containers = (stackId: string, dataRoot: string) =>
  docker([
    "ps",
    "--all",
    "--quiet",
    "--no-trunc",
    "--filter",
    `label=com.supabase.stack=${stackId}`,
    "--filter",
    `label=com.supabase.stack-root=${dataRoot}`,
  ]).pipe(Effect.map((value) => value.split("\n").filter((id) => id.length > 0)));

const removeContainers = (stackId: string, dataRoot: string) =>
  containers(stackId, dataRoot).pipe(
    Effect.flatMap((ids) =>
      Effect.forEach(ids, (id) => docker(["rm", "--force", id]).pipe(Effect.ignore), {
        concurrency: 1,
        discard: true,
      }),
    ),
  );

const startHost = (stateRoot: string, cacheRoot: string, stackId: string, projectRoot: string) =>
  Effect.gen(function* () {
    const state = yield* stateFor(stateRoot);
    const current = yield* state.read(stackId);
    if (current === undefined)
      yield* state.save({
        id: stackId,
        runtime: "docker",
        identity: { projectRoot, branchContext: "container-shutdown-test", stackName: stackId },
        instances: [],
        lifetime: "detached",
        composition: { members: [], dependencies: [] },
        ports: [],
      });
    return yield* launchHost(state, { stateRoot, cacheRoot, stackId });
  });

it.live.skipIf(process.platform === "win32")(
  "stops, destroys, and abandons only containers owned by the same stack id and data root",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "stack-root-shutdown-" });
        const stackId = `shared-${(yield* crypto.randomUUIDv4).replaceAll("-", "")}`;
        const dataA = yield* makeDockerDatabaseRoot("stack-root-shutdown-a-", stackId).pipe(
          Effect.flatMap(fs.realPath),
        );
        const dataB = yield* makeDockerDatabaseRoot("stack-root-shutdown-b-", stackId).pipe(
          Effect.flatMap(fs.realPath),
        );
        const rootA = path.dirname(path.dirname(dataA));
        const rootB = path.dirname(path.dirname(dataB));
        const cacheRoot = `${base}/cache`;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const target = yield* resolveEngineTarget(spawner);
        const helper = yield* makeContainerRuntime({
          target,
          root: dataA,
        });
        yield* helper.prepare(helperImage);
        let activeA: { readonly pid: number; readonly port: number } | undefined;
        let activeB: { readonly pid: number; readonly port: number } | undefined;
        let stoppedA = true;
        let stoppedB = true;
        // A signalled owner stops its containers, each within a 10 second grace, before exiting;
        // no acknowledgement precedes that cleanup, so the post-acknowledgement exit bound repeats.
        const signalAndWait = (endpoint: { pid: number }, signal: NodeJS.Signals) =>
          Effect.sync(() => process.kill(endpoint.pid, signal)).pipe(
            Effect.andThen(
              waitForOwnerExit(endpoint.pid, ownerExitProbe(fs)).pipe(
                Effect.retry({ while: hasReason("owner-exit-pending") }),
                Effect.timeout("30 seconds"),
              ),
            ),
          );
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            if (!stoppedA && activeA !== undefined)
              yield* signalAndWait(activeA, "SIGTERM").pipe(Effect.ignore);
            if (!stoppedB && activeB !== undefined)
              yield* signalAndWait(activeB, "SIGTERM").pipe(Effect.ignore);
            yield* removeContainers(stackId, dataA).pipe(Effect.ignore);
            yield* removeContainers(stackId, dataB).pipe(Effect.ignore);
          }),
        );
        const accessA = yield* startHost(rootA, cacheRoot, stackId, `${base}/project-a`);
        const endpointA = accessA.endpoint;
        activeA = endpointA;
        stoppedA = false;
        const accessB = yield* startHost(rootB, cacheRoot, stackId, `${base}/project-b`);
        const endpointB = accessB.endpoint;
        activeB = endpointB;
        stoppedB = false;
        expect(yield* containers(stackId, dataA)).toEqual([]);
        expect(yield* containers(stackId, dataB)).toEqual([]);

        const clientA = yield* ownerClient(accessA);
        const clientB = yield* ownerClient(accessB);
        const createAndStartDatabase = (client: ReturnType<typeof ownerClient>, suffix: string) =>
          client.pipe(
            Effect.flatMap((rpc) =>
              rpc.createService({
                service: "database",
                config: {
                  version: "17",
                  databasePassword: Redacted.make(`stack-shutdown-password-${suffix}`),
                  jwtSecret: Redacted.make(
                    `stack-shutdown-jwt-secret-${suffix}-at-least-thirty-two-characters`,
                  ),
                  jwtExpiry: 3600,
                },
                endpoints: { sql: { port: "auto" } },
              }),
            ),
            Effect.flatMap((database) =>
              client.pipe(
                Effect.flatMap((rpc) => rpc.startService({ id: database.id })),
                Effect.andThen(
                  client.pipe(Effect.flatMap((rpc) => rpc.readyService({ id: database.id }))),
                ),
                Effect.as(database),
              ),
            ),
          );
        yield* createAndStartDatabase(Effect.succeed(clientA), "a");
        yield* createAndStartDatabase(Effect.succeed(clientB), "b");

        const idsA = yield* containers(stackId, dataA);
        const idsB = yield* containers(stackId, dataB);
        expect(idsA.length).toBeGreaterThan(0);
        expect(idsB.length).toBeGreaterThan(0);
        expect(idsA.some((id) => idsB.includes(id))).toBe(false);

        yield* signalAndWait(endpointA, "SIGTERM");
        stoppedA = true;
        activeA = undefined;
        expect(yield* containers(stackId, dataA), "SIGTERM removes A containers").toEqual([]);
        expect(yield* containers(stackId, dataB)).toEqual(idsB);
        expect(yield* (yield* stateFor(rootA)).read(stackId)).toBeDefined();

        yield* signalAndWait(endpointB, "SIGINT");
        stoppedB = true;
        activeB = undefined;
        expect(yield* containers(stackId, dataB), "SIGINT removes B containers").toEqual([]);
        expect(yield* (yield* stateFor(rootB)).read(stackId)).toBeDefined();

        const accessA2 = yield* startHost(rootA, cacheRoot, stackId, `${base}/project-a`);
        const endpointA2 = accessA2.endpoint;
        activeA = endpointA2;
        stoppedA = false;
        yield* shutdownOwner(accessA2, true);
        yield* waitForOwnerExit(endpointA2.pid, ownerExitProbe(fs)).pipe(
          Effect.timeout("15 seconds"),
        );
        stoppedA = true;
        activeA = undefined;
        expect(yield* containers(stackId, dataA), "destroy removes A containers").toEqual([]);
        expect(yield* (yield* stateFor(rootA)).read(stackId)).toBeUndefined();

        const accessB2 = yield* startHost(rootB, cacheRoot, stackId, `${base}/project-b`);
        const endpointB2 = accessB2.endpoint;
        activeB = endpointB2;
        stoppedB = false;
        yield* shutdownOwner(accessB2, true);
        yield* waitForOwnerExit(endpointB2.pid, ownerExitProbe(fs)).pipe(
          Effect.timeout("15 seconds"),
        );
        stoppedB = true;
        activeB = undefined;
        expect(yield* containers(stackId, dataB), "destroy removes B containers").toEqual([]);
        expect(yield* (yield* stateFor(rootB)).read(stackId)).toBeUndefined();

        // Abandonment phase: two fresh owners share this id again, each under its own root.
        // Abandoning A must only ever reach containers carrying A's own `stack-root` label.
        const stateA3 = yield* stateFor(rootA);
        const stateB3 = yield* stateFor(rootB);
        yield* stateA3.save({
          id: stackId,
          runtime: "docker",
          identity: {
            projectRoot: `${base}/project-a`,
            branchContext: "container-shutdown-test",
            stackName: stackId,
          },
          instances: [],
          lifetime: "detached",
          composition: { members: [], dependencies: [] },
          ports: [],
        });
        yield* stateB3.save({
          id: stackId,
          runtime: "docker",
          identity: {
            projectRoot: `${base}/project-b`,
            branchContext: "container-shutdown-test",
            stackName: stackId,
          },
          instances: [],
          lifetime: "detached",
          composition: { members: [], dependencies: [] },
          ports: [],
        });
        const accessA3 = yield* launchHost(stateA3, {
          stateRoot: rootA,
          cacheRoot,
          stackId,
          entrypoint: shortRegistrationPollFixture,
        });
        activeA = accessA3.endpoint;
        stoppedA = false;
        const accessB3 = yield* launchHost(stateB3, { stateRoot: rootB, cacheRoot, stackId });
        activeB = accessB3.endpoint;
        stoppedB = false;

        const clientA3 = yield* ownerClient(accessA3);
        const clientB3 = yield* ownerClient(accessB3);
        const mailA3 = yield* clientA3.createService({
          service: "mail",
          config: {},
          endpoints: { http: { port: "auto" } },
        });
        yield* clientA3.startService({ id: mailA3.id });
        yield* clientA3.readyService({ id: mailA3.id });
        const mailB3 = yield* clientB3.createService({
          service: "mail",
          config: {},
          endpoints: { http: { port: "auto" } },
        });
        yield* clientB3.startService({ id: mailB3.id });
        yield* clientB3.readyService({ id: mailB3.id });

        expect(
          (yield* containers(stackId, dataA)).length,
          "A runs its mail container",
        ).toBeGreaterThan(0);
        const idsB3 = yield* containers(stackId, dataB);
        expect(idsB3.length, "B runs its mail container").toBeGreaterThan(0);

        const leaseReleasedA3 = yield* watchLeaseRelease(rootA, stackId);
        yield* fs.remove(`${rootA}/${stackId}/state.json`);
        yield* leaseReleasedA3;
        yield* waitForOwnerExit(accessA3.endpoint.pid, ownerExitProbe(fs)).pipe(
          Effect.timeout("30 seconds"),
        );
        stoppedA = true;
        activeA = undefined;

        expect(
          yield* containers(stackId, dataA),
          "abandoning A removes only A's containers",
        ).toEqual([]);
        expect(
          yield* containers(stackId, dataB),
          "abandoning A leaves B's containers running",
        ).toEqual(idsB3);
        // B's own container still answers a real readiness probe, proving abandonment never
        // touched it.
        yield* clientB3.readyService({ id: mailB3.id });

        yield* shutdownOwner(accessB3, true);
        yield* waitForOwnerExit(accessB3.endpoint.pid, ownerExitProbe(fs)).pipe(
          Effect.timeout("15 seconds"),
        );
        stoppedB = true;
        activeB = undefined;
        expect(yield* containers(stackId, dataB), "destroy removes B containers").toEqual([]);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  { timeout: 180_000 },
);

it.live.skipIf(process.platform === "win32")(
  "removes its containers and exits when its registration is confirmed gone",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "stack-abandon-docker-" });
        const stackId = `abandon-${(yield* crypto.randomUUIDv4).replaceAll("-", "")}`;
        const dataRoot = yield* makeDockerDatabaseRoot("stack-abandon-docker-data-", stackId).pipe(
          Effect.flatMap(fs.realPath),
        );
        const stateRoot = path.dirname(path.dirname(dataRoot));
        const cacheRoot = `${base}/cache`;
        const state = yield* stateFor(stateRoot);
        yield* state.save({
          id: stackId,
          runtime: "docker",
          identity: {
            projectRoot: `${base}/project`,
            branchContext: "abandon-docker-test",
            stackName: stackId,
          },
          instances: [],
          lifetime: "detached",
          composition: { members: [], dependencies: [] },
          ports: [],
        });
        yield* Effect.addFinalizer(() => removeContainers(stackId, dataRoot).pipe(Effect.ignore));
        // The shortened poll interval comes only from this dedicated test entrypoint, through
        // the internal `Context.Reference`; production startup never reads an env var or `Config`.
        const access = yield* launchHost(state, {
          stateRoot,
          cacheRoot,
          stackId,
          entrypoint: shortRegistrationPollFixture,
        });
        const client = yield* ownerClient(access);
        const database = yield* client.createService({
          service: "database",
          config: {
            version: "17",
            databasePassword: Redacted.make("abandon-docker-password"),
            jwtSecret: Redacted.make("abandon-docker-jwt-secret-at-least-thirty-two-characters"),
            jwtExpiry: 3600,
          },
          endpoints: { sql: { port: "auto" } },
        });
        yield* client.startService({ id: database.id });
        yield* client.readyService({ id: database.id });
        expect(
          (yield* containers(stackId, dataRoot)).length,
          "the owner runs the database container",
        ).toBeGreaterThan(0);
        const containerEnvRoot = `${dataRoot}/.container-env`;
        expect(
          yield* fs.exists(containerEnvRoot),
          "the stack's shared container-env scratch directory exists",
        ).toBe(true);

        // Subscribes to the owner's own exit signal (its lease release) before triggering the
        // deletion, rather than polling for it afterward.
        const leaseReleased = yield* watchLeaseRelease(stateRoot, stackId);
        yield* fs.remove(`${stateRoot}/${stackId}/state.json`);
        yield* leaseReleased;
        yield* waitForOwnerExit(access.endpoint.pid, ownerExitProbe(fs)).pipe(
          Effect.timeout("30 seconds"),
        );

        expect(yield* containers(stackId, dataRoot), "abandonment removes containers").toEqual([]);
        expect(
          yield* fs.exists(`${stateRoot}/${stackId}/state.json`),
          "no registration is republished",
        ).toBe(false);
        expect(
          yield* fs.exists(containerEnvRoot),
          "abandonment removes the shared container-env scratch directory",
        ).toBe(false);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  { timeout: 180_000 },
);

it.live.skipIf(process.platform === "win32")(
  "abandons a stack whose registration disappears while a signal-driven stop is still draining",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "stack-abandon-gated-" });
        const stackId = `abandon-gated-${(yield* crypto.randomUUIDv4).replaceAll("-", "")}`;
        const dataRoot = yield* makeDockerDatabaseRoot("stack-abandon-gated-data-", stackId).pipe(
          Effect.flatMap(fs.realPath),
        );
        const stateRoot = path.dirname(path.dirname(dataRoot));
        const cacheRoot = `${base}/cache`;
        const gateDir = `${base}/gate`;
        yield* fs.makeDirectory(gateDir, { recursive: true });
        const state = yield* stateFor(stateRoot);
        yield* state.save({
          id: stackId,
          runtime: "docker",
          identity: {
            projectRoot: `${base}/project`,
            branchContext: "abandon-gated-test",
            stackName: stackId,
          },
          instances: [],
          lifetime: "detached",
          composition: { members: [], dependencies: [] },
          ports: [],
        });
        yield* Effect.addFinalizer(() => removeContainers(stackId, dataRoot).pipe(Effect.ignore));
        const access = yield* launchHost(state, {
          stateRoot,
          cacheRoot,
          stackId,
          entrypoint: gatedDrainFixture,
          entrypointArgs: [gateDir],
        });
        const client = yield* ownerClient(access);
        const database = yield* client.createService({
          service: "database",
          config: {
            version: "17",
            databasePassword: Redacted.make("abandon-gated-password"),
            jwtSecret: Redacted.make("abandon-gated-jwt-secret-at-least-thirty-two-characters"),
            jwtExpiry: 3600,
          },
          endpoints: { sql: { port: "auto" } },
        });
        yield* client.startService({ id: database.id });
        yield* client.readyService({ id: database.id });
        const status = yield* client.status({ id: database.id });
        const port = status.endpoints.find((endpoint) => endpoint.name === "sql")?.port;
        if (port === undefined) return yield* Effect.die("Missing database sql endpoint");
        const containerEnvRoot = `${dataRoot}/.container-env`;
        expect(
          yield* fs.exists(containerEnvRoot),
          "the stack's shared container-env scratch directory exists",
        ).toBe(true);

        // Keeps the sql listener's outstanding-connection count above zero for the whole gated
        // window, so drain can only resolve through the deadline this test controls, never
        // through every connection reaching zero on its own.
        const held = yield* Effect.acquireRelease(
          Effect.callback<Net.Socket, never>((resume) => {
            const connection = Net.createConnection({ host: "127.0.0.1", port });
            connection.once("connect", () => resume(Effect.succeed(connection)));
            connection.once("error", (cause) => resume(Effect.die(cause)));
            return Effect.sync(() => connection.destroy());
          }),
          (connection) => Effect.sync(() => connection.destroy()),
        );

        // Subscribes to the drain-deadline wait's own entry marker before sending the signal that
        // triggers it, so the registration deletion below never races the gate itself.
        const waiting = yield* watchEntry(gateDir, "waiting", true);
        process.kill(access.endpoint.pid, "SIGTERM");
        yield* waiting.pipe(Effect.timeout("30 seconds"));

        yield* fs.remove(`${stateRoot}/${stackId}/state.json`);
        yield* fs.writeFileString(`${gateDir}/release`, "");
        yield* Effect.sync(() => held.destroy());

        yield* waitForOwnerExit(access.endpoint.pid, ownerExitProbe(fs)).pipe(
          Effect.retry({ while: hasReason("owner-exit-pending") }),
          Effect.timeout("30 seconds"),
        );

        expect(
          yield* fs.exists(`${stateRoot}/${stackId}/state.json`),
          "no registration is republished",
        ).toBe(false);
        expect(
          yield* fs.exists(containerEnvRoot),
          "the registration lost during the gated stop still reaches abandonment's cleanup",
        ).toBe(false);
        expect(yield* containers(stackId, dataRoot), "no containers are left behind").toEqual([]);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  { timeout: 180_000 },
);

it.live.skipIf(process.platform === "win32")(
  "removes an orphaned container by label alone, independent of any instance's own cleanup",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "stack-abandon-docker-label-" });
        const stackId = `abandon-label-${(yield* crypto.randomUUIDv4).replaceAll("-", "")}`;
        const dataRoot = yield* makeDockerDatabaseRoot(
          "stack-abandon-docker-label-data-",
          stackId,
        ).pipe(Effect.flatMap(fs.realPath));
        const stateRoot = path.dirname(path.dirname(dataRoot));
        const cacheRoot = `${base}/cache`;
        const state = yield* stateFor(stateRoot);
        yield* state.save({
          id: stackId,
          runtime: "docker",
          identity: {
            projectRoot: `${base}/project`,
            branchContext: "abandon-docker-label-test",
            stackName: stackId,
          },
          instances: [],
          lifetime: "detached" as const,
          composition: { members: [], dependencies: [] },
          ports: [],
        });
        yield* Effect.addFinalizer(() => removeContainers(stackId, dataRoot).pipe(Effect.ignore));
        const access = yield* launchHost(state, {
          stateRoot,
          cacheRoot,
          stackId,
          entrypoint: shortRegistrationPollFixture,
        });
        // No registered service at all, so the per-instance cleanup loop has nothing to do: this
        // container carries only the stack's identity label, simulating a leaked storage helper
        // no claim or helper-registry bookkeeping ever reaches. Only the
        // registration-independent label sweep can remove it.
        yield* docker([
          "run",
          "-d",
          "--name",
          `supabase-orphan-${stackId}`,
          "--label",
          `com.supabase.stack=${stackId}`,
          "--label",
          `com.supabase.stack-root=${dataRoot}`,
          "--label",
          "com.supabase.stack-managed=true",
          helperImage,
          "/bin/sh",
          "-c",
          "trap : TERM INT; while :; do sleep 3600; done",
        ]);
        expect(
          (yield* containers(stackId, dataRoot)).length,
          "the orphan container exists before abandonment",
        ).toBeGreaterThan(0);

        const leaseReleased = yield* watchLeaseRelease(stateRoot, stackId);
        yield* fs.remove(`${stateRoot}/${stackId}/state.json`);
        yield* leaseReleased;
        yield* waitForOwnerExit(access.endpoint.pid, ownerExitProbe(fs)).pipe(
          Effect.timeout("30 seconds"),
        );

        expect(
          yield* containers(stackId, dataRoot),
          "abandonment removes the orphan container by label alone",
        ).toEqual([]);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  { timeout: 180_000 },
);

it.live.skipIf(process.platform === "win32")(
  "removes its containers and exits when its whole state root is confirmed gone",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "stack-abandon-docker-root-" });
        const stackId = `abandon-root-${(yield* crypto.randomUUIDv4).replaceAll("-", "")}`;
        const dataRoot = yield* makeDockerDatabaseRoot(
          "stack-abandon-docker-root-data-",
          stackId,
        ).pipe(Effect.flatMap(fs.realPath));
        const stateRoot = path.dirname(path.dirname(dataRoot));
        const cacheRoot = `${base}/cache`;
        const state = yield* stateFor(stateRoot);
        yield* state.save({
          id: stackId,
          runtime: "docker",
          identity: {
            projectRoot: `${base}/project`,
            branchContext: "abandon-docker-root-test",
            stackName: stackId,
          },
          instances: [],
          lifetime: "detached",
          composition: { members: [], dependencies: [] },
          ports: [],
        });
        yield* Effect.addFinalizer(() => removeContainers(stackId, dataRoot).pipe(Effect.ignore));
        const access = yield* launchHost(state, {
          stateRoot,
          cacheRoot,
          stackId,
          entrypoint: shortRegistrationPollFixture,
        });
        const client = yield* ownerClient(access);
        // `mail` rather than `database`: its container holds no host-mounted data volume, so
        // deleting the state root out from under it doesn't also disrupt its own stop path — this
        // test is about registration-independent cleanup, not about surviving every workload's
        // reaction to losing its mounted storage.
        const mail = yield* client.createService({
          service: "mail",
          config: {},
          endpoints: { http: { port: "auto" } },
        });
        yield* client.startService({ id: mail.id });
        yield* client.readyService({ id: mail.id });
        expect(
          (yield* containers(stackId, dataRoot)).length,
          "the owner runs the mail container",
        ).toBeGreaterThan(0);
        const status = yield* client.status({ id: mail.id });
        const port = status.endpoints.find((endpoint) => endpoint.name === "http")?.port;
        if (port === undefined) return yield* Effect.die("Missing mail http endpoint");

        // Deletes the actual `<stateRoot>` itself, not just the entries inside
        // `<stateRoot>/<stackId>`: its sibling `.registry-lock.sqlite` (`Ports.ts`'s per-root
        // reservation registry) is gone too, so cleanup can only come from the owner's in-memory
        // resources, and must never open that registry at all. The lease file goes with it, so
        // this relies on budgeted polling rather than a lease-release subscription.
        yield* fs.remove(stateRoot, { recursive: true, force: true });
        yield* waitForOwnerExit(access.endpoint.pid, ownerExitProbe(fs)).pipe(
          Effect.retry({
            schedule: Schedule.spaced("1 second"),
            while: (failure) =>
              failure.reason === "owner-exit-pending" || failure.reason === "owner-exit-zombie",
          }),
          Effect.timeout("30 seconds"),
        );

        expect(
          yield* containers(stackId, dataRoot),
          "abandonment removes containers from in-memory resources alone",
        ).toEqual([]);

        // The port reservation is never released by abandonment:
        // a fresh stack can still claim the exact same port, through `Ports.ts`'s own lazy
        // reclamation once the former holder's registration is confirmed gone.
        const reclaimedBase = yield* fs.makeTempDirectoryScoped({
          prefix: "stack-abandon-docker-root-reclaim-",
        });
        const reclaimedStackId = `abandon-root-reclaim-${(yield* crypto.randomUUIDv4).replaceAll("-", "")}`;
        const reclaimedDataRoot = yield* makeDockerDatabaseRoot(
          "stack-abandon-docker-root-reclaim-data-",
          reclaimedStackId,
        ).pipe(Effect.flatMap(fs.realPath));
        const reclaimedStateRoot = path.dirname(path.dirname(reclaimedDataRoot));
        yield* Effect.addFinalizer(() =>
          removeContainers(reclaimedStackId, reclaimedDataRoot).pipe(Effect.ignore),
        );
        const reclaimedAccess = yield* startHost(
          reclaimedStateRoot,
          cacheRoot,
          reclaimedStackId,
          `${reclaimedBase}/project`,
        );
        const reclaimedClient = yield* ownerClient(reclaimedAccess);
        const reclaimedMail = yield* reclaimedClient.createService({
          service: "mail",
          config: {},
          endpoints: { http: { port } },
        });
        yield* reclaimedClient.startService({ id: reclaimedMail.id });
        yield* reclaimedClient.readyService({ id: reclaimedMail.id });
        const reclaimedStatus = yield* reclaimedClient.status({ id: reclaimedMail.id });
        expect(reclaimedStatus.endpoints.find((endpoint) => endpoint.name === "http")?.port).toBe(
          port,
        );
        yield* shutdownOwner(reclaimedAccess, true);
        yield* waitForOwnerExit(reclaimedAccess.endpoint.pid, ownerExitProbe(fs)).pipe(
          Effect.timeout("15 seconds"),
        );
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  { timeout: 180_000 },
);

it.live.skipIf(process.platform === "win32")(
  "drains an in-flight mail request through a real docker owner shutdown, and refuses a new connection once draining begins",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "stack-drain-docker-" });
        const stackId = `drain-docker-${(yield* crypto.randomUUIDv4).replaceAll("-", "")}`;
        const dataRoot = yield* makeDockerDatabaseRoot("stack-drain-docker-data-", stackId).pipe(
          Effect.flatMap(fs.realPath),
        );
        const stateRoot = path.dirname(path.dirname(dataRoot));
        const cacheRoot = `${base}/cache`;
        const gateDir = `${base}/gate`;
        yield* fs.makeDirectory(gateDir, { recursive: true });
        const state = yield* stateFor(stateRoot);
        yield* state.save({
          id: stackId,
          runtime: "docker",
          identity: {
            projectRoot: `${base}/project`,
            branchContext: "drain-docker-test",
            stackName: stackId,
          },
          instances: [],
          lifetime: "detached",
          composition: { members: [], dependencies: [] },
          ports: [],
        });
        yield* Effect.addFinalizer(() => removeContainers(stackId, dataRoot).pipe(Effect.ignore));
        const access = yield* launchHost(state, {
          stateRoot,
          cacheRoot,
          stackId,
          entrypoint: gatedDrainFixture,
          entrypointArgs: [gateDir],
        });
        const client = yield* ownerClient(access);
        const mail = yield* client.createService({
          service: "mail",
          config: {},
          endpoints: { http: { port: "auto" } },
        });
        yield* client.startService({ id: mail.id });
        yield* client.readyService({ id: mail.id });
        const status = yield* client.status({ id: mail.id });
        const port = status.endpoints.find((endpoint) => endpoint.name === "http")?.port;
        if (port === undefined) return yield* Effect.die("Missing mail http endpoint");

        const inFlight = yield* openPartialMailSend(port, "drain-docker-inflight");

        const waiting = yield* watchEntry(gateDir, "waiting", true);
        process.kill(access.endpoint.pid, "SIGTERM");
        yield* waiting.pipe(Effect.timeout("30 seconds"));

        expect(yield* isHttpRefused(port), "a new connection is refused once draining begins").toBe(
          true,
        );

        inFlight.complete();
        const response = yield* inFlight.response.pipe(Effect.timeout("10 seconds"));
        expect(
          response.startsWith("HTTP/1.1 200"),
          "the in-flight request still completes during drain",
        ).toBe(true);

        yield* fs.writeFileString(`${gateDir}/release`, "");
        yield* waitForOwnerExit(access.endpoint.pid, ownerExitProbe(fs)).pipe(
          Effect.retry({ while: hasReason("owner-exit-pending") }),
          Effect.timeout("30 seconds"),
        );
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  { timeout: 180_000 },
);

it.live.skipIf(process.platform === "win32")(
  "keeps a pinned postgres connection serving through a real owner shutdown, and cuts it once the deadline fires",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "stack-drain-postgres-" });
        const stackId = `drain-postgres-${(yield* crypto.randomUUIDv4).replaceAll("-", "")}`;
        const dataRoot = yield* makeDockerDatabaseRoot("stack-drain-postgres-data-", stackId).pipe(
          Effect.flatMap(fs.realPath),
        );
        const stateRoot = path.dirname(path.dirname(dataRoot));
        const cacheRoot = `${base}/cache`;
        const gateDir = `${base}/gate`;
        yield* fs.makeDirectory(gateDir, { recursive: true });
        const state = yield* stateFor(stateRoot);
        yield* state.save({
          id: stackId,
          runtime: "docker",
          identity: {
            projectRoot: `${base}/project`,
            branchContext: "drain-postgres-test",
            stackName: stackId,
          },
          instances: [],
          lifetime: "detached",
          composition: { members: [], dependencies: [] },
          ports: [],
        });
        yield* Effect.addFinalizer(() => removeContainers(stackId, dataRoot).pipe(Effect.ignore));
        const access = yield* launchHost(state, {
          stateRoot,
          cacheRoot,
          stackId,
          entrypoint: gatedDrainFixture,
          entrypointArgs: [gateDir],
        });
        const client = yield* ownerClient(access);
        const password = Redacted.make("drain-postgres-password");
        const database = yield* client.createService({
          service: "database",
          config: {
            version: "17",
            databasePassword: password,
            jwtSecret: Redacted.make("drain-postgres-jwt-secret-at-least-thirty-two-characters"),
            jwtExpiry: 3600,
          },
          endpoints: { sql: { port: "auto" } },
        });
        yield* client.startService({ id: database.id });
        yield* client.readyService({ id: database.id });
        const status = yield* client.status({ id: database.id });
        const port = status.endpoints.find((endpoint) => endpoint.name === "sql")?.port;
        if (port === undefined) return yield* Effect.die("Missing database sql endpoint");

        const services = yield* Layer.build(
          Layer.effect(
            PgClient.PgClient,
            PgClient.makeClient({
              host: "127.0.0.1",
              port,
              database: "postgres",
              username: "supabase_admin",
              password,
            }),
          ).pipe(Layer.provide(Reactivity.layer)),
        );
        const sql = Context.get(services, PgClient.PgClient);
        yield* sql.unsafe("SELECT 1");

        // A second, query-free connection to the same listener: its closure is a push-based
        // signal that the deadline's cut already reached the gateway, with no query to race.
        const probe = yield* Effect.acquireRelease(
          Effect.callback<Net.Socket, never>((resume) => {
            const connection = Net.createConnection({ host: "127.0.0.1", port });
            connection.once("connect", () => resume(Effect.succeed(connection)));
            connection.once("error", (cause) => resume(Effect.die(cause)));
            return Effect.sync(() => connection.destroy());
          }),
          (connection) => Effect.sync(() => connection.destroy()),
        );

        const waiting = yield* watchEntry(gateDir, "waiting", true);
        process.kill(access.endpoint.pid, "SIGTERM");
        yield* waiting.pipe(Effect.timeout("30 seconds"));

        yield* sql.unsafe("SELECT 1");

        const closed = yield* Effect.callback<void, never>((resume) => {
          if (probe.destroyed) {
            resume(Effect.void);
            return Effect.void;
          }
          const onClose = () => resume(Effect.void);
          probe.once("close", onClose);
          return Effect.sync(() => probe.off("close", onClose));
        }).pipe(Effect.forkChild({ startImmediately: true }));
        yield* fs.writeFileString(`${gateDir}/release`, "");
        yield* Fiber.join(closed).pipe(Effect.timeout("30 seconds"));

        const cut = yield* sql.unsafe("SELECT 1").pipe(Effect.timeout("5 seconds"), Effect.exit);
        expect(Exit.isFailure(cut), "the connection is cut once the deadline fires").toBe(true);

        yield* waitForOwnerExit(access.endpoint.pid, ownerExitProbe(fs)).pipe(
          Effect.retry({ while: hasReason("owner-exit-pending") }),
          Effect.timeout("30 seconds"),
        );
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  { timeout: 180_000 },
);
