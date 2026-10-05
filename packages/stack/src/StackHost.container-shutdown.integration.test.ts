import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Crypto, Effect, FileSystem, Layer, Path, Redacted, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
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
import { shutdownOwner } from "../tests/owner.ts";
import { noContainerClaims } from "../tests/claims.ts";

const shortRegistrationPollFixture = fileURLToPath(
  new URL("../tests/short-registration-poll-fixture.ts", import.meta.url),
);

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
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const target = yield* resolveEngineTarget(spawner);
        const helper = yield* makeContainerRuntime({
          claims: noContainerClaims,
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
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  { timeout: 180_000 },
);

it.live.skipIf(process.platform === "win32")(
  "removes its containers and exits when its registration is confirmed gone (F6)",
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
        // The shortened poll interval (F6) comes only from this dedicated test entrypoint, through
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

        yield* fs.remove(`${stateRoot}/${stackId}/state.json`);
        yield* waitForOwnerExit(access.endpoint.pid, ownerExitProbe(fs)).pipe(
          Effect.timeout("30 seconds"),
        );

        expect(yield* containers(stackId, dataRoot), "abandonment removes containers").toEqual([]);
        expect(
          yield* fs.exists(`${stateRoot}/${stackId}/state.json`),
          "no registration is republished",
        ).toBe(false);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  { timeout: 180_000 },
);
