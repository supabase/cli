import {
  Cause,
  Clock,
  Crypto,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Option,
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
  readonly nativeStartupEnv?: (
    creation: C,
    endpoints: ReadonlyMap<string, ServiceEndpoint>,
  ) => Effect.Effect<Readonly<Record<string, string>>, ServiceError>;
  readonly nativeReadinessOutput?: (
    line: string,
    endpoints: ReadonlyMap<string, ServiceEndpoint>,
  ) => boolean;
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

interface NativePortReservation {
  readonly port: number;
  readonly server: Net.Server;
}

const closeNativePort = (server: Net.Server): Effect.Effect<void> =>
  Effect.callback<void, never>((resume) => {
    if (!server.listening) {
      resume(Effect.void);
      return Effect.void;
    }
    server.close(() => resume(Effect.void));
    return Effect.void;
  });

const reserveNativePort = Effect.fn("ProcessRecipe.reserveNativePort")(
  (requested: number): Effect.Effect<NativePortReservation, CatalogError, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.callback<NativePortReservation, CatalogError>((resume) => {
        const server = Net.createServer((socket) => socket.destroy());
        const onError = (cause: Error) =>
          resume(
            Effect.fail(
              catalogError("launch", "Unable to reserve native service port", undefined, cause),
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
      }),
      ({ server }) => closeNativePort(server),
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

const startupTimeoutSeconds = 60;
const startupOutputTailLines = 20;
const startupOutputLineChars = 1_000;

type StartupOutput = Readonly<Record<CatalogLog["stream"], ReadonlyArray<string>>>;

const clipLine = (line: string) =>
  line.length > startupOutputLineChars
    ? `…${line.slice(-startupOutputLineChars).replace(/^[\uDC00-\uDFFF]/, "")}`
    : line;

const withRecentOutput = (summary: string, output: StartupOutput) =>
  [
    summary,
    ...(["stdout", "stderr"] as const)
      .filter((name) => output[name].length > 0)
      .map((name) => `Recent ${name}:\n${output[name].join("\n")}`),
  ].join("\n");

const awaitStartup = Effect.fn("ProcessRecipe.awaitStartup")(
  (
    service: ServiceKind,
    process: {
      readonly stdout: Stream.Stream<Uint8Array, NativeProcessError | ContainerError>;
      readonly stderr: Stream.Stream<Uint8Array, NativeProcessError | ContainerError>;
      readonly exitCode: Effect.Effect<number, NativeProcessError | ContainerError>;
    },
    logs: PubSub.PubSub<CatalogLog>,
  ): Effect.Effect<
    Readonly<{ readonly code: number; readonly output: StartupOutput }>,
    ServiceError
  > =>
    Effect.gen(function* () {
      const collect = Effect.fnUntraced(function* (
        stream: Stream.Stream<Uint8Array, NativeProcessError | ContainerError>,
        name: CatalogLog["stream"],
        tail: Ref.Ref<ReadonlyArray<string>>,
      ) {
        const appendLines = (lines: ReadonlyArray<string>) =>
          Ref.update(tail, (current) =>
            [...current, ...lines.filter((line) => line.trim().length > 0).map(clipLine)].slice(
              -startupOutputTailLines,
            ),
          );
        const partial = yield* Ref.make("");
        // The unterminated last line is flushed on interruption so a timeout still reports it.
        yield* stream.pipe(
          Stream.tap((bytes) => PubSub.publish(logs, { stream: name, bytes })),
          Stream.decodeText,
          Stream.runForEach((text) =>
            Ref.modify(partial, (rest): [ReadonlyArray<string>, string] => {
              const lines = `${rest}${text}`.split(/\r?\n/);
              const next = lines.pop() ?? "";
              return [lines, next.slice(-(startupOutputLineChars + 1))];
            }).pipe(Effect.flatMap(appendLines)),
          ),
          Effect.ensuring(Ref.get(partial).pipe(Effect.flatMap((rest) => appendLines([rest])))),
        );
      });
      const stdout = yield* Ref.make<ReadonlyArray<string>>([]);
      const stderr = yield* Ref.make<ReadonlyArray<string>>([]);
      const completed = yield* Effect.all(
        [
          collect(process.stdout, "stdout", stdout),
          collect(process.stderr, "stderr", stderr),
          process.exitCode,
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError((cause) => serviceError("launch", cause)),
        Effect.timeoutOption(Duration.seconds(startupTimeoutSeconds)),
      );
      const output = { stdout: yield* Ref.get(stdout), stderr: yield* Ref.get(stderr) };
      if (Option.isNone(completed))
        return yield* serviceError(
          "launch",
          withRecentOutput(
            `${service} startup timed out after ${startupTimeoutSeconds} seconds`,
            output,
          ),
        );
      return { code: Number(completed.value[2]), output };
    }),
);

const startupFailure = (
  service: ServiceKind,
  result: { readonly code: number; readonly output: StartupOutput },
): ServiceError =>
  serviceError(
    "launch",
    withRecentOutput(`${service} startup exited with ${result.code}`, result.output),
  );

const isAddressInUse = (line: string) =>
  /eaddrinuse|address already in use|port already in use/i.test(line);

const terminalSession = (
  error: ServiceError,
  endpoints: Ref.Ref<ReadonlyMap<string, ServiceEndpoint>>,
) =>
  ({
    health: Effect.fail(error),
    exit: Effect.succeed(Exit.fail(error)),
    stop: Effect.void,
    remove: Ref.set(endpoints, new Map()),
  }) satisfies RuntimeSession;

const collectNativeOutput = Effect.fn("ProcessRecipe.collectNativeOutput")(function* (
  process: NativeProcess,
  logs: PubSub.PubSub<CatalogLog>,
  endpoints: ReadonlyMap<string, ServiceEndpoint>,
  readinessOutput:
    | ((line: string, endpoints: ReadonlyMap<string, ServiceEndpoint>) => boolean)
    | undefined,
  scope: Scope.Closeable,
) {
  const bindReady = yield* Deferred.make<void>();
  const bindError = yield* Ref.make(false);
  const stdout = yield* Ref.make<ReadonlyArray<string>>([]);
  const stderr = yield* Ref.make<ReadonlyArray<string>>([]);
  const drained = yield* Deferred.make<void>();

  const consume = Effect.fnUntraced(function* (
    stream: Stream.Stream<Uint8Array, NativeProcessError>,
    name: CatalogLog["stream"],
    tail: Ref.Ref<ReadonlyArray<string>>,
  ) {
    const partial = yield* Ref.make("");
    const append = (lines: ReadonlyArray<string>) =>
      Effect.forEach(
        lines,
        (line) =>
          Effect.gen(function* () {
            if (readinessOutput?.(line, endpoints) === true)
              yield* Deferred.succeed(bindReady, undefined);
            if (isAddressInUse(line)) yield* Ref.set(bindError, true);
            if (line.trim().length > 0)
              yield* Ref.update(tail, (current) =>
                [...current, clipLine(line)].slice(-startupOutputTailLines),
              );
          }),
        { discard: true },
      );
    yield* stream.pipe(
      Stream.tap((bytes) => PubSub.publish(logs, { stream: name, bytes })),
      Stream.decodeText,
      Stream.runForEach((text) =>
        Ref.modify(
          partial,
          (
            rest,
          ): [{ readonly lines: ReadonlyArray<string>; readonly combined: string }, string] => {
            const combined = `${rest}${text}`;
            const lines = combined.split(/\r?\n/);
            const next = lines.pop() ?? "";
            return [{ lines, combined }, next.slice(-(startupOutputLineChars + 1))];
          },
        ).pipe(
          Effect.flatMap(({ lines, combined }) =>
            Effect.gen(function* () {
              if (isAddressInUse(combined)) yield* Ref.set(bindError, true);
              yield* append(lines);
            }),
          ),
        ),
      ),
      Effect.ensuring(Ref.get(partial).pipe(Effect.flatMap((rest) => append([rest])))),
    );
  });

  const drain = Effect.all(
    [consume(process.stdout, "stdout", stdout), consume(process.stderr, "stderr", stderr)],
    { concurrency: "unbounded", discard: true },
  ).pipe(
    Effect.ensuring(Deferred.succeed(drained, undefined)),
    Effect.catch((cause) => Effect.logError(cause)),
  );
  yield* Effect.forkIn(drain, scope);
  return { bindReady, bindError, stdout, stderr, drained };
});

const readiness = Effect.fn("ProcessRecipe.readiness")(
  (
    client: HttpClient.HttpClient,
    endpoint: ServiceEndpoint,
    path: string,
    timeout: Duration.Input = "60 seconds",
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
      Effect.timeout(timeout),
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
      const portNames = Object.entries(spec.ports).filter(
        ([name]) => spec.enabledPort === undefined || spec.enabledPort(context.config, name),
      );
      if (options.runtime === "native") {
        const executable = yield* Ref.get(prepared);
        const artifactRoot = yield* Ref.get(preparedRoot);
        if (executable === undefined)
          return yield* serviceError("launch", "Artifact was not prepared");
        if (artifactRoot === undefined)
          return yield* serviceError("launch", "Artifact root was not prepared");
        const reserveEndpoints = Effect.fn("ProcessRecipe.reserveEndpoints")(function* (
          parent: Scope.Closeable,
        ) {
          const portScope = yield* Scope.fork(parent, "sequential");
          const reservations = yield* Effect.forEach(portNames, () => reserveNativePort(0), {
            concurrency: 1,
          }).pipe(
            Scope.provide(portScope),
            Effect.mapError((cause) => serviceError("launch", cause)),
          );
          const selected = new Map<string, ServiceEndpoint>();
          for (const [index, [name]] of portNames.entries()) {
            const reservation = reservations[index];
            if (reservation === undefined)
              return yield* serviceError("launch", `Native ${name} port was not reserved`);
            selected.set(name, {
              kind: "tcp",
              host: "127.0.0.1",
              port: reservation.port,
            });
          }
          return { portScope, endpoints: selected };
        });

        let reusableReservation:
          | {
              readonly portScope: Scope.Closeable;
              readonly endpoints: ReadonlyMap<string, ServiceEndpoint>;
            }
          | undefined;
        let reusableEndpoints: ReadonlyMap<string, ServiceEndpoint> | undefined;
        if (spec.startup.length > 0) {
          const startupScope = yield* Scope.fork(context.scope, "sequential");
          const reservation = yield* reserveEndpoints(
            spec.nativeStartupEnv === undefined ? startupScope : context.scope,
          );
          if (spec.nativeStartupEnv === undefined) {
            yield* Scope.close(reservation.portScope, Exit.void);
            reusableEndpoints = reservation.endpoints;
          }
          for (const [index, process] of spec.startup.entries()) {
            const startupProcess = yield* spawnNativeProcess(
              {
                executable: `${artifactRoot}/bin/${process.nativeExecutable ?? "prepare"}`,
                args: process.args,
                env: yield* (spec.nativeStartupEnv ?? spec.env)(
                  context.config,
                  reservation.endpoints,
                  false,
                ),
                cwd: artifactRoot,
              },
              defaultNativeProcessLauncher(),
              {
                stackId: String(options.stackId),
                workloadId: `${context.id}-${context.config.service}-startup-${index}`,
              },
            ).pipe(
              Scope.provide(startupScope),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, deps.spawner),
              Effect.mapError((cause) => serviceError("launch", cause)),
            );
            const result = yield* awaitStartup(context.config.service, startupProcess, logs);
            if (result.code !== 0) {
              yield* Scope.close(reservation.portScope, Exit.void);
              yield* Scope.close(startupScope, Exit.void);
              return yield* startupFailure(context.config.service, result);
            }
          }
          yield* Scope.close(startupScope, Exit.void);
          if (spec.nativeStartupEnv !== undefined) reusableReservation = reservation;
        }

        const deadline = (yield* Clock.currentTimeMillis) + startupTimeoutSeconds * 1_000;
        const lastCollision = yield* Ref.make<ServiceError | undefined>(undefined);
        let firstAttempt = true;
        const launchAttempt = Effect.fn("ProcessRecipe.launchNativeAttempt")(function* () {
          if (
            spec.nativeReadinessOutput !== undefined &&
            (yield* Clock.currentTimeMillis) >= deadline
          ) {
            const previousCollision = yield* Ref.get(lastCollision);
            return terminalSession(
              previousCollision === undefined
                ? serviceError("health", `${context.config.service} native readiness timed out`)
                : serviceError("launch", previousCollision.message),
              endpoints,
            );
          }
          const attemptScope = yield* Scope.fork(context.scope, "sequential");
          const heldReservation = firstAttempt ? reusableReservation : undefined;
          const reuse = firstAttempt
            ? (heldReservation?.endpoints ?? reusableEndpoints)
            : undefined;
          firstAttempt = false;
          const reservation =
            reuse === undefined ? yield* reserveEndpoints(attemptScope) : undefined;
          const selected = reuse ?? reservation?.endpoints ?? new Map<string, ServiceEndpoint>();
          const args = yield* spec.args(context.config, selected, {
            container: false,
            artifactRoot,
          });
          const env = yield* spec.env(context.config, selected, false);
          if (reservation !== undefined) yield* Scope.close(reservation.portScope, Exit.void);
          if (heldReservation !== undefined)
            yield* Scope.close(heldReservation.portScope, Exit.void);

          const native: NativeProcess = yield* spawnNativeProcess(
            {
              executable,
              args,
              env,
              gracefulStopSignal: "SIGTERM",
              gracefulStopTimeout: "5 seconds",
            },
            defaultNativeProcessLauncher(),
            { stackId: String(options.stackId), workloadId: context.id },
          ).pipe(
            Scope.provide(attemptScope),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, deps.spawner),
            Effect.mapError((cause) => serviceError("launch", cause)),
          );

          if (spec.nativeReadinessOutput === undefined) {
            yield* Ref.set(endpoints, selected);
            yield* publishLogs(native, logs, attemptScope);
            const ready = selected.get("http");
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

          const output = yield* collectNativeOutput(
            native,
            logs,
            selected,
            spec.nativeReadinessOutput,
            attemptScope,
          );
          const ready = selected.get("http");
          const timeLeft = Math.max(0, deadline - (yield* Clock.currentTimeMillis));
          const readyCondition =
            ready === undefined
              ? Effect.fail(serviceError("health", "Recipe has no HTTP readiness endpoint"))
              : Effect.all(
                  [
                    readiness(deps.client, ready, spec.healthPath, Duration.millis(timeLeft)),
                    Deferred.await(output.bindReady),
                  ],
                  { concurrency: "unbounded", discard: true },
                ).pipe(Effect.asVoid);
          const boundedReady = readyCondition.pipe(
            Effect.timeout(Duration.millis(timeLeft)),
            Effect.mapError((cause) => serviceError("health", cause)),
          );
          const observed = yield* Effect.race(
            Effect.exit(boundedReady).pipe(
              Effect.map((result) => ({ _tag: "ready" as const, result })),
            ),
            Effect.exit(native.exitCode).pipe(
              Effect.map((result) => ({ _tag: "exit" as const, result })),
            ),
          );

          if (observed._tag === "ready" && Exit.isSuccess(observed.result)) {
            yield* Ref.set(endpoints, selected);
            return {
              health: Effect.void,
              exit: processExit(native.exitCode),
              stop: native.kill.pipe(Effect.mapError((cause) => serviceError("stop", cause))),
              remove: Ref.set(endpoints, new Map()),
            } satisfies RuntimeSession;
          }

          if (observed._tag === "ready") {
            const bindReady = yield* Deferred.isDone(output.bindReady);
            const [stdoutLines, stderrLines] = yield* Effect.all([
              Ref.get(output.stdout),
              Ref.get(output.stderr),
            ]);
            const failure = serviceError(
              "health",
              withRecentOutput(
                bindReady
                  ? `${context.config.service} HTTP readiness timed out`
                  : `${context.config.service} native listener bind was not confirmed`,
                { stdout: stdoutLines, stderr: stderrLines },
              ),
            );
            yield* Ref.set(endpoints, selected);
            return {
              health: Effect.fail(failure),
              exit: processExit(native.exitCode),
              stop: native.kill.pipe(Effect.mapError((cause) => serviceError("stop", cause))),
              remove: Ref.set(endpoints, new Map()),
            } satisfies RuntimeSession;
          }

          if (Exit.isFailure(observed.result)) yield* Scope.close(attemptScope, Exit.void);
          else yield* Deferred.await(output.drained);
          const [stdoutLines, stderrLines] = yield* Effect.all([
            Ref.get(output.stdout),
            Ref.get(output.stderr),
          ]);
          const exitMessage = Exit.isSuccess(observed.result)
            ? `${context.config.service} startup exited with ${observed.result.value}`
            : `${context.config.service} startup process failed: ${Cause.pretty(observed.result.cause)}`;
          const failure = serviceError(
            "launch",
            withRecentOutput(exitMessage, { stdout: stdoutLines, stderr: stderrLines }),
          );
          const collision = yield* Ref.get(output.bindError);
          const nonzeroExit = Exit.isSuccess(observed.result) && observed.result.value !== 0;
          if (Exit.isSuccess(observed.result)) yield* Scope.close(attemptScope, Exit.void);
          yield* Ref.set(endpoints, new Map());
          if (collision && nonzeroExit) {
            const collisionFailure = serviceError(
              "native-port-collision",
              `${context.config.service} native port collision\n${failure.message}`,
            );
            yield* Ref.set(lastCollision, collisionFailure);
            return yield* collisionFailure;
          }
          return terminalSession(failure, endpoints);
        });

        if (spec.nativeReadinessOutput !== undefined) {
          const collisionRetries = Schedule.recurs(2).pipe(
            Schedule.setInputType<ServiceError | ServiceLaunchError>(),
            Schedule.while(
              ({ input }) =>
                input instanceof ServiceError && input.operation === "native-port-collision",
            ),
          );
          return yield* launchAttempt().pipe(
            Effect.retry(collisionRetries),
            Effect.catchIf(
              (error) =>
                error instanceof ServiceError && error.operation === "native-port-collision",
              (collision) =>
                Effect.succeed(
                  terminalSession(serviceError("launch", collision.message), endpoints),
                ),
            ),
          );
        }
        return yield* launchAttempt();
      }
      const desired = new Map<string, ServiceEndpoint>();
      for (const [name, port] of portNames)
        desired.set(name, { kind: "tcp", host: "127.0.0.1", port });
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
        const result = yield* awaitStartup(context.config.service, startupProcess, logs);
        yield* startupProcess.remove.pipe(
          Effect.mapError((cause) => serviceError("launch", cause)),
        );
        if (result.code !== 0) return yield* startupFailure(context.config.service, result);
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
