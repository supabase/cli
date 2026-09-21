import {
  Cause,
  Crypto,
  Effect,
  Exit,
  FileSystem,
  Path,
  PubSub,
  Ref,
  Schedule,
  Scope,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { ChildProcessSpawner as ChildProcessSpawnerService } from "effect/unstable/process/ChildProcessSpawner";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as Net from "node:net";
import { prepareNativeArtifact, resolveArtifact, type ServiceKind } from "../Artifacts.ts";
import {
  type ContainerError,
  type ContainerProcess,
  type ContainerRuntime,
} from "../runtime/Container.ts";
import {
  defaultNativeProcessLauncher,
  type NativeProcess,
  type NativeProcessError,
  spawnNativeProcess,
} from "../runtime/NativeProcess.ts";
import { ServiceError, ServiceLaunchError, type RuntimeSession } from "../Service.ts";
import {
  type CatalogLog,
  CatalogError,
  type CatalogOptions,
  type ProcessRecipeResult,
  type RecipeCreation,
  type ServiceEndpoint,
} from "./Recipe.ts";

interface RecipeMount {
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
}

interface StartupProcess {
  readonly args: ReadonlyArray<string>;
  readonly nativeExecutable?: string;
  readonly containerEntrypoint?: string;
  readonly skipInContainer?: boolean;
}

export interface ProcessRecipeSpec<C extends RecipeCreation<ServiceKind, unknown>> {
  readonly service: C["service"];
  readonly executable: string;
  readonly ports: Readonly<Record<string, number>>;
  readonly healthPath: string;
  readonly args: (
    creation: C,
    endpoints: ReadonlyMap<string, ServiceEndpoint>,
    context: { readonly container: boolean; readonly artifactRoot?: string },
  ) => Effect.Effect<ReadonlyArray<string>, ServiceError>;
  readonly env: (
    creation: C,
    endpoints: ReadonlyMap<string, ServiceEndpoint>,
    container: boolean,
  ) => Effect.Effect<Readonly<Record<string, string>>, ServiceError>;
  readonly mounts: (
    creation: C,
    context: { readonly container: boolean },
  ) => Effect.Effect<ReadonlyArray<RecipeMount>, ServiceError>;
  readonly startup: ReadonlyArray<StartupProcess>;
  readonly enabledPort?: (creation: C, name: string) => boolean;
  readonly containerPort?: (creation: C, name: string, port: number) => number;
  readonly containerEntrypoint?: (creation: C) => string | undefined;
  readonly prepare?: (creation: C) => Effect.Effect<void, ServiceError>;
  readonly removeData?: (creation: C) => Effect.Effect<void, ServiceError>;
}

export interface ProcessDependencies {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly crypto: Crypto.Crypto;
  readonly client: HttpClient.HttpClient;
  readonly spawner: ChildProcessSpawnerService["Service"];
  readonly container: ContainerRuntime | undefined;
}

const serviceError = (operation: string, cause: unknown): ServiceError =>
  cause instanceof ServiceError
    ? cause
    : new ServiceError({
        operation,
        message: Cause.isTimeoutError(cause)
          ? `Service ${operation} timed out`
          : cause instanceof Error
            ? cause.message
            : String(cause),
        cause,
      });

const catalogError = (operation: string, message: string, service?: ServiceKind, cause?: unknown) =>
  new CatalogError({
    operation,
    message,
    ...(service === undefined ? {} : { service }),
    ...(cause === undefined ? {} : { cause }),
  });

const processExit = (
  exitCode: Effect.Effect<number, { readonly message: string }>,
): Effect.Effect<Exit.Exit<void, ServiceError>> =>
  exitCode.pipe(
    Effect.flatMap((code) =>
      Number(code) === 0
        ? Effect.void
        : Effect.fail(
            new ServiceError({ operation: "exit", message: `Process exited with ${code}` }),
          ),
    ),
    Effect.mapError((cause) => serviceError("exit", cause)),
    Effect.exit,
  );

const runtimeFromContainer = (process: ContainerProcess): RuntimeSession => ({
  health: Effect.void,
  exit: processExit(process.exitCode),
  stop: process.stop.pipe(Effect.mapError((cause) => serviceError("stop", cause))),
  remove: process.remove.pipe(Effect.mapError((cause) => serviceError("remove", cause))),
});

const reserveNativePort = Effect.fn("ProcessRecipe.reserveNativePort")(
  (requested: number): Effect.Effect<number, CatalogError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const allocation = yield* Effect.acquireRelease(
          Effect.callback<{ readonly port: number; readonly server: Net.Server }, CatalogError>(
            (resume) => {
              const server = Net.createServer();
              const onError = (cause: Error) =>
                resume(
                  Effect.fail(
                    catalogError(
                      "launch",
                      "Unable to reserve native service port",
                      undefined,
                      cause,
                    ),
                  ),
                );
              server.once("error", onError);
              server.listen({ host: "127.0.0.1", port: requested }, () => {
                const address = server.address();
                if (address === null || typeof address === "string") {
                  onError(new Error("Native service port reservation returned no address"));
                } else {
                  resume(Effect.succeed({ port: address.port, server }));
                }
              });
              return Effect.sync(() => {
                server.off("error", onError);
                if (server.listening) server.close();
              });
            },
          ),
          ({ server }) =>
            Effect.callback<void, never>((resume) => {
              server.close(() => resume(Effect.void));
              return Effect.void;
            }),
        );
        return allocation.port;
      }),
    ),
);

const publishLogs = Effect.fn("ProcessRecipe.publishLogs")((
  process: {
    readonly stdout: Stream.Stream<Uint8Array, unknown>;
    readonly stderr: Stream.Stream<Uint8Array, unknown>;
  },
  logs: PubSub.PubSub<CatalogLog>,
  scope: Scope.Closeable,
): Effect.Effect<void> => {
  const drain = (stream: Stream.Stream<Uint8Array, unknown>, name: CatalogLog["stream"]) =>
    stream.pipe(
      Stream.runForEach((bytes) => PubSub.publish(logs, { stream: name, bytes })),
      Effect.catch((cause) => Effect.logError(cause)),
      Effect.asVoid,
    );
  return Effect.all(
    [
      Effect.forkIn(drain(process.stdout, "stdout"), scope),
      Effect.forkIn(drain(process.stderr, "stderr"), scope),
    ],
    { concurrency: "unbounded", discard: true },
  );
});

const awaitStartup = Effect.fn("ProcessRecipe.awaitStartup")(
  (
    process: {
      readonly stdout: Stream.Stream<Uint8Array, NativeProcessError | ContainerError>;
      readonly stderr: Stream.Stream<Uint8Array, NativeProcessError | ContainerError>;
      readonly exitCode: Effect.Effect<number, NativeProcessError | ContainerError>;
    },
    logs: PubSub.PubSub<CatalogLog>,
  ): Effect.Effect<Readonly<{ readonly code: number; readonly stderr: string }>, ServiceError> =>
    Effect.gen(function* () {
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          process.stdout.pipe(
            Stream.decodeText,
            Stream.runFold(
              () => "",
              (text, chunk) => text + chunk,
            ),
          ),
          process.stderr.pipe(
            Stream.decodeText,
            Stream.runFold(
              () => "",
              (text, chunk) => text + chunk,
            ),
          ),
          process.exitCode,
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.mapError((cause) => serviceError("launch", cause)));
      if (stdout.length > 0)
        yield* PubSub.publish(logs, {
          stream: "stdout",
          bytes: new TextEncoder().encode(stdout),
        });
      if (stderr.length > 0)
        yield* PubSub.publish(logs, {
          stream: "stderr",
          bytes: new TextEncoder().encode(stderr),
        });
      return { code: Number(exitCode), stderr };
    }).pipe(
      Effect.timeout("60 seconds"),
      Effect.mapError((cause) => serviceError("launch", cause)),
    ),
);

const readiness = Effect.fn("ProcessRecipe.readiness")(
  (
    client: HttpClient.HttpClient,
    endpoint: ServiceEndpoint,
    path: string,
  ): Effect.Effect<void, ServiceError> =>
    client.execute(HttpClientRequest.get(`http://${endpoint.host}:${endpoint.port}${path}`)).pipe(
      Effect.flatMap((response) =>
        (response.status >= 200 && response.status < 300) || response.status === 401
          ? Effect.void
          : Effect.fail(
              new ServiceError({ operation: "health", message: `HTTP ${response.status}` }),
            ),
      ),
      Effect.retry({ schedule: Schedule.spaced("250 millis") }),
      Effect.timeout("60 seconds"),
      Effect.mapError((cause) => serviceError("health", cause)),
      Effect.asVoid,
    ),
);

export const makeProcessRecipe = <C extends RecipeCreation<ServiceKind, unknown>>(
  creation: C,
  options: CatalogOptions,
  deps: ProcessDependencies,
  spec: ProcessRecipeSpec<C>,
): Effect.Effect<ProcessRecipeResult<C>> =>
  Effect.gen(function* () {
    const prepared = yield* Ref.make<string | undefined>(undefined);
    const preparedRoot = yield* Ref.make<string | undefined>(undefined);
    const endpoints = yield* Ref.make<ReadonlyMap<string, ServiceEndpoint>>(new Map());
    const logs = yield* PubSub.sliding<CatalogLog>(256);

    const prepare = Effect.fn("ProcessRecipe.prepare")(function* (candidate: C) {
      if (spec.prepare !== undefined) yield* spec.prepare(candidate);
      const resolved = yield* resolveArtifact({
        service: candidate.service,
        version: candidate.version,
      }).pipe(Effect.mapError((cause) => serviceError("prepare", cause)));
      if (options.runtime === "native") {
        const artifact = yield* prepareNativeArtifact(
          { service: candidate.service, version: candidate.version },
          options.cacheRoot,
          options.platform,
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, deps.fs),
          Effect.provideService(Path.Path, deps.path),
          Effect.provideService(Crypto.Crypto, deps.crypto),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, deps.spawner),
          Effect.provideService(HttpClient.HttpClient, deps.client),
          Effect.mapError((cause) => serviceError("prepare", cause)),
        );
        yield* Ref.set(prepared, artifact.executable);
        yield* Ref.set(preparedRoot, artifact.root);
      } else {
        if (deps.container === undefined)
          return yield* serviceError("prepare", "Container runtime unavailable");
        yield* deps.container
          .prepare(resolved.image)
          .pipe(Effect.mapError((cause) => serviceError("prepare", cause)));
      }
    });

    const launch = Effect.fn("ProcessRecipe.launch")(function* (context: {
      readonly id: string;
      readonly config: C;
      readonly scope: Scope.Closeable;
    }) {
      const desired = new Map<string, ServiceEndpoint>();
      for (const [name, port] of Object.entries(spec.ports)) {
        if (spec.enabledPort !== undefined && !spec.enabledPort(context.config, name)) continue;
        desired.set(name, {
          kind: "tcp",
          host: "127.0.0.1",
          port:
            options.runtime === "native"
              ? yield* reserveNativePort(0).pipe(
                  Effect.mapError((cause) => serviceError("launch", cause)),
                )
              : port,
        });
      }
      if (options.runtime === "native") {
        const executable = yield* Ref.get(prepared);
        const artifactRoot = yield* Ref.get(preparedRoot);
        if (executable === undefined)
          return yield* serviceError("launch", "Artifact was not prepared");
        if (artifactRoot === undefined)
          return yield* serviceError("launch", "Artifact root was not prepared");
        for (const [index, process] of spec.startup.entries()) {
          const startupProcess = yield* spawnNativeProcess(
            {
              executable: `${artifactRoot}/bin/${process.nativeExecutable ?? "prepare"}`,
              args: process.args,
              env: yield* spec.env(context.config, desired, false),
              cwd: artifactRoot,
            },
            defaultNativeProcessLauncher(),
            {
              stackId: String(options.stackId),
              workloadId: `${context.id}-${context.config.service}-startup-${index}`,
            },
          ).pipe(
            Scope.provide(context.scope),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, deps.spawner),
            Effect.mapError((cause) => serviceError("launch", cause)),
          );
          const result = yield* awaitStartup(startupProcess, logs);
          if (result.code !== 0)
            return yield* serviceError(
              "launch",
              `${context.config.service} startup exited with ${result.code}: ${result.stderr.trim()}`,
            );
        }
        const native: NativeProcess = yield* spawnNativeProcess(
          {
            executable,
            args: yield* spec.args(context.config, desired, { container: false, artifactRoot }),
            env: yield* spec.env(context.config, desired, false),
            gracefulStopSignal: "SIGTERM",
            gracefulStopTimeout: "5 seconds",
          },
          defaultNativeProcessLauncher(),
          { stackId: String(options.stackId), workloadId: context.id },
        ).pipe(
          Scope.provide(context.scope),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, deps.spawner),
          Effect.mapError((cause) => serviceError("launch", cause)),
        );
        yield* Ref.set(endpoints, desired);
        yield* publishLogs(native, logs, context.scope);
        const ready = desired.get("http");
        return {
          health:
            ready === undefined
              ? Effect.fail(serviceError("health", "Recipe has no HTTP readiness endpoint"))
              : readiness(deps.client, ready, spec.healthPath),
          exit: processExit(native.exitCode),
          stop: native.kill.pipe(Effect.mapError((cause) => serviceError("stop", cause))),
          remove: Ref.set(endpoints, new Map()),
        } satisfies RuntimeSession;
      }
      if (deps.container === undefined)
        return yield* serviceError("launch", "Container runtime unavailable");
      const resolved = yield* resolveArtifact({
        service: context.config.service,
        version: context.config.version,
      }).pipe(Effect.mapError((cause) => serviceError("launch", cause)));
      const containerDesired = new Map<string, ServiceEndpoint>();
      for (const [name, endpoint] of desired) {
        const port =
          spec.containerPort === undefined
            ? endpoint.port
            : spec.containerPort(context.config, name, endpoint.port);
        containerDesired.set(name, { ...endpoint, port });
      }
      for (const process of spec.startup) {
        if (process.skipInContainer === true) continue;
        const startupProcess = yield* deps.container
          .launchTool({
            image: resolved.image,
            stackId: options.stackId,
            instanceId: options.instanceId,
            env: yield* spec.env(context.config, containerDesired, true),
            entrypoint: process.containerEntrypoint,
            args: process.args,
            mounts: yield* spec.mounts(context.config, { container: true }),
          })
          .pipe(
            Effect.mapError((cause) => serviceError("launch", cause)),
            Scope.provide(context.scope),
          );
        const result = yield* awaitStartup(startupProcess, logs);
        yield* startupProcess.remove.pipe(
          Effect.mapError((cause) => serviceError("launch", cause)),
        );
        if (result.code !== 0)
          return yield* serviceError(
            "launch",
            `${context.config.service} startup exited with ${result.code}: ${result.stderr.trim()}`,
          );
      }
      const launched = yield* deps.container
        .launch({
          image: resolved.image,
          stackId: options.stackId,
          instanceId: options.instanceId,
          env: yield* spec.env(context.config, containerDesired, true),
          entrypoint: spec.containerEntrypoint?.(context.config),
          args: yield* spec.args(context.config, containerDesired, { container: true }),
          mounts: yield* spec.mounts(context.config, { container: true }),
          ports: [...containerDesired.values()].map((endpoint) => endpoint.port),
        })
        .pipe(
          Effect.catchTag("ContainerLaunchError", ({ failure, process }) =>
            Effect.fail(
              new ServiceLaunchError({
                failure: serviceError("launch", failure),
                runtime: runtimeFromContainer(process),
              }),
            ),
          ),
          Effect.mapError((cause) =>
            cause instanceof ServiceLaunchError ? cause : serviceError("launch", cause),
          ),
          Scope.provide(context.scope),
        );
      const selected = new Map<string, ServiceEndpoint>();
      for (const [name, endpoint] of containerDesired) {
        const published = launched.ports[endpoint.port];
        if (published === undefined)
          return yield* serviceError("launch", `Container did not publish ${name}`);
        selected.set(name, { kind: "tcp", host: "127.0.0.1", port: published });
      }
      yield* Ref.set(endpoints, selected);
      yield* publishLogs(launched, logs, context.scope);
      const runtime = runtimeFromContainer(launched);
      const ready = selected.get("http");
      return {
        ...runtime,
        health:
          ready === undefined
            ? Effect.fail(serviceError("health", "Recipe has no HTTP readiness endpoint"))
            : readiness(deps.client, ready, spec.healthPath),
        remove: runtime.remove.pipe(Effect.tap(() => Ref.set(endpoints, new Map()))),
      } satisfies RuntimeSession;
    });

    return {
      definition: {
        prepare,
        launch,
        removeData: (context) =>
          (spec.removeData?.(context.config) ?? Effect.void).pipe(
            Effect.andThen(Ref.set(endpoints, new Map())),
          ),
      },
      endpoints,
      logs: Stream.fromPubSub(logs).pipe(
        Stream.mapError((cause) => catalogError("logs", String(cause), creation.service)),
      ),
    };
  });
