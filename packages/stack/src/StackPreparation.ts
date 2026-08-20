import {
  Cause,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Queue,
  Schedule,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { BinaryResolver } from "./BinaryResolver.ts";
import type { ContainerRuntime } from "./ContainerRuntime.ts";
import type {
  BinaryHostCompatibilityError,
  BinaryManifestError,
  BinaryRuntimeError,
  ChecksumMismatchError,
  DownloadError,
} from "./errors.ts";
import { BinaryNotFoundError, DockerPullError, isDockerDaemonDownMessage } from "./errors.ts";
import { isDockerOnlyService, requiredPreparationDependencies } from "./ServiceCatalog.ts";
import {
  DEFAULT_VERSIONS,
  SERVICE_NAMES,
  dockerImageForService,
  type ServiceName,
  type VersionManifest,
} from "./versions.ts";

export interface PreparedStackArtifacts {
  readonly resolutions: Partial<Record<ServiceName, ServiceResolution>>;
}

export type PlannedStackArtifacts = PreparedStackArtifacts;

export type ServiceResolution =
  | { readonly type: "binary"; readonly path: string }
  | { readonly type: "docker"; readonly image: string };

interface StackPreparationOptions {
  readonly versions?: Partial<VersionManifest>;
  readonly services?: ReadonlyArray<ServiceName>;
  readonly enabledServices?: ReadonlyArray<ServiceName>;
}

export type StackPreparationInput = StackPreparationOptions &
  (
    | { readonly mode: "native"; readonly containerRuntime?: never }
    | { readonly mode: "docker"; readonly containerRuntime: ContainerRuntime }
  );

export type StackPreparationError =
  | BinaryNotFoundError
  | DownloadError
  | ChecksumMismatchError
  | BinaryManifestError
  | BinaryRuntimeError
  | BinaryHostCompatibilityError
  | DockerPullError;

export class ServiceDownloadStarted extends Data.TaggedClass("ServiceDownloadStarted")<{
  readonly service: ServiceName;
}> {}

export class ServiceDownloadFinished extends Data.TaggedClass("ServiceDownloadFinished")<{
  readonly service: ServiceName;
}> {}

export class PreparationCompleted extends Data.TaggedClass("PreparationCompleted")<{
  readonly artifacts: PreparedStackArtifacts;
}> {}

export type StackPreparationEvent =
  | ServiceDownloadStarted
  | ServiceDownloadFinished
  | PreparationCompleted;

const RETRYABLE_PULL_PATTERNS = [
  /toomanyrequests/i,
  /rate exceeded/i,
  /429\b/i,
  /timeout/i,
  /temporarily unavailable/i,
  /temporary failure/i,
  /connection reset/i,
  /tls handshake timeout/i,
  /i\/o timeout/i,
] as const;

class PullAttemptError extends Error {
  constructor(
    readonly detail: string,
    readonly daemonDown: boolean,
  ) {
    super(detail);
    this.name = "PullAttemptError";
  }
}

const pullRetrySchedule = Schedule.exponential(Duration.seconds(1)).pipe(
  Schedule.upTo({ times: 5 }),
);

const resolveDockerImageForService = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  runtime: ContainerRuntime,
  service: ServiceName,
  version: string,
  callbacks?: {
    readonly onDownloadStart?: Effect.Effect<void>;
  },
): Effect.Effect<string, DockerPullError> =>
  pullImage(spawner, runtime, dockerImageForService(service, version), callbacks);

export const preparationClosure = (
  services: ReadonlyArray<ServiceName>,
  enabledServices?: ReadonlyArray<ServiceName>,
): ReadonlyArray<ServiceName> => {
  const enabled = enabledServices === undefined ? undefined : new Set(enabledServices);
  const closure = new Set<ServiceName>();
  const add = (service: ServiceName): void => {
    if (enabled !== undefined && !enabled.has(service)) return;
    if (closure.has(service)) return;
    closure.add(service);
    for (const dependency of requiredPreparationDependencies(service)) add(dependency);
  };
  for (const service of services) add(service);
  return [...closure];
};

const selectedServices = (input: StackPreparationInput): ReadonlyArray<ServiceName> => {
  const defaults =
    input.mode === "docker"
      ? SERVICE_NAMES
      : SERVICE_NAMES.filter((service) => !isDockerOnlyService(service));
  return preparationClosure(input.services ?? defaults, input.enabledServices);
};

const plannedResolution = (
  resolver: BinaryResolver["Service"],
  service: ServiceName,
  version: string,
  mode: "native" | "docker",
): Effect.Effect<ServiceResolution, BinaryNotFoundError> => {
  if (mode === "docker") {
    return Effect.succeed({
      type: "docker",
      image: dockerImageForService(service, version),
    });
  }
  if (isDockerOnlyService(service)) {
    return Effect.fail(new BinaryNotFoundError({ service, platform: "native" }));
  }
  return resolver
    .plan({ service, version })
    .pipe(Effect.map((path): ServiceResolution => ({ type: "binary", path })));
};

const planAssetsWithDependencies = (
  resolver: BinaryResolver["Service"],
  input: StackPreparationInput,
): Effect.Effect<PlannedStackArtifacts, BinaryNotFoundError> =>
  Effect.gen(function* () {
    const versions = { ...DEFAULT_VERSIONS, ...input.versions };
    const services = selectedServices(input);
    const results = yield* Effect.all(
      services.map((service) =>
        plannedResolution(resolver, service, versions[service], input.mode).pipe(
          Effect.map((resolution) => [service, resolution] as const),
        ),
      ),
      { concurrency: "unbounded" },
    );
    return {
      resolutions: Object.fromEntries(results),
    } satisfies PlannedStackArtifacts;
  });

export class StackPreparation extends Context.Service<
  StackPreparation,
  {
    readonly plan: (
      input: StackPreparationInput,
    ) => Effect.Effect<PlannedStackArtifacts, BinaryNotFoundError>;
    readonly prepare: (
      input: StackPreparationInput,
    ) => Effect.Effect<PreparedStackArtifacts, StackPreparationError>;
    readonly prepareEvents: (
      input: StackPreparationInput,
    ) => Stream.Stream<StackPreparationEvent, StackPreparationError>;
  }
>()("stack/StackPreparation") {
  static layer: Layer.Layer<
    StackPreparation,
    never,
    BinaryResolver | ChildProcessSpawner.ChildProcessSpawner
  > = Layer.effect(
    this,
    Effect.gen(function* () {
      const resolver = yield* BinaryResolver;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const scope = yield* Effect.scope;
      const inFlight = new Map<
        string,
        Deferred.Deferred<ServiceResolution, StackPreparationError>
      >();

      const materialize = (
        service: ServiceName,
        resolution: ServiceResolution,
        input: StackPreparationInput,
        publishEvent?: (event: StackPreparationEvent) => Effect.Effect<void>,
      ): Effect.Effect<ServiceResolution, StackPreparationError> =>
        Effect.uninterruptibleMask((restore) =>
          Effect.suspend(() => {
            let downloadStarted = false;
            const markDownloadStart = () =>
              Effect.sync(() => {
                downloadStarted = true;
              }).pipe(
                Effect.andThen(
                  publishEvent?.(new ServiceDownloadStarted({ service })) ?? Effect.void,
                ),
              );
            const markDownloadFinished = () =>
              Effect.suspend(() =>
                downloadStarted
                  ? (publishEvent?.(new ServiceDownloadFinished({ service })) ?? Effect.void)
                  : Effect.void,
              );
            const key = JSON.stringify({
              service,
              resolution,
              containerRuntime: input.mode === "docker" ? input.containerRuntime : null,
            });
            const existing = inFlight.get(key);
            if (existing !== undefined) return restore(Deferred.await(existing));
            const deferred = Deferred.makeUnsafe<ServiceResolution, StackPreparationError>();
            inFlight.set(key, deferred);
            const version = input.versions?.[service] ?? DEFAULT_VERSIONS[service];
            const effect: Effect.Effect<ServiceResolution, StackPreparationError> =
              resolution.type === "docker"
                ? input.mode === "docker"
                  ? resolveDockerImageForService(
                      spawner,
                      input.containerRuntime,
                      service,
                      version,
                      {
                        onDownloadStart: markDownloadStart(),
                      },
                    ).pipe(Effect.map((image): ServiceResolution => ({ type: "docker", image })))
                  : Effect.die("Native preparation planned a Docker resolution")
                : resolver
                    .resolveWithMetadata(
                      { service, version },
                      {
                        onDownloadStart: markDownloadStart(),
                      },
                    )
                    .pipe(Effect.map(({ path }): ServiceResolution => ({ type: "binary", path })));
            const coordinated = effect.pipe(
              Effect.matchCauseEffect({
                onSuccess: (value) =>
                  Effect.andThen(markDownloadFinished(), Deferred.succeed(deferred, value)),
                onFailure: (cause) => Deferred.failCause(deferred, cause),
              }),
              Effect.ensuring(Effect.sync(() => inFlight.delete(key))),
            );
            return Effect.gen(function* () {
              yield* Effect.forkIn(coordinated, scope, { startImmediately: true });
              return yield* restore(Deferred.await(deferred));
            });
          }),
        );

      const prepareWithEvents = (
        input: StackPreparationInput,
        publishEvent?: (event: StackPreparationEvent) => Effect.Effect<void>,
      ): Effect.Effect<PreparedStackArtifacts, StackPreparationError> =>
        Effect.gen(function* () {
          const planned = yield* planAssetsWithDependencies(resolver, input);
          const entries = yield* Effect.all(
            selectedServices(input).map((service) => {
              const resolution = planned.resolutions[service];
              if (resolution === undefined) return Effect.die(`Missing plan for ${service}`);
              return materialize(service, resolution, input, publishEvent).pipe(
                Effect.map((resolved) => [service, resolved] as const),
              );
            }),
            { concurrency: "unbounded" },
          );
          const artifacts = {
            resolutions: Object.fromEntries(entries),
          } satisfies PreparedStackArtifacts;
          yield* publishEvent?.(new PreparationCompleted({ artifacts })) ?? Effect.void;
          return artifacts;
        });

      return {
        plan: (input: StackPreparationInput) => planAssetsWithDependencies(resolver, input),
        prepare: (input: StackPreparationInput) => prepareWithEvents(input),
        prepareEvents: (input: StackPreparationInput) =>
          Stream.callback<StackPreparationEvent, StackPreparationError>((queue) =>
            prepareWithEvents(input, (event) => Queue.offer(queue, event)).pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) => Queue.failCause(queue, cause),
                onSuccess: () => Queue.end(queue),
              }),
              Effect.forkScoped,
            ),
          ),
      };
    }),
  );
}

const pullImage = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  runtime: ContainerRuntime,
  image: string,
  callbacks?: {
    readonly onDownloadStart?: Effect.Effect<void>;
  },
): Effect.Effect<string, DockerPullError> =>
  Effect.gen(function* () {
    if (yield* hasLocalDockerImage(spawner, runtime, image)) {
      return image;
    }

    yield* callbacks?.onDownloadStart ?? Effect.void;

    const attempt = runPullCommand(spawner, runtime, image).pipe(
      Effect.retry({
        while: (error) => shouldRetryPull(error.detail),
        schedule: pullRetrySchedule,
      }),
    );
    const result = yield* Effect.exit(attempt);
    if (Exit.isSuccess(result)) return image;

    const failure = Cause.squash(result.cause);
    const detail = failure instanceof PullAttemptError ? failure.detail : String(failure);
    const daemonDown = failure instanceof PullAttemptError && failure.daemonDown;

    return yield* Effect.fail(
      new DockerPullError({
        image,
        detail: `Failed to pull canonical Docker image. ${detail}`,
        cause: new Error(detail),
        daemonDown,
      }),
    );
  });

const runPullCommand = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  runtime: ContainerRuntime,
  image: string,
): Effect.Effect<{ readonly exitCode: number; readonly stderr: string }, PullAttemptError> =>
  Effect.gen(function* () {
    const child = yield* spawner.spawn(ChildProcess.make(runtime, ["pull", image]));
    const [stderr, exitCode] = yield* Effect.all(
      [collectStreamAsString(child.stderr), child.exitCode.pipe(Effect.map(Number))],
      { concurrency: "unbounded" },
    );
    const result = {
      exitCode,
      stderr: stderr.trim(),
    };
    if (result.exitCode !== 0) {
      const detail =
        result.stderr.length > 0
          ? result.stderr
          : `${runtime} pull exited with code ${result.exitCode}`;
      return yield* Effect.fail(new PullAttemptError(detail, isDockerDaemonDownMessage(detail)));
    }
    return result;
  }).pipe(
    Effect.scoped,
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(new PullAttemptError(String(error), true)),
    ),
  );

const hasLocalDockerImage = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  runtime: ContainerRuntime,
  image: string,
): Effect.Effect<boolean> =>
  spawner.exitCode(ChildProcess.make(runtime, ["image", "inspect", image])).pipe(
    Effect.map((exitCode) => exitCode === 0),
    Effect.catchTag("PlatformError", () => Effect.succeed(false)),
  );

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + new TextDecoder().decode(chunk),
  );

function shouldRetryPull(message: string): boolean {
  return RETRYABLE_PULL_PATTERNS.some((pattern) => pattern.test(message));
}
