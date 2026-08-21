import {
  Cause,
  Data,
  Duration,
  Effect,
  Exit,
  Layer,
  Queue,
  Schedule,
  Context,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { BinaryResolver } from "./BinaryResolver.ts";
import type { ChecksumMismatchError } from "./errors.ts";
import { DockerPullError, isDockerDaemonDownMessage } from "./errors.ts";
import { isDockerOnlyService } from "./ServiceCatalog.ts";
import {
  DEFAULT_VERSIONS,
  SERVICE_NAMES,
  dockerImageCandidatesForService,
  type ServiceName,
  type VersionManifest,
} from "./versions.ts";

export interface PreparedStackArtifacts {
  readonly resolutions: Partial<Record<ServiceName, ServiceResolution>>;
}

export type ServiceResolution =
  | { readonly type: "binary"; readonly path: string }
  | { readonly type: "docker"; readonly image: string };

export interface StackPreparationInput {
  readonly versions?: Partial<VersionManifest>;
  readonly services?: ReadonlyArray<ServiceName>;
  readonly mode?: "native" | "auto" | "docker";
}

export class ServiceDownloadStarted extends Data.TaggedClass("ServiceDownloadStarted")<{
  readonly service: ServiceName;
}> {}

export class ServiceDownloadFinished extends Data.TaggedClass("ServiceDownloadFinished")<{
  readonly service: ServiceName;
}> {}

class PreparationCompleted extends Data.TaggedClass("PreparationCompleted")<{
  readonly artifacts: PreparedStackArtifacts;
}> {}

class RetryablePullFailure extends Data.TaggedError("RetryablePullFailure")<{
  readonly image: string;
  readonly attempt: number;
  readonly message: string;
}> {}

type StackPreparationEvent =
  | ServiceDownloadStarted
  | ServiceDownloadFinished
  | PreparationCompleted;

const DOCKER_PULL_RETRY_DELAYS_MS = [500] as const;
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

interface PullAttemptFailure {
  readonly image: string;
  readonly attempt: number;
  readonly message: string;
}

const resolveDockerImageForService = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  service: ServiceName,
  version: string,
  callbacks?: {
    readonly onDownloadStart?: Effect.Effect<void>;
  },
): Effect.Effect<string, DockerPullError> =>
  pullImage(spawner, dockerImageCandidatesForService(service, version), callbacks);

export const prepareAssetsWithDependencies = (
  resolver: BinaryResolver["Service"],
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  input?: StackPreparationInput,
  publishEvent?: (event: StackPreparationEvent) => Effect.Effect<void>,
): Effect.Effect<PreparedStackArtifacts, DockerPullError | ChecksumMismatchError> =>
  Effect.gen(function* () {
    const versions = { ...DEFAULT_VERSIONS, ...input?.versions };
    const services: ReadonlyArray<ServiceName> = input?.services ?? SERVICE_NAMES;
    const mode = input?.mode ?? "auto";

    type Entry = readonly [ServiceName, ServiceResolution];

    const resolveService = (
      service: ServiceName,
    ): Effect.Effect<Entry, DockerPullError | ChecksumMismatchError> => {
      let isDownloading = false;
      const markDownloadStart = () =>
        Effect.sync(() => {
          isDownloading = true;
        }).pipe(
          Effect.andThen(publishEvent?.(new ServiceDownloadStarted({ service })) ?? Effect.void),
        );
      const markDownloadFinished = () =>
        Effect.suspend(() =>
          isDownloading
            ? (publishEvent?.(new ServiceDownloadFinished({ service })) ?? Effect.void)
            : Effect.void,
        );

      if (mode === "docker") {
        return resolveDockerImageForService(spawner, service, versions[service], {
          onDownloadStart: markDownloadStart(),
        }).pipe(
          Effect.map((image): Entry => [service, { type: "docker", image }]),
          Effect.ensuring(markDownloadFinished()),
        );
      }

      if (isDockerOnlyService(service)) {
        return resolveDockerImageForService(spawner, service, versions[service], {
          onDownloadStart: markDownloadStart(),
        }).pipe(
          Effect.map((image): Entry => [service, { type: "docker", image }]),
          Effect.ensuring(markDownloadFinished()),
        );
      }

      return resolveServiceWithMetadata(
        resolver,
        spawner,
        service,
        versions[service],
        markDownloadStart(),
      ).pipe(
        Effect.map((resolution): Entry => [service, resolution]),
        Effect.ensuring(markDownloadFinished()),
      );
    };

    const results = yield* Effect.all(services.map(resolveService), { concurrency: 4 });

    const resolutions: Partial<Record<ServiceName, ServiceResolution>> = {};
    for (const [service, resolution] of results) {
      resolutions[service] = resolution;
    }
    const artifacts = { resolutions } satisfies PreparedStackArtifacts;
    yield* publishEvent?.(new PreparationCompleted({ artifacts })) ?? Effect.void;
    return artifacts;
  });

export class StackPreparation extends Context.Service<
  StackPreparation,
  {
    readonly prepare: (
      input?: StackPreparationInput,
    ) => Effect.Effect<PreparedStackArtifacts, DockerPullError | ChecksumMismatchError>;
    readonly prepareEvents: (
      input?: StackPreparationInput,
    ) => Stream.Stream<StackPreparationEvent, DockerPullError | ChecksumMismatchError>;
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

      return {
        prepare: (input?: StackPreparationInput) =>
          prepareAssetsWithDependencies(resolver, spawner, input),
        prepareEvents: (input?: StackPreparationInput) =>
          Stream.callback<StackPreparationEvent, DockerPullError | ChecksumMismatchError>((queue) =>
            prepareAssetsWithDependencies(resolver, spawner, input, (event) =>
              Queue.offer(queue, event),
            ).pipe(
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
  images: ReadonlyArray<string>,
  callbacks?: {
    readonly onDownloadStart?: Effect.Effect<void>;
  },
): Effect.Effect<string, DockerPullError> =>
  Effect.gen(function* () {
    const cachedImage = yield* findLocalDockerImage(spawner, images);
    if (cachedImage !== undefined) {
      return cachedImage;
    }

    yield* callbacks?.onDownloadStart ?? Effect.void;

    const failures: PullAttemptFailure[] = [];
    let spawnFailed = false;
    const retrySchedule = Schedule.recurs(DOCKER_PULL_RETRY_DELAYS_MS.length).pipe(
      Schedule.addDelay(() => Effect.succeed(Duration.millis(DOCKER_PULL_RETRY_DELAYS_MS[0] ?? 0))),
    );

    for (const image of images) {
      let attempt = 0;
      type PullAttemptOutcome =
        | { readonly ok: true; readonly image: string }
        | { readonly ok: false; readonly image: string };
      const attemptEffect: Effect.Effect<PullAttemptOutcome, RetryablePullFailure> = Effect.suspend(
        () => {
          attempt += 1;
          return Effect.exit(runPullCommand(spawner, image)).pipe(
            Effect.flatMap((result): Effect.Effect<PullAttemptOutcome, RetryablePullFailure> => {
              if (Exit.isSuccess(result)) {
                if (result.value.exitCode === 0) {
                  // A successful spawn proves the runtime is usable; an earlier
                  // transient spawn failure must not taint the final classification.
                  spawnFailed = false;
                  return Effect.succeed({ ok: true as const, image });
                }

                const message =
                  result.value.stderr.length > 0
                    ? result.value.stderr
                    : `docker pull exited with code ${result.value.exitCode}`;
                if (shouldRetryPull(message)) {
                  return Effect.fail(new RetryablePullFailure({ image, attempt, message }));
                }
                failures.push({ image, attempt, message });
                return Effect.succeed({ ok: false as const, image });
              }

              // A failed effect (rather than a non-zero exit) means the container
              // runtime could not be spawned at all — a local Docker setup
              // problem, not a registry failure.
              spawnFailed = true;
              const cause = Cause.squash(result.cause);
              const message = cause instanceof Error ? cause.message : String(cause);
              if (shouldRetryPull(message)) {
                return Effect.fail(new RetryablePullFailure({ image, attempt, message }));
              }
              failures.push({ image, attempt, message });
              return Effect.succeed({ ok: false as const, image });
            }),
          );
        },
      );
      const outcome = yield* attemptEffect.pipe(
        Effect.tapError((error: RetryablePullFailure) =>
          Effect.sync(() => {
            failures.push({ image: error.image, attempt: error.attempt, message: error.message });
          }),
        ),
        Effect.retry(retrySchedule),
        Effect.catchTag("RetryablePullFailure", () =>
          Effect.succeed({ ok: false as const, image }),
        ),
      );
      if (outcome.ok) {
        return image;
      }
    }

    const detail = failures
      .map((failure) => `${failure.image} attempt ${failure.attempt}: ${failure.message}`)
      .join("; ");

    return yield* Effect.fail(
      new DockerPullError({
        image: images[0] ?? "unknown",
        detail: `Failed to pull Docker image from all registries. ${detail}`,
        cause: new Error(detail),
        daemonDown:
          spawnFailed || failures.some((failure) => isDockerDaemonDownMessage(failure.message)),
      }),
    );
  });

const resolveServiceWithMetadata = (
  resolver: BinaryResolver["Service"],
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  service: ServiceName,
  version: string,
  onDownloadStart: Effect.Effect<void>,
): Effect.Effect<ServiceResolution, DockerPullError | ChecksumMismatchError> =>
  resolver.resolveWithMetadata({ service, version }, { onDownloadStart }).pipe(
    Effect.map(({ path }): ServiceResolution => ({ type: "binary", path })),
    Effect.catchTag("BinaryNotFoundError", () =>
      resolveDockerImageForService(spawner, service, version, {
        onDownloadStart,
      }).pipe(
        Effect.map((image): ServiceResolution => ({
          type: "docker",
          image,
        })),
      ),
    ),
    Effect.catchTag("DownloadError", () =>
      resolveDockerImageForService(spawner, service, version, {
        onDownloadStart,
      }).pipe(
        Effect.map((image): ServiceResolution => ({
          type: "docker",
          image,
        })),
      ),
    ),
  );

const runPullCommand = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  image: string,
): Effect.Effect<{ readonly exitCode: number; readonly stderr: string }, Error> =>
  Effect.gen(function* () {
    const child = yield* spawner.spawn(ChildProcess.make("docker", ["pull", image]));
    const [stderr, exitCode] = yield* Effect.all(
      [collectStreamAsString(child.stderr), child.exitCode.pipe(Effect.map(Number))],
      { concurrency: 2 },
    );
    return {
      exitCode,
      stderr: stderr.trim(),
    };
  }).pipe(
    Effect.scoped,
    Effect.catchTag("PlatformError", (error) => Effect.fail(new Error(String(error)))),
  );

const hasLocalDockerImage = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  image: string,
): Effect.Effect<boolean> =>
  spawner.exitCode(ChildProcess.make("docker", ["image", "inspect", image])).pipe(
    Effect.map((exitCode) => exitCode === 0),
    Effect.catchTag("PlatformError", () => Effect.succeed(false)),
  );

const findLocalDockerImage = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  images: ReadonlyArray<string>,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    for (const image of images) {
      if (yield* hasLocalDockerImage(spawner, image)) {
        return image;
      }
    }
    return undefined;
  });

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + new TextDecoder().decode(chunk),
  );

function shouldRetryPull(message: string): boolean {
  return RETRYABLE_PULL_PATTERNS.some((pattern) => pattern.test(message));
}
