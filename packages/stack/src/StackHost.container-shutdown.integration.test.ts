import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Crypto, Effect, FileSystem, Layer, Path, Redacted, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as State from "./State.ts";
import { launchHost, waitForOwnerExit } from "./HostProcess.ts";
import { StackRpc } from "./Rpc.ts";
import { makeContainerRuntime } from "./runtime/Container.ts";
import { makeDockerDatabaseRoot } from "../tests/docker-fixture.ts";

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
  Layer.build(State.layer({ root })).pipe(
    Effect.map((context) => Context.get(context, State.Service)),
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

const createOwnedContainer = (name: string, stackId: string, dataRoot: string) =>
  docker([
    "create",
    "--name",
    name,
    "--label",
    `com.supabase.stack=${stackId}`,
    "--label",
    `com.supabase.stack-root=${dataRoot}`,
    helperImage,
  ]);

const clientFor = (port: number) =>
  RpcClient.make(StackRpc).pipe(
    Effect.provide(
      RpcClient.layerProtocolHttp({ url: `http://127.0.0.1:${port}/rpc` }).pipe(
        Layer.provide(RpcSerialization.layerNdjson),
      ),
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
        composition: { members: [], dependencies: [] },
        ports: [],
      });
    return yield* launchHost(state, { stateRoot, cacheRoot, stackId });
  });

it.live.skipIf(process.platform === "win32")(
  "stops only containers owned by the same stack id and data root",
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
        const helper = yield* makeContainerRuntime({ engine: "docker", root: dataA });
        yield* helper.prepare(helperImage);
        let activeA: { readonly pid: number; readonly port: number } | undefined;
        let activeB: { readonly pid: number; readonly port: number } | undefined;
        let stoppedA = true;
        let stoppedB = true;
        const signalAndWait = (endpoint: { pid: number }, signal: NodeJS.Signals) =>
          Effect.sync(() => process.kill(endpoint.pid, signal)).pipe(
            Effect.andThen(waitForOwnerExit(endpoint.pid).pipe(Effect.timeout("15 seconds"))),
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
        const staleAtStartup = yield* createOwnedContainer(
          `stack-stale-${stackId}-startup`,
          stackId,
          dataA,
        );
        const endpointA = yield* startHost(rootA, cacheRoot, stackId, `${base}/project-a`);
        activeA = endpointA;
        stoppedA = false;
        expect(staleAtStartup.length).toBeGreaterThan(0);
        expect(
          yield* containers(stackId, dataA),
          "startup sweep removes A stale container",
        ).toEqual([]);
        const staleForA = yield* createOwnedContainer(
          `stack-stale-${stackId}-parallel`,
          stackId,
          dataA,
        );
        const staleForB = yield* createOwnedContainer(
          `stack-stale-${stackId}-other-root`,
          stackId,
          dataB,
        );
        const endpointB = yield* startHost(rootB, cacheRoot, stackId, `${base}/project-b`);
        activeB = endpointB;
        stoppedB = false;
        expect(staleForA.length).toBeGreaterThan(0);
        expect(staleForB.length).toBeGreaterThan(0);
        expect(yield* containers(stackId, dataA)).toEqual([staleForA]);
        expect(
          yield* containers(stackId, dataB),
          "startup sweep removes B stale container",
        ).toEqual([]);

        const clientA = yield* clientFor(endpointA.port);
        const clientB = yield* clientFor(endpointB.port);
        const createAndStartDatabase = (client: ReturnType<typeof clientFor>, suffix: string) =>
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

        const endpointA2 = yield* startHost(rootA, cacheRoot, stackId, `${base}/project-a`);
        activeA = endpointA2;
        stoppedA = false;
        yield* clientFor(endpointA2.port).pipe(
          Effect.flatMap((rpc) => rpc.shutdown({ destroy: true })),
        );
        yield* waitForOwnerExit(endpointA2.pid).pipe(Effect.timeout("15 seconds"));
        stoppedA = true;
        activeA = undefined;
        expect(yield* containers(stackId, dataA), "destroy removes A containers").toEqual([]);
        expect(yield* (yield* stateFor(rootA)).read(stackId)).toBeUndefined();

        const endpointB2 = yield* startHost(rootB, cacheRoot, stackId, `${base}/project-b`);
        activeB = endpointB2;
        stoppedB = false;
        yield* clientFor(endpointB2.port).pipe(
          Effect.flatMap((rpc) => rpc.shutdown({ destroy: true })),
        );
        yield* waitForOwnerExit(endpointB2.pid).pipe(Effect.timeout("15 seconds"));
        stoppedB = true;
        activeB = undefined;
        expect(yield* containers(stackId, dataB), "destroy removes B containers").toEqual([]);
        expect(yield* (yield* stateFor(rootB)).read(stackId)).toBeUndefined();
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  { timeout: 180_000 },
);
