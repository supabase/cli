import { withAttemptCount } from "../internal/attempts.ts";
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
import { ChildProcessSpawner } from "effect/process";
import type { ChildProcessSpawner as ChildProcessSpawnerService } from "effect/process/ChildProcessSpawner";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
  prepareNativeArtifact,
  resolveArtifact,
  useNativeArtifact,
  type ServiceKind,
} from "../Artifacts.ts";
import * as Environment from "../namespace/Environment.ts";
import { containerInstancePath, destroyOwnedRoot, type BorrowedPath } from "../namespace/Paths.ts";
import { accepts, reserveNativePort } from "../Ports.ts";
import {
  type ContainerError,
  type ContainerProcess,
  type ContainerRuntime,
} from "../runtime/Container.ts";
import { awaitCommandOutput } from "../runtime/CommandOutput.ts";
import {
  defaultNativeProcessLauncher,
  type NativeProcess,
  type NativeProcessError,
  spawnNativeProcess,
} from "../runtime/NativeProcess.ts";
import {
  launchOutputPublisher,
  mapToServiceError,
  processExit as sharedProcessExit,
  publishProcessLogs,
  runtimeSessionFromContainer,
  type LaunchOutput,
  type PublishOutput,
} from "../runtime/Session.ts";
import {
  ServiceError,
  ServiceLaunchError,
  type RuntimeSession,
  type ServiceLaunchContext,
} from "../Service.ts";
import {
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

/** `uid:gid` a container runs as when it writes into a borrowed host path, so the caller keeps ownership. */
const hostUser: string | undefined =
  process.getuid === undefined || process.getgid === undefined
    ? undefined
    : `${process.getuid()}:${process.getgid()}`;

/** The host-user override for a launch whose mounts write into one of its recipe's caller paths. */
const userForMounts = (
  mounts: ReadonlyArray<RecipeMount>,
  callerPaths: ReadonlyArray<string>,
): string | undefined =>
  hostUser !== undefined &&
  mounts.some((mount) => !mount.readOnly && callerPaths.includes(mount.source))
    ? hostUser
    : undefined;

export interface StartupCommand {
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
    /** The claimed instance directory: the host path natively, `/instance` in a container. */
    instanceDir?: string,
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
  readonly startupCommands: ReadonlyArray<StartupCommand>;
  readonly enabledPort?: (creation: C, name: string) => boolean;
  readonly containerPort?: (creation: C, name: string, port: number) => number;
  readonly containerEntrypoint?: (creation: C) => string | undefined;
  readonly prepare?: (creation: C) => Effect.Effect<void, ServiceError>;
  readonly removeData?: (creation: C) => Effect.Effect<void, ServiceError>;
  /** Claims an owned instance directory, mounted at `/instance` in containers. */
  readonly instanceDirectory?: boolean;
  /**
   * Every caller-supplied path this recipe reads or mounts, validated against the stack's data
   * root before `prepare` and launch run (see `namespace/Paths.borrow`).
   */
  readonly callerPaths?: (creation: C) => ReadonlyArray<string>;
}

export interface ResolvedStartupCommand {
  readonly args: ReadonlyArray<string>;
  readonly executable: string;
  readonly entrypoint?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly mounts: ReadonlyArray<RecipeMount>;
}

export const startupEndpointsFor = <C extends RecipeCreation<ServiceKind, unknown>>(
  creation: C,
  spec: ProcessRecipeSpec<C>,
  context: { readonly container: boolean },
): ReadonlyMap<string, ServiceEndpoint> =>
  new Map(
    Object.entries(spec.ports)
      .filter(([name]) => spec.enabledPort === undefined || spec.enabledPort(creation, name))
      .map(([name, port]) => [
        name,
        {
          kind: "tcp" as const,
          host: "127.0.0.1" as const,
          port: context.container ? (spec.containerPort?.(creation, name, port) ?? port) : 0,
        },
      ]),
  );

export const resolveStartupCommand = <C extends RecipeCreation<ServiceKind, unknown>>(
  creation: C,
  spec: ProcessRecipeSpec<C>,
  command: StartupCommand,
  endpoints: ReadonlyMap<string, ServiceEndpoint>,
  context: { readonly container: boolean },
): Effect.Effect<ResolvedStartupCommand, ServiceError> =>
  Effect.gen(function* () {
    return {
      args: command.args,
      executable: command.nativeExecutable ?? "prepare",
      ...(command.containerEntrypoint === undefined
        ? {}
        : { entrypoint: command.containerEntrypoint }),
      env: yield* context.container
        ? spec.env(creation, endpoints, true)
        : (spec.nativeStartupEnv ?? spec.env)(creation, endpoints, false),
      mounts: yield* spec.mounts(creation, { container: context.container }),
    };
  });

export interface ProcessDependencies {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly crypto: Crypto.Crypto;
  readonly client: HttpClient.HttpClient;
  readonly spawner: ChildProcessSpawnerService["Service"];
  readonly container: ContainerRuntime | undefined;
  /** Validates a caller-supplied path against the stack's data root; see `namespace/Paths.borrow`. */
  readonly borrowCallerPath: (candidate: string) => Effect.Effect<BorrowedPath, ServiceError>;
}

const serviceError = mapToServiceError;

const describeProcessExit = (code: number) => `Process exited with ${code}`;

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

const emptyNativePortSet: ReadonlySet<number> = new Set();

const startupTimeoutSeconds = 60;
const nativeLaunchAttempts = 3;
const probeTimeout = Duration.seconds(10);
/**
 * Bounds one readiness HTTP call: a request that connects but never answers is retried instead
 * of spending the whole check on that one attempt.
 */
const readinessAttemptTimeout = Duration.seconds(3);
const outputDrainGrace = Duration.seconds(2);
const startupOutputTailLines = 20;
const startupOutputLineChars = 1_000;

type StartupOutput = Readonly<Record<LaunchOutput["stream"], ReadonlyArray<string>>>;

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
    publish: PublishOutput,
  ): Effect.Effect<
    Readonly<{ readonly code: number; readonly output: StartupOutput }>,
    ServiceError
  > =>
    awaitCommandOutput(process, {
      timeout: Duration.seconds(startupTimeoutSeconds),
      onOutput: publish,
    }).pipe(
      Effect.mapError((cause) => serviceError("launch", cause)),
      Effect.flatMap((result) =>
        result.timedOut
          ? serviceError(
              "launch",
              withRecentOutput(
                `${service} startup timed out after ${startupTimeoutSeconds} seconds`,
                result.output,
              ),
            )
          : Effect.succeed({ code: result.exitCode, output: result.output }),
      ),
    ),
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
  publish: PublishOutput,
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
    name: LaunchOutput["stream"],
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
      Stream.tap((bytes) => publish(name, bytes)),
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

const readiness = Effect.fn("ProcessRecipe.readiness")(function* (
  client: HttpClient.HttpClient,
  endpoint: ServiceEndpoint,
  path: string,
  timeout: Duration.Input = "60 seconds",
) {
  const attempt = client
    .execute(HttpClientRequest.get(`http://127.0.0.1:${endpoint.port}${path}`))
    .pipe(
      Effect.flatMap((response) =>
        (response.status >= 200 && response.status < 300) || response.status === 401
          ? Effect.void
          : Effect.fail(
              new ServiceError({ operation: "health", message: `HTTP ${response.status}` }),
            ),
      ),
      Effect.timeout(readinessAttemptTimeout),
    );
  return yield* withAttemptCount(attempt, (counted) =>
    counted.pipe(
      Effect.retry({ schedule: Schedule.spaced("250 millis") }),
      Effect.timeout(timeout),
      Effect.mapError((cause) => serviceError("health", cause)),
      Effect.asVoid,
    ),
  );
});

export const makeProcessRecipe = <C extends RecipeCreation<ServiceKind, unknown>>(
  options: CatalogOptions,
  deps: ProcessDependencies,
  spec: ProcessRecipeSpec<C>,
): Effect.Effect<ProcessRecipeResult<C>> =>
  Effect.gen(function* () {
    const endpoints = yield* Ref.make<ReadonlyMap<string, ServiceEndpoint>>(new Map());
    const logs = yield* PubSub.sliding<LaunchOutput>(256);
    // Ownership is by location: instanceRoot is owned simply by being under options.root, created
    // on demand by whatever first writes under it (no separate marker to establish or verify).
    const instanceRoot = deps.path.join(options.root, options.instanceId);
    const nativeInstanceDir = spec.instanceDirectory === true ? instanceRoot : undefined;
    const containerInstanceDir =
      spec.instanceDirectory === true ? containerInstancePath : undefined;
    // A dedicated, fully namespace-owned subdirectory for native confinement, so it never mixes
    // with the recipe's own owned files.
    const environmentRoot = deps.path.join(instanceRoot, ".supabase-environment");

    const prepare = Effect.fn("ProcessRecipe.prepare")(function* (candidate: C) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(options.instanceId))
        return yield* serviceError("identity", "Instance id is not a safe path segment");
      if (spec.instanceDirectory === true)
        yield* deps.fs
          .makeDirectory(instanceRoot, { recursive: true, mode: 0o700 })
          .pipe(Effect.mapError((cause) => serviceError("prepare", cause)));
      if (spec.callerPaths !== undefined)
        for (const candidatePath of spec.callerPaths(candidate))
          yield* deps.borrowCallerPath(candidatePath);
      if (spec.prepare !== undefined) yield* spec.prepare(candidate);
      const resolved = yield* resolveArtifact({
        service: candidate.service,
        version: candidate.version,
      }).pipe(Effect.mapError((cause) => serviceError("prepare", cause)));
      if (options.runtime === "native") {
        // Ahead-of-time warm-up only: downloads and publishes the generation but pins nothing.
        // `launch` resolves (or prepares) and pins its own copy right before it spawns.
        yield* prepareNativeArtifact(
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
      } else {
        if (deps.container === undefined)
          return yield* serviceError("prepare", "Container runtime unavailable");
        yield* deps.container
          .prepare(resolved.image)
          .pipe(Effect.mapError((cause) => serviceError("prepare", cause)));
      }
    });

    const launch = Effect.fn("ProcessRecipe.launch")(function* (context: ServiceLaunchContext<C>) {
      const output = yield* launchOutputPublisher(logs, context.launchId);
      const portNames = Object.entries(spec.ports).filter(
        ([name]) => spec.enabledPort === undefined || spec.enabledPort(context.config, name),
      );
      if (options.runtime === "native") {
        // `context.scope` finalizes its direct children in parallel (it is forked "parallel" in
        // Service.ts), so registering the pin there directly would race its release against the
        // spawned processes' own cleanup. A "sequential" child scope finalizes LIFO instead: the
        // pin is registered on it first, every native process scope below forks from it (not from
        // `context.scope`), so closing it always runs their cleanup before releasing the pin.
        const launchScope = yield* Scope.fork(context.scope, "sequential");
        const artifact = yield* useNativeArtifact(
          { service: context.config.service, version: context.config.version },
          options.cacheRoot,
          options.platform,
        ).pipe(
          Scope.provide(launchScope),
          Effect.provideService(FileSystem.FileSystem, deps.fs),
          Effect.provideService(Path.Path, deps.path),
          Effect.provideService(Crypto.Crypto, deps.crypto),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, deps.spawner),
          Effect.provideService(HttpClient.HttpClient, deps.client),
          Effect.mapError((cause) => serviceError("launch", cause)),
        );
        const executable = artifact.executable;
        const artifactRoot = artifact.root;
        const environment = yield* Environment.confine(deps.fs, deps.path, environmentRoot).pipe(
          Effect.mapError((cause) => serviceError("launch", cause)),
        );
        const keyFor = (name: string) => `${options.instanceId}:${context.id}:${name}`;
        // A port a prior attempt lost stays excluded so a retry advances instead of repeating it.
        const excludedByKey = yield* Ref.make<ReadonlyMap<string, ReadonlySet<number>>>(new Map());
        const reserveEndpoints = Effect.fn("ProcessRecipe.reserveEndpoints")(function* (
          parent: Scope.Closeable,
        ) {
          const portScope = yield* Scope.fork(parent, "sequential");
          const excluded = yield* Ref.get(excludedByKey);
          const reservations = yield* Effect.forEach(
            portNames,
            ([name]) =>
              reserveNativePort(keyFor(name), excluded.get(keyFor(name)) ?? emptyNativePortSet),
            { concurrency: 1 },
          ).pipe(
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
        if (spec.startupCommands.length > 0) {
          const startupScope = yield* Scope.fork(launchScope, "sequential");
          const reservation =
            spec.nativeStartupEnv === undefined
              ? undefined
              : yield* reserveEndpoints(context.scope);
          const startupEndpoints =
            reservation?.endpoints ??
            startupEndpointsFor(context.config, spec, { container: false });
          for (const [index, process] of spec.startupCommands.entries()) {
            const command = yield* resolveStartupCommand(
              context.config,
              spec,
              process,
              startupEndpoints,
              { container: false },
            );
            const startupProcess = yield* spawnNativeProcess(
              {
                executable: `${artifactRoot}/bin/${command.executable}`,
                args: command.args,
                env: command.env,
                environment,
                cwd: artifactRoot,
                artifactLockPath: artifact.lockPath,
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
            const result = yield* awaitStartup(
              context.config.service,
              startupProcess,
              yield* output.part,
            ).pipe(
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
          const scope = yield* Scope.fork(launchScope, "sequential");
          const reservation = held ?? (yield* reserveEndpoints(scope));
          const selected = reservation.endpoints;
          const args = yield* spec.args(context.config, selected, {
            container: false,
            artifactRoot,
          });
          const env = yield* spec.env(context.config, selected, false, nativeInstanceDir);
          yield* Scope.close(reservation.portScope, Exit.void);
          const native: NativeProcess = yield* spawnNativeProcess(
            {
              executable,
              args,
              env,
              environment,
              artifactLockPath: artifact.lockPath,
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
          const collected = yield* collectNativeOutput(
            native,
            yield* output.part,
            selected,
            spec.nativeReadinessOutput,
            scope,
          );
          yield* Ref.set(endpoints, selected);
          return { native, output: collected, selected, scope };
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
          yield* Ref.update(excludedByKey, (current) => {
            const next = new Map(current);
            for (const [name, endpoint] of attempt.selected) {
              if (endpoint.kind !== "tcp") continue;
              const key = keyFor(name);
              next.set(key, new Set([...(next.get(key) ?? []), endpoint.port]));
            }
            return next;
          });
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
      if (deps.container === undefined)
        return yield* serviceError("launch", "Container runtime unavailable");
      const resolved = yield* resolveArtifact({
        service: context.config.service,
        version: context.config.version,
      }).pipe(Effect.mapError((cause) => serviceError("launch", cause)));
      const containerDesired = startupEndpointsFor(context.config, spec, { container: true });
      for (const process of spec.startupCommands) {
        if (process.skipInContainer === true) continue;
        const command = yield* resolveStartupCommand(
          context.config,
          spec,
          process,
          containerDesired,
          { container: true },
        );
        const startupProcess = yield* deps.container
          .launchCommand({
            image: resolved.image,
            stackId: options.stackId,
            instanceId: options.instanceId,
            service: spec.service,
            project: options.project,
            env: command.env,
            entrypoint: command.entrypoint,
            args: command.args,
            mounts: command.mounts,
            user: userForMounts(command.mounts, spec.callerPaths?.(context.config) ?? []),
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
        const result = yield* awaitStartup(
          context.config.service,
          startupProcess,
          yield* output.part,
        ).pipe(
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
      const launchMounts = [
        ...(yield* spec.mounts(context.config, { container: true })),
        ...(spec.instanceDirectory === true
          ? [{ source: instanceRoot, target: containerInstancePath, readOnly: false }]
          : []),
      ];
      const launched = yield* deps.container
        .launch({
          image: resolved.image,
          stackId: options.stackId,
          instanceId: options.instanceId,
          service: spec.service,
          project: options.project,
          env: yield* spec.env(context.config, containerDesired, true, containerInstanceDir),
          entrypoint: spec.containerEntrypoint?.(context.config),
          args: yield* spec.args(context.config, containerDesired, { container: true }),
          mounts: launchMounts,
          user: userForMounts(launchMounts, spec.callerPaths?.(context.config) ?? []),
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
      yield* publishProcessLogs(launched, yield* output.part, context.scope);
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
        // instanceRoot (environmentRoot's parent, and the recipe's own owned files) is removed as
        // one recursive delete; a recipe with nothing on the host filesystem simply finds it absent.
        removeData: (context) =>
          destroyOwnedRoot(
            deps.fs,
            deps.path,
            instanceRoot,
            options.root,
            spec.removeData?.(context.config) ?? Effect.void,
            serviceError,
          ).pipe(Effect.andThen(Ref.set(endpoints, new Map()))),
      },
      endpoints,
      logs: PubSub.subscribe(logs),
    };
  });
