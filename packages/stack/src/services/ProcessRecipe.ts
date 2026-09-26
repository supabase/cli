import {
  Cause,
  Clock,
  Crypto,
  Data,
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
import { accepts } from "../Ports.ts";
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
import {
  mapToServiceError,
  processExit as sharedProcessExit,
  publishProcessLogs,
  runtimeSessionFromContainer,
} from "../runtime/Session.ts";
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

const serviceError = mapToServiceError;

const describeProcessExit = (code: number) => `Process exited with ${code}`;

const catalogError = (operation: string, message: string, service?: ServiceKind, cause?: unknown) =>
  new CatalogError({
    operation,
    message,
    ...(service === undefined ? {} : { service }),
    ...(cause === undefined ? {} : { cause }),
  });

const processExit = (
  exitCode: Effect.Effect<number, { readonly message: string }>,
): Effect.Effect<Exit.Exit<void, ServiceError>> => sharedProcessExit(exitCode, describeProcessExit);

const runtimeFromContainer = (process: ContainerProcess): RuntimeSession =>
  runtimeSessionFromContainer(process, describeProcessExit);

const runtimeFromNative = (process: NativeProcess): RuntimeSession => ({
  health: Effect.void,
  exit: processExit(process.exitCode),
  stop: process.kill.pipe(Effect.mapError((cause) => serviceError("stop", cause))),
  remove: Effect.void,
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

const startupTimeoutSeconds = 60;
const nativeLaunchAttempts = 3;
const probeTimeout = Duration.seconds(10);
const outputDrainGrace = Duration.seconds(2);
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

class NativePortCollision extends Data.TaggedError("NativePortCollision")<{
  readonly failure: ServiceError;
}> {}

/** Another process accepting on a port the exited attempt was given means that attempt lost the bind. */
const anotherListenerHolds = (endpoints: ReadonlyMap<string, ServiceEndpoint>) =>
  Effect.forEach(
    [...endpoints.values()].filter((endpoint) => endpoint.kind === "tcp"),
    (endpoint) => accepts(endpoint.host ?? "127.0.0.1", endpoint.port),
    { concurrency: "unbounded" },
  ).pipe(Effect.map((accepted) => accepted.some(Boolean)));

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
        if (spec.startup.length > 0) {
          const startupScope = yield* Scope.fork(context.scope, "sequential");
          const reservation =
            spec.nativeStartupEnv === undefined
              ? undefined
              : yield* reserveEndpoints(context.scope);
          const startupEndpoints =
            reservation?.endpoints ??
            new Map(
              portNames.map(([name]) => [
                name,
                { kind: "tcp" as const, host: "127.0.0.1", port: 0 },
              ]),
            );
          for (const [index, process] of spec.startup.entries()) {
            const startupProcess = yield* spawnNativeProcess(
              {
                executable: `${artifactRoot}/bin/${process.nativeExecutable ?? "prepare"}`,
                args: process.args,
                env: yield* (spec.nativeStartupEnv ?? spec.env)(
                  context.config,
                  startupEndpoints,
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
            const result = yield* awaitStartup(context.config.service, startupProcess, logs).pipe(
              Effect.mapError(
                (failure) =>
                  new ServiceLaunchError({ failure, runtime: runtimeFromNative(startupProcess) }),
              ),
            );
            if (result.code !== 0)
              return yield* new ServiceLaunchError({
                failure: startupFailure(context.config.service, result),
                runtime: runtimeFromNative(startupProcess),
              });
          }
          yield* Scope.close(startupScope, Exit.void);
          reusableReservation = reservation;
        }

        const deadline = (yield* Clock.currentTimeMillis) + startupTimeoutSeconds * 1_000;
        const spawnAttempt = Effect.fn("ProcessRecipe.spawnNativeAttempt")(function* (held?: {
          readonly portScope: Scope.Closeable;
          readonly endpoints: ReadonlyMap<string, ServiceEndpoint>;
        }) {
          const scope = yield* Scope.fork(context.scope, "sequential");
          const reservation = held ?? (yield* reserveEndpoints(scope));
          const selected = reservation.endpoints;
          const args = yield* spec.args(context.config, selected, {
            container: false,
            artifactRoot,
          });
          const env = yield* spec.env(context.config, selected, false);
          yield* Scope.close(reservation.portScope, Exit.void);
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
            Scope.provide(scope),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, deps.spawner),
            Effect.mapError((cause) => serviceError("launch", cause)),
          );
          const output = yield* collectNativeOutput(
            native,
            logs,
            selected,
            spec.nativeReadinessOutput,
            scope,
          );
          yield* Ref.set(endpoints, selected);
          return { native, output, selected, scope };
        });
        type NativeAttempt = Effect.Success<ReturnType<typeof spawnAttempt>>;

        const readyCondition = (attempt: NativeAttempt, timeout: Duration.Input) => {
          const http = attempt.selected.get("http");
          if (http === undefined)
            return Effect.fail(serviceError("health", "Recipe has no HTTP readiness endpoint"));
          return Effect.all(
            [
              readiness(deps.client, http, spec.healthPath, timeout),
              spec.nativeReadinessOutput === undefined
                ? Effect.void
                : Deferred.await(attempt.output.bindReady),
            ],
            { concurrency: "unbounded", discard: true },
          ).pipe(
            Effect.timeout(timeout),
            Effect.mapError((cause) => serviceError("health", cause)),
          );
        };
        const recentOutput = (attempt: NativeAttempt) =>
          Effect.all({
            stdout: Ref.get(attempt.output.stdout),
            stderr: Ref.get(attempt.output.stderr),
          });

        const firstAttempt = yield* spawnAttempt(reusableReservation);
        const live = yield* Ref.make(firstAttempt);
        const unobserved = yield* Ref.make<NativeAttempt | undefined>(firstAttempt);
        const settled = yield* Deferred.make<Exit.Exit<void, ServiceError>>();
        const settleOnExit = (attempt: NativeAttempt) =>
          Effect.forkIn(
            processExit(attempt.native.exitCode).pipe(
              Effect.flatMap((exit) => Deferred.succeed(settled, exit)),
            ),
            context.scope,
          );
        const settleFailure = (failure: ServiceError) =>
          Deferred.succeed(settled, Exit.fail(failure)).pipe(Effect.andThen(Effect.fail(failure)));

        const nextAttempt = Ref.getAndSet(unobserved, undefined).pipe(
          Effect.flatMap((attempt) =>
            attempt !== undefined
              ? Effect.succeed(attempt)
              : spawnAttempt().pipe(
                  Effect.tap((relaunched) => Ref.set(live, relaunched)),
                  Effect.catch(settleFailure),
                ),
          ),
        );

        const observeAttempt = Effect.fn("ProcessRecipe.observeNativeAttempt")(function* (
          attempt: NativeAttempt,
        ) {
          const timeLeft = Math.max(0, deadline - (yield* Clock.currentTimeMillis));
          const observed = yield* Effect.race(
            Effect.exit(readyCondition(attempt, Duration.millis(timeLeft))).pipe(
              Effect.map((result) => ({ _tag: "ready" as const, result })),
            ),
            Effect.exit(attempt.native.exitCode).pipe(
              Effect.map((result) => ({ _tag: "exit" as const, result })),
            ),
          );

          if (observed._tag === "ready") {
            yield* settleOnExit(attempt);
            if (Exit.isSuccess(observed.result)) return;
            const error = Option.getOrUndefined(Cause.findErrorOption(observed.result.cause));
            if (error !== undefined && !Cause.isTimeoutError(error.cause)) return yield* error;
            const bindConfirmed =
              spec.nativeReadinessOutput === undefined ||
              (yield* Deferred.isDone(attempt.output.bindReady));
            return yield* serviceError(
              "health",
              withRecentOutput(
                bindConfirmed
                  ? `${context.config.service} HTTP readiness timed out`
                  : `${context.config.service} native listener bind was not confirmed`,
                yield* recentOutput(attempt),
              ),
            );
          }

          // A detached descendant can hold the output pipes open after the process exits.
          if (Exit.isSuccess(observed.result))
            yield* Deferred.await(attempt.output.drained).pipe(
              Effect.timeoutOption(outputDrainGrace),
            );
          yield* Scope.close(attempt.scope, Exit.void);
          yield* Ref.set(endpoints, new Map());
          const exitMessage = Exit.isSuccess(observed.result)
            ? `${context.config.service} exited with ${observed.result.value} before it was ready`
            : `${context.config.service} process failed: ${Cause.pretty(observed.result.cause)}`;
          const failure = serviceError(
            "launch",
            withRecentOutput(exitMessage, yield* recentOutput(attempt)),
          );
          const collided =
            Exit.isSuccess(observed.result) &&
            observed.result.value !== 0 &&
            ((yield* Ref.get(attempt.output.bindError)) ||
              (!(yield* Deferred.isDone(attempt.output.bindReady)) &&
                (yield* anotherListenerHolds(attempt.selected))));
          if (!collided) return yield* settleFailure(failure);
          return yield* new NativePortCollision({
            failure: serviceError(
              "launch",
              `${context.config.service} native port collision\n${failure.message}`,
            ),
          });
        });

        // An attempt that loses a port bind before it is ready relaunches on fresh ports.
        const supervise = nextAttempt.pipe(
          Effect.flatMap(observeAttempt),
          Effect.retry({
            times: nativeLaunchAttempts - 1,
            while: (error) =>
              error._tag === "NativePortCollision"
                ? Clock.currentTimeMillis.pipe(Effect.map((now) => now < deadline))
                : Effect.succeed(false),
          }),
          Effect.catchTag("NativePortCollision", ({ failure }) => settleFailure(failure)),
        );

        return {
          health: supervise,
          probe: Ref.get(live).pipe(
            Effect.flatMap((attempt) => readyCondition(attempt, probeTimeout)),
          ),
          exit: Deferred.await(settled),
          stop: Ref.get(live).pipe(
            Effect.flatMap((attempt) => attempt.native.kill),
            Effect.mapError((cause) => serviceError("stop", cause)),
          ),
          remove: Ref.set(endpoints, new Map()),
        } satisfies RuntimeSession;
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
        const result = yield* awaitStartup(context.config.service, startupProcess, logs).pipe(
          Effect.mapError(
            (failure) =>
              new ServiceLaunchError({
                failure,
                runtime: runtimeFromContainer(startupProcess),
              }),
          ),
        );
        yield* startupProcess.remove.pipe(
          Effect.mapError(
            (cause) =>
              new ServiceLaunchError({
                failure: serviceError("launch", cause),
                runtime: runtimeFromContainer(startupProcess),
              }),
          ),
        );
        if (result.code !== 0)
          return yield* new ServiceLaunchError({
            failure: startupFailure(context.config.service, result),
            runtime: runtimeFromContainer(startupProcess),
          });
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
          return yield* new ServiceLaunchError({
            failure: serviceError("launch", `Container did not publish ${name}`),
            runtime: runtimeFromContainer(launched),
          });
        selected.set(name, { kind: "tcp", host: "127.0.0.1", port: published });
      }
      yield* Ref.set(endpoints, selected);
      yield* publishProcessLogs(launched, logs, context.scope);
      const runtime = runtimeFromContainer(launched);
      const ready = selected.get("http");
      const noReadinessEndpoint = Effect.fail(
        serviceError("health", "Recipe has no HTTP readiness endpoint"),
      );
      return {
        ...runtime,
        health:
          ready === undefined
            ? noReadinessEndpoint
            : readiness(deps.client, ready, spec.healthPath),
        probe:
          ready === undefined
            ? noReadinessEndpoint
            : readiness(deps.client, ready, spec.healthPath, probeTimeout),
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
