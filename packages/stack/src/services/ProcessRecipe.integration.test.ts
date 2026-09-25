import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  PlatformError,
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
  Schema,
  Sink,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { ChildProcessSpawner as ChildProcessSpawnerService } from "effect/unstable/process/ChildProcessSpawner";
import { systemError } from "effect/PlatformError";
import * as Net from "node:net";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- the collision fixture owns a local HTTP listener.
import * as NodeHttp from "node:http";
import { prepareNativeArtifact } from "../Artifacts.ts";
import {
  makeArtifactStore,
  type ArtifactRequest,
  type ArtifactSource,
} from "../preparation/ArtifactStore.ts";
import { PreparationError } from "../preparation/Errors.ts";
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
import * as Pooler from "./Pooler.ts";

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

const nativePoolerArtifact = Effect.fn(function* (cacheRoot: string) {
  const platformName = `${process.platform}-${process.arch}`;
  const target =
    platformName === "darwin-arm64"
      ? "darwin-arm64"
      : platformName === "linux-x64"
        ? "linux-amd64"
        : platformName === "linux-arm64"
          ? "linux-arm64"
          : undefined;
  if (target === undefined) return yield* Effect.fail(`Unsupported test platform: ${platformName}`);

  const request: ArtifactRequest = {
    key: `slim-services/pooler/v2.9.12/${target}`,
    requiredRuntimePaths: ["bin/server", "bin/prepare", "bin/provision-tenant"],
    executablePath: "bin/server",
  };
  const fs = yield* FileSystem.FileSystem;
  const server =
    `#!${process.execPath}\nconst http = require("node:http");\n` +
    `const port = Number(process.env.PORT);\n` +
    `if (process.env.TENANT_ID === "unrelated-failure") { console.error("unrelated startup failure"); process.exit(1); }\n` +
    `if (process.env.TENANT_ID === "retry-exhaustion") {\n` +
    `const blocker = http.createServer();\n` +
    `blocker.listen(port, "127.0.0.1", () => {\n` +
    `const failed = http.createServer();\n` +
    `failed.on("error", () => { console.error("port already in use " + "x".repeat(2000)); process.exit(1); });\n` +
    `failed.listen(port, "127.0.0.1");\n` +
    `});\nreturn;\n}\n` +
    `const server = http.createServer((_request, response) => response.end("owned-fixture:" + port));\n` +
    `server.on("error", (error) => { console.error(error); process.exit(1); });\n` +
    `server.listen(port, "127.0.0.1", () => {\n` +
    `console.log("Running SupavisorWeb.Endpoint at 127.0.0.1:" + port + " (http)");\n` +
    `});\n`;
  const oneShot = `#!${process.execPath}\nprocess.exit(0);\n`;
  const source: ArtifactSource = {
    checksum: () => Effect.succeed("0".repeat(64)),
    materialize: (_entry, destination) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(`${destination}/bin`, { recursive: true });
        yield* fs.writeFileString(`${destination}/bin/server`, server);
        yield* fs.writeFileString(`${destination}/bin/prepare`, oneShot);
        yield* fs.writeFileString(`${destination}/bin/provision-tenant`, oneShot);
        yield* fs.chmod(`${destination}/bin/prepare`, 0o755);
        yield* fs.chmod(`${destination}/bin/provision-tenant`, 0o755);
      }).pipe(
        Effect.mapError(
          (cause) =>
            new PreparationError({
              message: `Unable to write native Pooler fixture: ${cause.message}`,
              cause,
            }),
        ),
      ),
  };
  const store = yield* makeArtifactStore({ cacheRoot, source });
  yield* store.prepare(request);
});

const NativeLaunchPayload = Schema.Struct({
  executable: Schema.String,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const countingSpawner = (
  spawner: ChildProcessSpawnerService["Service"],
  mainLaunches: Ref.Ref<number>,
  startupLaunches: Ref.Ref<ReadonlyArray<string>>,
  splitStderr = false,
): ChildProcessSpawnerService["Service"] => ({
  ...spawner,
  spawn: (command) =>
    spawner.spawn(command).pipe(
      Effect.map((handle) => ({
        ...handle,
        stderr: splitStderr
          ? handle.stderr.pipe(
              Stream.flatMap((bytes) =>
                Stream.fromIterable(
                  Array.from({ length: Math.ceil(bytes.length / 128) }, (_, index) =>
                    bytes.slice(index * 128, (index + 1) * 128),
                  ),
                ),
              ),
            )
          : handle.stderr,
        getInputFd: (fd: number) => {
          const sink = handle.getInputFd(fd);
          if (fd !== 4) return sink;
          return Sink.mapInputEffect(sink, (bytes) =>
            Effect.gen(function* () {
              const payload = yield* Schema.decodeEffect(
                Schema.fromJsonString(NativeLaunchPayload),
              )(new TextDecoder().decode(bytes)).pipe(Effect.orDie);
              if (
                payload.executable.endsWith("/bin/server") &&
                (payload.args ?? []).includes("start")
              )
                yield* Ref.update(mainLaunches, (count) => count + 1);
              if (
                payload.executable.endsWith("/bin/prepare") ||
                payload.executable.endsWith("/bin/provision-tenant")
              )
                yield* Ref.update(startupLaunches, (launches) => [
                  ...launches,
                  payload.executable.endsWith("/bin/prepare") ? "prepare" : "provision-tenant",
                ]);
              return bytes;
            }),
          );
        },
      })),
    ),
});

describe("process recipe startup", () => {
  it.effect("runs Realtime preparation without launching its server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const launched: Array<{
          readonly entrypoint?: string;
          readonly args?: ReadonlyArray<string>;
        }> = [];
        const removed = yield* Ref.make(false);
        const container: ContainerRuntime = {
          prepare: () => Effect.void,
          prepareImage: (image) => Effect.succeed(image),
          launch: () => Effect.die("one-shot initialization must not launch the service"),
          launchTool: (input) =>
            Effect.sync(() => {
              launched.push({ entrypoint: input.entrypoint, args: input.args });
              return {
                id: "realtime-prepare",
                ports: {},
                stdout: Stream.empty,
                stderr: Stream.empty,
                exitCode: Effect.succeed(0),
                stdin: Sink.drain,
                stop: Effect.void,
                discard: Effect.void,
                kill: Effect.void,
                remove: Ref.set(removed, true),
              } satisfies ContainerProcess;
            }),
        };
        const realtime = yield* realtimeService(container);

        yield* realtime.initialize;

        expect(launched).toEqual([{ entrypoint: "/app/bin/prepare", args: [] }]);
        expect(yield* Ref.get(removed)).toBe(true);
        expect((yield* realtime.get).lifecycle).toBe("stopped");
      }),
    ).pipe(Effect.provide(platform)),
  );

  it.effect("reports preparation output after cleaning up a failed one-shot process", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stopped = yield* Ref.make(false);
        const removed = yield* Ref.make(false);
        const container: ContainerRuntime = {
          prepare: () => Effect.void,
          prepareImage: (image) => Effect.succeed(image),
          launch: () => Effect.die("one-shot initialization must not launch the service"),
          launchTool: () => {
            const process = {
              id: "realtime-prepare",
              ports: {},
              stdout: Stream.make(encode("controlled migration failure\n")),
              stderr: Stream.empty,
              exitCode: Effect.succeed(1),
              stdin: Sink.drain,
              stop: Ref.set(stopped, true),
              discard: Effect.void,
              kill: Effect.void,
              remove: Ref.set(removed, true),
            } satisfies ContainerProcess;
            return Effect.gen(function* () {
              const scope = yield* Scope.Scope;
              yield* Scope.addFinalizer(scope, process.stop.pipe(Effect.andThen(process.remove)));
              return process;
            });
          },
        };
        const realtime = yield* realtimeService(container);

        const error = yield* Effect.flip(realtime.initialize);

        expect(error.message).toContain("realtime startup exited with 1");
        expect(error.message).toContain("controlled migration failure");
        expect(yield* Ref.get(stopped)).toBe(true);
        expect(yield* Ref.get(removed)).toBe(true);
        expect((yield* realtime.get).lifecycle).toBe("stopped");
      }),
    ).pipe(Effect.provide(platform)),
  );

  it.effect("interrupts and removes the one-shot initialization process before returning", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const stopped = yield* Ref.make(false);
        const removed = yield* Ref.make(false);
        const container: ContainerRuntime = {
          prepare: () => Effect.void,
          prepareImage: (image) => Effect.succeed(image),
          launch: () => Effect.die("one-shot initialization must not launch the service"),
          launchTool: () =>
            Effect.gen(function* () {
              const process = {
                id: "realtime-prepare",
                ports: {},
                stdout: Stream.empty,
                stderr: Stream.empty,
                exitCode: Effect.never,
                stdin: Sink.drain,
                stop: Ref.set(stopped, true),
                discard: Effect.void,
                kill: Effect.void,
                remove: Ref.set(removed, true),
              } satisfies ContainerProcess;
              const scope = yield* Scope.Scope;
              yield* Scope.addFinalizer(scope, process.stop.pipe(Effect.andThen(process.remove)));
              yield* Deferred.succeed(started, undefined);
              return process;
            }),
        };
        const realtime = yield* realtimeService(container);
        const initialization = yield* realtime.initialize.pipe(Effect.forkScoped);
        yield* Deferred.await(started);

        yield* Fiber.interrupt(initialization);

        expect(yield* Ref.get(stopped)).toBe(true);
        expect(yield* Ref.get(removed)).toBe(true);
        expect((yield* realtime.get).lifecycle).toBe("stopped");
      }),
    ).pipe(Effect.provide(platform)),
  );

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

  it.live("recovers when a healthy competing listener claims Pooler's selected HTTP port", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const client = yield* HttpClient.HttpClient;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "process-recipe-port-race-" });
        const cacheRoot = path.join(root, "cache");
        yield* nativePoolerArtifact(cacheRoot);
        const collisionPort = yield* Ref.make<number | undefined>(undefined);
        const collisionInstalled = yield* Ref.make(false);
        const competitor = yield* Ref.make<NodeHttp.Server | undefined>(undefined);
        const testScope = yield* Scope.fork(yield* Effect.scope, "sequential");
        yield* Effect.addFinalizer(() => Scope.close(testScope, Exit.void));
        const creation: Pooler.Creation = {
          service: "pooler",
          config: {
            databaseUrl: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
            jwtSecret: "pooler-collision-test-secret-with-more-than-32-characters",
            tenant: "collision-test",
            poolMode: "transaction",
          },
        };
        const interceptingSpawner: typeof spawner = {
          ...spawner,
          spawn: (command) =>
            spawner.spawn(command).pipe(
              Effect.map((handle) => ({
                ...handle,
                getInputFd: (fd: number) => {
                  const sink = handle.getInputFd(fd);
                  if (fd !== 4) return sink;
                  return Sink.mapInputEffect(sink, (bytes) =>
                    Effect.gen(function* () {
                      const payload = yield* Schema.decodeEffect(
                        Schema.fromJsonString(NativeLaunchPayload),
                      )(new TextDecoder().decode(bytes)).pipe(Effect.orDie);
                      if (
                        !payload.executable.endsWith("/bin/server") ||
                        !(payload.args ?? []).includes("start") ||
                        (yield* Ref.get(collisionInstalled))
                      )
                        return bytes;

                      const port = Number(payload.env?.PORT);
                      const server = NodeHttp.createServer((_request, response) =>
                        response.end("competing-listener"),
                      );
                      yield* Effect.addFinalizer(() =>
                        server.listening
                          ? Effect.callback<void, never>((resume) => {
                              server.close(() => resume(Effect.void));
                              return Effect.void;
                            })
                          : Effect.void,
                      ).pipe(Scope.provide(testScope));
                      yield* Effect.callback<void, never>((resume) => {
                        const onError = (cause: Error) => resume(Effect.die(cause));
                        server.once("error", onError);
                        server.listen(port, "127.0.0.1", () => resume(Effect.void));
                        return Effect.sync(() => server.off("error", onError));
                      });
                      yield* Ref.set(collisionPort, port);
                      yield* Ref.set(competitor, server);
                      yield* Ref.set(collisionInstalled, true);
                      return bytes;
                    }),
                  );
                },
              })),
            ),
        };
        const recipe = yield* makeProcessRecipe(
          creation,
          {
            stackId: "process-recipe-port-race",
            instanceId: "instance",
            root,
            cacheRoot,
            runtime: "native",
            platform: { os: process.platform, arch: process.arch },
          },
          { fs, path, crypto, client, spawner: interceptingSpawner, container: undefined },
          Pooler.makeSpec(),
        );
        if (recipe.definition.prepare !== undefined) yield* recipe.definition.prepare(creation);
        const scope = yield* Scope.fork(testScope, "sequential");
        const runtime = yield* recipe.definition.launch({
          id: "pooler",
          config: creation,
          scope,
        });
        const endpoints = yield* Ref.get(recipe.endpoints);
        const endpoint = endpoints.get("http");
        const collided = yield* Ref.get(collisionPort);
        expect(collided).toBeDefined();
        expect(endpoint?.port).not.toBe(collided);
        const oldPort = yield* Ref.get(collisionPort);
        const competingServer = yield* Ref.get(competitor);
        expect(competingServer?.listening).toBe(true);
        const competingResponse = yield* client.execute(
          HttpClientRequest.get(`http://127.0.0.1:${oldPort}/api/health`),
        );
        expect(yield* competingResponse.text).toBe("competing-listener");
        const response = yield* client.execute(
          HttpClientRequest.get(`http://${endpoint?.host}:${endpoint?.port}/api/health`),
        );
        expect(yield* response.text).toBe(`owned-fixture:${endpoint?.port}`);
        expect(yield* Ref.get(collisionInstalled)).toBe(true);
        yield* runtime.stop;
      }),
    ).pipe(Effect.provide(platform)),
  );

  it.live("stops after three consecutive native Pooler port collisions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const client = yield* HttpClient.HttpClient;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "process-recipe-port-exhaustion-",
        });
        const cacheRoot = path.join(root, "cache");
        yield* nativePoolerArtifact(cacheRoot);
        const mainLaunches = yield* Ref.make(0);
        const startupLaunches = yield* Ref.make<ReadonlyArray<string>>([]);
        const creation: Pooler.Creation = {
          service: "pooler",
          config: {
            databaseUrl: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
            jwtSecret: "pooler-collision-test-secret-with-more-than-32-characters",
            tenant: "retry-exhaustion",
            poolMode: "transaction",
          },
        };
        const recipe = yield* makeProcessRecipe(
          creation,
          {
            stackId: "process-recipe-port-exhaustion",
            instanceId: "instance",
            root,
            cacheRoot,
            runtime: "native",
            platform: { os: process.platform, arch: process.arch },
          },
          {
            fs,
            path,
            crypto,
            client,
            spawner: countingSpawner(spawner, mainLaunches, startupLaunches, true),
            container: undefined,
          },
          Pooler.makeSpec(),
        );
        const service = yield* makeService(recipe.definition, { id: "pooler", config: creation });
        const subscribed = yield* Deferred.make<void>();
        const exitObserved = yield* Deferred.make<void>();
        yield* service.observation.pipe(
          Stream.tap(() => Deferred.succeed(subscribed, undefined)),
          Stream.runForEach((observation) =>
            observation.exit === undefined
              ? Effect.void
              : Deferred.succeed(exitObserved, undefined),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(subscribed);
        yield* service.start;
        yield* Deferred.await(exitObserved);
        expect(yield* Ref.get(mainLaunches)).toBe(3);
        expect(yield* Ref.get(startupLaunches)).toEqual(["prepare", "provision-tenant"]);
        expect(yield* Ref.get(recipe.endpoints)).toEqual(new Map());
        const ready = yield* Effect.exit(service.ready);
        expect(Exit.isFailure(ready)).toBe(true);
        if (Exit.isFailure(ready))
          expect(ready.cause.toString()).toContain("native port collision");
        const observation = yield* service.get;
        expect(observation.error?.operation).toBe("launch");
        expect(observation.error?.message).toContain("native port collision");
        expect(observation.exit).toBeDefined();
        if (observation.exit !== undefined) {
          expect(Exit.isFailure(observation.exit)).toBe(true);
          if (Exit.isFailure(observation.exit))
            expect(observation.exit.cause.toString()).toContain("native port collision");
        }
        yield* service.stop;
        expect((yield* service.get).lifecycle).toBe("stopped");
        expect(yield* Ref.get(recipe.endpoints)).toEqual(new Map());
      }),
    ).pipe(Effect.provide(platform)),
  );

  it.effect("preserves the collision diagnostic when retries cross the readiness deadline", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const client = yield* HttpClient.HttpClient;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "process-recipe-deadline-" });
        const cacheRoot = path.join(root, "cache");
        yield* nativePoolerArtifact(cacheRoot);
        const exitReached = yield* Deferred.make<void>();
        const clockAdvanced = yield* Deferred.make<void>();
        const deadlineSpawner: typeof spawner = {
          ...spawner,
          spawn: (command) =>
            spawner.spawn(command).pipe(
              Effect.map((handle) => {
                let mainProcess = false;
                return {
                  ...handle,
                  exitCode: handle.exitCode.pipe(
                    Effect.tap(() =>
                      mainProcess ? Deferred.succeed(exitReached, undefined) : Effect.void,
                    ),
                  ),
                  stderr: Stream.suspend(() =>
                    mainProcess
                      ? handle.stderr.pipe(
                          Stream.concat(
                            Stream.fromEffectDrain(
                              Deferred.await(exitReached).pipe(
                                Effect.andThen(TestClock.adjust("61 seconds")),
                                Effect.tap(() => Deferred.succeed(clockAdvanced, undefined)),
                              ),
                            ),
                          ),
                        )
                      : handle.stderr,
                  ),
                  getInputFd: (fd: number) => {
                    const sink = handle.getInputFd(fd);
                    if (fd !== 4) return sink;
                    return Sink.mapInputEffect(sink, (bytes) =>
                      Effect.gen(function* () {
                        const payload = yield* Schema.decodeEffect(
                          Schema.fromJsonString(NativeLaunchPayload),
                        )(new TextDecoder().decode(bytes)).pipe(Effect.orDie);
                        if (
                          payload.executable.endsWith("/bin/server") &&
                          (payload.args ?? []).includes("start")
                        )
                          mainProcess = true;
                        return bytes;
                      }),
                    );
                  },
                };
              }),
            ),
        };
        const creation: Pooler.Creation = {
          service: "pooler",
          config: {
            databaseUrl: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
            jwtSecret: "pooler-collision-test-secret-with-more-than-32-characters",
            tenant: "retry-exhaustion",
            poolMode: "transaction",
          },
        };
        const recipe = yield* makeProcessRecipe(
          creation,
          {
            stackId: "process-recipe-deadline",
            instanceId: "instance",
            root,
            cacheRoot,
            runtime: "native",
            platform: { os: process.platform, arch: process.arch },
          },
          { fs, path, crypto, client, spawner: deadlineSpawner, container: undefined },
          Pooler.makeSpec(),
        );
        if (recipe.definition.prepare !== undefined) yield* recipe.definition.prepare(creation);
        const scope = yield* Scope.fork(yield* Effect.scope, "sequential");
        const launched = recipe.definition
          .launch({ id: "pooler", config: creation, scope })
          .pipe(Effect.forkChild);
        const fiber = yield* launched;
        yield* Deferred.await(clockAdvanced);
        const runtime = yield* Fiber.join(fiber);
        const failure = yield* Effect.flip(runtime.health);
        expect(failure.operation).toBe("launch");
        expect(failure.message).toContain("native port collision");
        expect(failure.message).not.toContain("readiness timed out");
        const exit = yield* runtime.exit;
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("native port collision");
        expect(yield* Ref.get(recipe.endpoints)).toEqual(new Map());
        yield* runtime.stop;
      }),
    ).pipe(Effect.provide(platform)),
  );

  it.live("does not retry an unrelated native Pooler startup failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const client = yield* HttpClient.HttpClient;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "process-recipe-unrelated-failure-",
        });
        const cacheRoot = path.join(root, "cache");
        yield* nativePoolerArtifact(cacheRoot);
        const mainLaunches = yield* Ref.make(0);
        const startupLaunches = yield* Ref.make<ReadonlyArray<string>>([]);
        const creation: Pooler.Creation = {
          service: "pooler",
          config: {
            databaseUrl: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
            jwtSecret: "pooler-collision-test-secret-with-more-than-32-characters",
            tenant: "unrelated-failure",
            poolMode: "transaction",
          },
        };
        const recipe = yield* makeProcessRecipe(
          creation,
          {
            stackId: "process-recipe-unrelated-failure",
            instanceId: "instance",
            root,
            cacheRoot,
            runtime: "native",
            platform: { os: process.platform, arch: process.arch },
          },
          {
            fs,
            path,
            crypto,
            client,
            spawner: countingSpawner(spawner, mainLaunches, startupLaunches),
            container: undefined,
          },
          Pooler.makeSpec(),
        );
        if (recipe.definition.prepare !== undefined) yield* recipe.definition.prepare(creation);
        const scope = yield* Scope.fork(yield* Effect.scope, "sequential");
        const runtime = yield* recipe.definition.launch({ id: "pooler", config: creation, scope });
        expect(yield* Ref.get(mainLaunches)).toBe(1);
        expect(yield* Ref.get(startupLaunches)).toEqual(["prepare", "provision-tenant"]);
        expect(yield* Ref.get(recipe.endpoints)).toEqual(new Map());
        const health = yield* Effect.exit(runtime.health);
        expect(Exit.isFailure(health)).toBe(true);
        if (Exit.isFailure(health))
          expect(health.cause.toString()).toContain("unrelated startup failure");
        const exit = yield* runtime.exit;
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(exit.cause.toString()).toContain("unrelated startup failure");
        yield* runtime.stop;
      }),
    ).pipe(Effect.provide(platform)),
  );

  it.live("cleans up a native process when exit observation fails before output ends", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const client = yield* HttpClient.HttpClient;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "process-recipe-exit-failure-" });
        const cacheRoot = path.join(root, "cache");
        yield* nativePoolerArtifact(cacheRoot);
        const port = yield* Ref.make<number | undefined>(undefined);
        let mainProcess = false;
        const failingSpawner: typeof spawner = {
          ...spawner,
          spawn: (command) =>
            spawner.spawn(command).pipe(
              Effect.map((handle) => ({
                ...handle,
                stdout: Stream.suspend(() => (mainProcess ? Stream.never : handle.stdout)),
                stderr: Stream.suspend(() => (mainProcess ? Stream.never : handle.stderr)),
                exitCode: Effect.suspend(() =>
                  mainProcess
                    ? Effect.fail(
                        PlatformError.systemError({
                          _tag: "PermissionDenied",
                          module: "ChildProcess",
                          method: "exitCode",
                          description: "injected native exit observation failure",
                          cause: { code: "EIO" },
                        }),
                      )
                    : handle.exitCode,
                ),
                getInputFd: (fd: number) => {
                  const sink = handle.getInputFd(fd);
                  if (fd !== 4) return sink;
                  return Sink.mapInputEffect(sink, (bytes) =>
                    Effect.gen(function* () {
                      const payload = yield* Schema.decodeEffect(
                        Schema.fromJsonString(NativeLaunchPayload),
                      )(new TextDecoder().decode(bytes)).pipe(Effect.orDie);
                      if (
                        payload.executable.endsWith("/bin/server") &&
                        (payload.args ?? []).includes("start")
                      ) {
                        mainProcess = true;
                        yield* Ref.set(port, Number(payload.env?.PORT));
                      }
                      return bytes;
                    }),
                  );
                },
              })),
            ),
        };
        const creation: Pooler.Creation = {
          service: "pooler",
          config: {
            databaseUrl: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
            jwtSecret: "pooler-collision-test-secret-with-more-than-32-characters",
            tenant: "exit-observation-failure",
            poolMode: "transaction",
          },
        };
        const recipe = yield* makeProcessRecipe(
          creation,
          {
            stackId: "process-recipe-exit-failure",
            instanceId: "instance",
            root,
            cacheRoot,
            runtime: "native",
            platform: { os: process.platform, arch: process.arch },
          },
          { fs, path, crypto, client, spawner: failingSpawner, container: undefined },
          Pooler.makeSpec(),
        );
        if (recipe.definition.prepare !== undefined) yield* recipe.definition.prepare(creation);
        const scope = yield* Scope.fork(yield* Effect.scope, "sequential");
        const runtime = yield* recipe.definition.launch({ id: "pooler", config: creation, scope });
        const health = yield* Effect.exit(runtime.health);
        expect(Exit.isFailure(health)).toBe(true);
        const exit = yield* runtime.exit;
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(exit.cause.toString()).toContain("injected native exit observation failure");
        expect(yield* Ref.get(recipe.endpoints)).toEqual(new Map());

        const portToProbe = yield* Ref.get(port);
        expect(portToProbe).toBeDefined();
        if (portToProbe !== undefined) {
          const probe = NodeHttp.createServer();
          const bind = Effect.callback<void, never>((resume) => {
            const onError = (cause: Error) => resume(Effect.die(cause));
            probe.once("error", onError);
            probe.listen(portToProbe, "127.0.0.1", () => resume(Effect.void));
            return Effect.sync(() => probe.off("error", onError));
          });
          const close = Effect.callback<void, never>((resume) => {
            probe.close(() => resume(Effect.void));
            return Effect.void;
          });
          yield* bind.pipe(Effect.ensuring(close));
        }
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
