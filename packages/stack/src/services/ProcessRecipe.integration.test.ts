import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Crypto,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Ref,
  Scope,
  Sink,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient } from "effect/unstable/http";
import { TestClock } from "effect/testing";
import { systemError } from "effect/PlatformError";
import * as Net from "node:net";
import { prepareNativeArtifact } from "../Artifacts.ts";
import {
  ContainerError,
  ContainerLaunchError,
  type ContainerProcess,
  type ContainerRuntime,
} from "../runtime/Container.ts";
import { makeService, ServiceError } from "../Service.ts";
import {
  makeProcessRecipe,
  type ProcessDependencies,
  type ProcessRecipeSpec,
} from "./ProcessRecipe.ts";
import type { CatalogOptions, RecipeCreation } from "./Recipe.ts";
import * as Realtime from "./Realtime.ts";

type TestCreation = RecipeCreation<"rest", Record<string, never>> & {
  readonly service: "rest";
  readonly version: "v16.2";
};

const creation: TestCreation = {
  service: "rest",
  version: "v16.2",
  config: {},
};

const options: CatalogOptions = {
  stackId: "process-recipe-test",
  instanceId: "rest",
  root: "/tmp/process-recipe-test",
  cacheRoot: "/tmp/process-recipe-test-cache",
  runtime: "docker",
};

const spec: ProcessRecipeSpec<TestCreation> = {
  service: "rest",
  executable: "postgrest",
  ports: { http: 8080 },
  healthPath: "/",
  args: () => Effect.succeed([]),
  env: () => Effect.succeed({}),
  mounts: () => Effect.succeed([]),
  startup: [{ args: [] }],
};

const isPortOccupied = (port: number): Effect.Effect<boolean> =>
  Effect.callback<boolean, never>((resume) => {
    const server = Net.createServer();
    server.once("error", (cause: NodeJS.ErrnoException) =>
      resume(Effect.succeed(cause.code === "EADDRINUSE")),
    );
    server.listen(port, "127.0.0.1", () => server.close(() => resume(Effect.succeed(false))));
    return Effect.sync(() => {
      if (server.listening) server.close();
    });
  });

describe("ProcessRecipe launch cleanup", () => {
  for (const scenario of [
    "partial launch",
    "startup wait failure",
    "startup remove failure",
  ] as const) {
    it.effect(`retains a ${scenario} container for retry`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const startupLaunches = yield* Ref.make(0);
          const serviceLaunches = yield* Ref.make(0);
          const active = yield* Ref.make(0);
          const cleanupFailure = yield* Ref.make<"stop" | undefined>("stop");
          const startupRemoveFailed = yield* Ref.make(scenario === "startup remove failure");
          const makeProcess = (
            id: string,
            exitCode: Effect.Effect<number, ContainerError>,
          ): ContainerProcess => ({
            id,
            ports: { 8080: 18080 },
            stdout: Stream.empty,
            stderr: Stream.empty,
            exitCode,
            stdin: Sink.drain,
            stop: Effect.gen(function* () {
              if ((yield* Ref.get(cleanupFailure)) === "stop")
                return yield* new ContainerError({
                  operation: "stop",
                  message: "temporary stop failure",
                });
              yield* Ref.set(active, 0);
            }),
            discard: Effect.void,
            kill: Effect.void,
            remove: Effect.gen(function* () {
              if (yield* Ref.getAndSet(startupRemoveFailed, false))
                return yield* new ContainerError({
                  operation: "remove",
                  message: "temporary startup remove failure",
                });
              yield* Ref.set(active, 0);
            }),
          });
          const container: ContainerRuntime = {
            prepare: () => Effect.void,
            prepareImage: (image) => Effect.succeed(image),
            launchTool: () =>
              Effect.gen(function* () {
                const launch = yield* Ref.updateAndGet(startupLaunches, (value) => value + 1);
                if (launch === 1) {
                  yield* Ref.set(active, 1);
                  if (scenario === "partial launch")
                    return yield* new ContainerLaunchError({
                      failure: new ContainerError({
                        operation: "start",
                        message: "container did not start",
                      }),
                      process: makeProcess("partial-startup", Effect.never),
                    });
                  if (scenario === "startup wait failure")
                    return makeProcess(
                      "failed-startup",
                      Effect.fail(
                        new ContainerError({
                          operation: "exit",
                          message: "startup process failed",
                        }),
                      ),
                    );
                  return makeProcess("remove-failure-startup", Effect.succeed(0));
                }
                expect(yield* Ref.get(active)).toBe(0);
                yield* Ref.set(active, 1);
                return makeProcess("startup", Effect.succeed(0));
              }),
            launch: () =>
              Effect.gen(function* () {
                expect(yield* Ref.get(active)).toBe(0);
                yield* Ref.updateAndGet(serviceLaunches, (value) => value + 1);
                yield* Ref.set(active, 1);
                return makeProcess("service", Effect.never);
              }),
          };
          const dependencies = {
            fs: yield* FileSystem.FileSystem,
            path: yield* Path.Path,
            crypto: yield* Crypto.Crypto,
            client: yield* HttpClient.HttpClient,
            spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
            container,
          } satisfies ProcessDependencies;
          const recipe = yield* makeProcessRecipe(creation, options, dependencies, spec);
          const service = yield* makeService(recipe.definition, {
            id: `rest-process-recipe-${scenario}`,
            config: creation,
          });

          expect(Exit.isFailure(yield* service.start.pipe(Effect.exit))).toBe(true);
          expect((yield* service.get).lifecycle).toBe("stopping");
          expect((yield* service.get).cleanupError?.operation).toBe("stop");
          expect(yield* Ref.get(startupLaunches)).toBe(1);
          expect(yield* Ref.get(serviceLaunches)).toBe(0);
          expect(yield* Ref.get(active)).toBe(1);

          yield* Ref.set(cleanupFailure, undefined);
          yield* service.start;
          expect((yield* service.get).lifecycle).toBe("running");
          expect(yield* Ref.get(startupLaunches)).toBe(2);
          expect(yield* Ref.get(serviceLaunches)).toBe(1);
          expect(yield* Ref.get(active)).toBe(1);
          yield* service.stop;
        }).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
      ),
    );
  }

  it.live("retains a native startup process for retry after cleanup failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const client = yield* HttpClient.HttpClient;
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const cleanupFailure = yield* Ref.make(true);
        let startupWrapped = false;
        const spawner = ChildProcessSpawner.make((command) =>
          delegate.spawn(command).pipe(
            Effect.map((handle) => {
              if (
                startupWrapped ||
                !ChildProcess.isStandardCommand(command) ||
                !command.args.some(
                  (argument) =>
                    argument === "__supabase_stack_native__" ||
                    argument.endsWith("/native-launcher.ts"),
                )
              )
                return handle;
              startupWrapped = true;
              return ChildProcessSpawner.makeHandle({
                ...handle,
                exitCode: handle.exitCode.pipe(Effect.map(() => ChildProcessSpawner.ExitCode(1))),
                isRunning: Effect.gen(function* () {
                  if (yield* Ref.get(cleanupFailure))
                    return yield* systemError({
                      _tag: "PermissionDenied",
                      module: "ProcessRecipe.integration.test",
                      method: "isRunning",
                      description: "injected native cleanup failure",
                    });
                  return yield* handle.isRunning;
                }),
              });
            }),
          ),
        );
        const nativeOptions: CatalogOptions = {
          ...options,
          root: yield* fs.makeTempDirectoryScoped({ prefix: "process-recipe-native-" }),
          cacheRoot: "/tmp/supabase-stack-artifacts",
          runtime: "native",
        };
        const nativeSpec: ProcessRecipeSpec<TestCreation> = {
          ...spec,
          startup: [{ nativeExecutable: "postgrest", args: ["--version"] }],
        };
        const dependencies = {
          fs,
          path,
          crypto,
          client,
          spawner,
          container: undefined,
        } satisfies ProcessDependencies;
        const recipe = yield* makeProcessRecipe(creation, nativeOptions, dependencies, nativeSpec);
        const service = yield* makeService(recipe.definition, {
          id: "rest-process-recipe-native",
          config: creation,
        });

        const failure = yield* service.start.pipe(Effect.exit);
        expect(Exit.isFailure(failure)).toBe(true);
        expect((yield* service.get).lifecycle).toBe("stopping");
        expect((yield* service.get).cleanupError?.operation).toBe("stop");
        expect(startupWrapped).toBe(true);

        yield* Ref.set(cleanupFailure, false);
        yield* service.stop;
        expect((yield* service.get).lifecycle).toBe("stopped");
        expect((yield* service.get).cleanupError).toBeUndefined();
      }).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    ),
  );

  it.live("holds all native serving ports until allocation completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const client = yield* HttpClient.HttpClient;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const testScope = yield* Scope.Scope;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "process-recipe-port-order-" });
        const cacheRoot = "/tmp/supabase-stack-artifacts";
        const artifact = yield* prepareNativeArtifact(
          { service: "rest", version: "v16.2" },
          cacheRoot,
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HttpClient.HttpClient, client),
        );
        const nativeOptions: CatalogOptions = {
          ...options,
          root,
          cacheRoot,
          runtime: "native",
        };
        const blocked = yield* Ref.make<Net.Server | undefined>(undefined);
        const helperPort = yield* Ref.make<number | undefined>(undefined);
        const servingPorts = yield* Ref.make<ReadonlyArray<number>>([]);
        const nativeSpec: ProcessRecipeSpec<TestCreation> = {
          ...spec,
          ports: { http: 8080, smtp: 1025, pop3: 1110 },
          args: (_creation, endpoints) =>
            Effect.gen(function* () {
              const ports = [...endpoints.values()].map((endpoint) => endpoint.port);
              yield* Ref.set(servingPorts, ports);
              expect(new Set(ports).size).toBe(ports.length);
              for (const port of ports) expect(yield* isPortOccupied(port)).toBe(true);
              return ["--version"];
            }),
          env: (_creation, endpoints) =>
            Effect.gen(function* () {
              const port = endpoints.get("http")?.port;
              if (port === undefined)
                return yield* new ServiceError({
                  operation: "launch",
                  message: "Native recipe did not provide an HTTP port",
                });
              if ((yield* Ref.get(blocked)) === undefined) {
                yield* Ref.set(helperPort, port);
                const server = yield* Effect.acquireRelease(
                  Effect.callback<Net.Server, Error>((resume) => {
                    const candidate = Net.createServer();
                    const onError = (error: Error) => resume(Effect.fail(error));
                    candidate.once("error", onError);
                    candidate.listen(port, "127.0.0.1", () => resume(Effect.succeed(candidate)));
                    return Effect.sync(() => {
                      candidate.off("error", onError);
                      if (candidate.listening) candidate.close();
                    });
                  }).pipe(
                    Effect.mapError(
                      (cause) =>
                        new ServiceError({
                          operation: "launch",
                          message: "Unable to occupy the startup helper port",
                          cause,
                        }),
                    ),
                  ),
                  (server) =>
                    Effect.callback<void, never>((resume) => {
                      server.close(() => resume(Effect.void));
                      return Effect.void;
                    }),
                ).pipe(Effect.provideService(Scope.Scope, testScope));
                yield* Ref.set(blocked, server);
              }
              return { PORT: String(port) };
            }),
          startup: [
            {
              nativeExecutable: path.relative(path.join(artifact.root, "bin"), process.execPath),
              args: [
                "-e",
                `import net from "node:net"; const server = net.createServer(); server.once("error", () => process.exit(17)); server.listen(Number(process.env.PORT), "127.0.0.1", () => server.close((error) => process.exit(error ? 18 : 0)));`,
              ],
            },
          ],
        };
        const dependencies = {
          fs,
          path,
          crypto,
          client,
          spawner,
          container: undefined,
        } satisfies ProcessDependencies;
        const recipe = yield* makeProcessRecipe(creation, nativeOptions, dependencies, nativeSpec);
        const service = yield* makeService(recipe.definition, {
          id: "rest-process-recipe-port-order",
          config: creation,
        });

        yield* service.start;
        const helper = yield* Ref.get(helperPort);
        const blocker = yield* Ref.get(blocked);
        const ports = yield* Ref.get(servingPorts);
        expect(helper).toBe(0);
        expect(blocker?.listening).toBe(true);
        expect(ports).toHaveLength(3);
        expect(ports.every((port) => port > 0)).toBe(true);
        yield* service.stop;
      }).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    ),
  );
});

const encode = (text: string) => new TextEncoder().encode(text);

const poolTimeout =
  "** (DBConnection.ConnectionError) connection not available and request was dropped from queue";

const postgrexFailure =
  '[error] Postgrex.Protocol ("db_conn_1") failed to connect: ** (DBConnection.ConnectionError) tcp connect (host.docker.internal:54322): network is unreachable - :enetunreach';

const startupContainer = (tool: {
  readonly stdout: Stream.Stream<string>;
  readonly stderr: Stream.Stream<string>;
  readonly exitCode: Effect.Effect<number>;
}): ContainerRuntime => ({
  prepare: () => Effect.void,
  prepareImage: (image) => Effect.succeed(image),
  launch: () => Effect.die("the main process must not launch after a failed startup"),
  launchTool: () =>
    Effect.succeed({
      id: "startup-tool",
      ports: {},
      stdout: tool.stdout.pipe(Stream.map(encode)),
      stderr: tool.stderr.pipe(Stream.map(encode)),
      exitCode: tool.exitCode,
      stdin: Sink.drain,
      stop: Effect.void,
      discard: Effect.void,
      kill: Effect.void,
      remove: Effect.void,
    }),
});

const realtimeService = Effect.fn(function* (container: ContainerRuntime) {
  const creation: Realtime.Creation = {
    service: "realtime",
    config: { databaseUrl: "postgresql://postgres:postgres@host.docker.internal:54322/postgres" },
  };
  const recipe = yield* makeProcessRecipe(
    creation,
    {
      stackId: "process-recipe-test",
      instanceId: "instance",
      root: "/unused",
      cacheRoot: "/unused/cache",
      runtime: "docker",
    },
    {
      fs: yield* FileSystem.FileSystem,
      path: yield* Path.Path,
      crypto: yield* Crypto.Crypto,
      client: yield* HttpClient.HttpClient,
      spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
      container,
    },
    Realtime.makeSpec(),
  );
  return yield* makeService(recipe.definition, { id: "realtime", config: creation });
});

const platform = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);

describe("process recipe startup", () => {
  it.effect("reports the startup process's recent stdout and stderr when it exits non-zero", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const realtime = yield* realtimeService(
          startupContainer({
            stdout: Stream.make(
              "[info] Running migrations\n",
              postgrexFailure.slice(0, 60),
              `${postgrexFailure.slice(60)}\n`,
            ),
            stderr: Stream.make(`${poolTimeout}\n`),
            exitCode: Effect.succeed(1),
          }),
        );

        const error = yield* Effect.flip(realtime.start);

        expect(error.message).toContain("realtime startup exited with 1");
        expect(error.message).toContain(postgrexFailure);
        expect(error.message).toContain(poolTimeout);
      }),
    ).pipe(Effect.provide(platform)),
  );

  it.effect("keeps the stderr error when later stdout exceeds the tail", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stderrWritten = yield* Deferred.make<void>();
        const noise = Array.from({ length: 30 }, (_, index) => `[info] shutdown step ${index}\n`);
        const realtime = yield* realtimeService(
          startupContainer({
            stdout: Stream.fromEffectDrain(Deferred.await(stderrWritten)).pipe(
              Stream.concat(Stream.fromIterable(noise)),
            ),
            stderr: Stream.make(`${poolTimeout}\n`).pipe(
              Stream.concat(Stream.fromEffectDrain(Deferred.succeed(stderrWritten, undefined))),
            ),
            exitCode: Effect.succeed(1),
          }),
        );

        const error = yield* Effect.flip(realtime.start);

        expect(error.message).toContain(poolTimeout);
        expect(error.message).toContain("[info] shutdown step 29");
        expect(error.message).not.toContain("[info] shutdown step 9\n");
      }),
    ).pipe(Effect.provide(platform)),
  );

  it.effect(
    "reports the startup process's recent output, including an unterminated line, when it never exits",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const running = yield* Deferred.make<void>();
          const realtime = yield* realtimeService(
            startupContainer({
              stdout: Stream.make(
                `${postgrexFailure}\n`,
                "[info] ",
                "😀".repeat(2_500),
                " Retrying database connection",
              ).pipe(
                Stream.concat(Stream.fromEffectDrain(Deferred.succeed(running, undefined))),
                Stream.concat(Stream.never),
              ),
              stderr: Stream.never,
              exitCode: Effect.never,
            }),
          );

          const failure = yield* realtime.start.pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(running);
          yield* Effect.yieldNow;
          yield* TestClock.adjust("60 seconds");
          const error = yield* Fiber.join(failure);

          expect(error.message).toContain("realtime startup timed out after 60 seconds");
          expect(error.message).toContain(postgrexFailure);
          expect(error.message).toContain("😀 Retrying database connection");
          expect(error.message).not.toContain("[info] 😀");
          expect(error.message).not.toMatch(/…[\uDC00-\uDFFF]/);
          expect(error.message.length).toBeLessThan(2_000);
        }),
      ).pipe(Effect.provide(platform)),
  );
});
