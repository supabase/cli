import { Cause, Data, Effect, Exit, Layer, Queue, Context, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { BinaryResolver } from "./BinaryResolver.ts";
import type { BinaryNotFoundError, ChecksumMismatchError, DownloadError } from "./errors.ts";
import { DockerPullError } from "./errors.ts";
import type { ServiceResolution } from "./resolve.ts";
import {
  DEFAULT_VERSIONS,
  SERVICE_NAMES,
  dockerImageCandidatesForService,
  dockerImageForService,
  type ServiceName,
  type VersionManifest,
} from "./versions.ts";

export interface PreparedStackArtifacts {
  readonly resolutions: Partial<Record<ServiceName, ServiceResolution>>;
}

export interface StackPreparationInput {
  readonly versions?: Partial<VersionManifest>;
  readonly services?: ReadonlyArray<ServiceName>;
  readonly mode?: "native" | "auto" | "docker";
}

/** `BinaryNotFoundError`/`DownloadError` surface only in `mode: "native"` (no Docker fallback there). */
export type StackPreparationError =
  | DockerPullError
  | ChecksumMismatchError
  | BinaryNotFoundError
  | DownloadError;

export class ServiceDownloadStarted extends Data.TaggedClass("ServiceDownloadStarted")<{
  readonly service: ServiceName;
}> {}

export class ServiceDownloadFinished extends Data.TaggedClass("ServiceDownloadFinished")<{
  readonly service: ServiceName;
}> {}

class PreparationCompleted extends Data.TaggedClass("PreparationCompleted")<{
  readonly artifacts: PreparedStackArtifacts;
}> {}

type StackPreparationEvent =
  | ServiceDownloadStarted
  | ServiceDownloadFinished
  | PreparationCompleted;

const dockerOnlyServices = new Set<ServiceName>([
  "edge-runtime",
  "realtime",
  "storage",
  "imgproxy",
  "mailpit",
  "pgmeta",
  "studio",
  "analytics",
  "vector",
  "pooler",
]);

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
): Effect.Effect<PreparedStackArtifacts, StackPreparationError> =>
  Effect.gen(function* () {
    const versions = { ...DEFAULT_VERSIONS, ...input?.versions };
    const services: ReadonlyArray<ServiceName> = input?.services ?? SERVICE_NAMES;
    const mode = input?.mode ?? "auto";

    type Entry = readonly [ServiceName, ServiceResolution];

    const resolveService = (service: ServiceName): Effect.Effect<Entry, StackPreparationError> => {
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

      // Docker-only services cannot run natively. The native+docker-only CONFIG
      // contract is enforced one layer up (`StackBuilder.validateResolvedConfig`);
      // this branch is only reachable in "native" mode via `prefetch()` (which
      // defaults to ALL services), where warming native assets must not require
      // a Docker daemon — resolve to the canonical image name without pulling.
      if (dockerOnlyServices.has(service)) {
        if (mode === "native") {
          return Effect.succeed<Entry>([
            service,
            { type: "docker", image: dockerImageForService(service, versions[service]) },
          ]);
        }
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
        mode,
      ).pipe(
        Effect.map((resolution): Entry => [service, resolution]),
        Effect.ensuring(markDownloadFinished()),
      );
    };

    const results = yield* Effect.all(services.map(resolveService), {
      concurrency: "unbounded",
    });

    const artifacts = {
      resolutions: Object.fromEntries(results) as PreparedStackArtifacts["resolutions"],
    } satisfies PreparedStackArtifacts;
    yield* publishEvent?.(new PreparationCompleted({ artifacts })) ?? Effect.void;
    return artifacts;
  });

export class StackPreparation extends Context.Service<
  StackPreparation,
  {
    readonly prepare: (
      input?: StackPreparationInput,
    ) => Effect.Effect<PreparedStackArtifacts, StackPreparationError>;
    readonly prepareEvents: (
      input?: StackPreparationInput,
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

      return {
        prepare: (input?: StackPreparationInput) =>
          prepareAssetsWithDependencies(resolver, spawner, input),
        prepareEvents: (input?: StackPreparationInput) =>
          Stream.callback<StackPreparationEvent, StackPreparationError>((queue) =>
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

    for (const image of images) {
      for (
        let attemptIndex = 0;
        attemptIndex <= DOCKER_PULL_RETRY_DELAYS_MS.length;
        attemptIndex += 1
      ) {
        const attempt = attemptIndex + 1;
        const result = yield* Effect.exit(runPullCommand(spawner, image));
        if (Exit.isSuccess(result)) {
          if (result.value.exitCode === 0) {
            return image;
          }

          const message =
            result.value.stderr.length > 0
              ? result.value.stderr
              : `docker pull exited with code ${result.value.exitCode}`;
          failures.push({ image, attempt, message });

          if (!shouldRetryPull(message) || attemptIndex === DOCKER_PULL_RETRY_DELAYS_MS.length) {
            break;
          }
        } else {
          const cause = Cause.squash(result.cause);
          const message = cause instanceof Error ? cause.message : String(cause);
          failures.push({ image, attempt, message });
          if (!shouldRetryPull(message) || attemptIndex === DOCKER_PULL_RETRY_DELAYS_MS.length) {
            break;
          }
        }

        const retryDelay = DOCKER_PULL_RETRY_DELAYS_MS[attemptIndex];
        if (retryDelay === undefined) {
          break;
        }
        yield* Effect.sleep(`${retryDelay} millis`);
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
      }),
    );
  });

const resolveServiceWithMetadata = (
  resolver: BinaryResolver["Service"],
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  service: ServiceName,
  version: string,
  onDownloadStart: Effect.Effect<void>,
  mode: "native" | "auto",
): Effect.Effect<ServiceResolution, StackPreparationError> => {
  const nativeBinary = resolver
    .resolveWithMetadata({ service, version }, { onDownloadStart })
    .pipe(Effect.map(({ path }): ServiceResolution => ({ type: "binary", path })));
  // `mode: "native"` requires native binaries (README): resolution failures
  // propagate instead of silently flipping the service onto Docker.
  if (mode === "native") {
    return nativeBinary;
  }
  const dockerFallback = () =>
    resolveDockerImageForService(spawner, service, version, {
      onDownloadStart,
    }).pipe(Effect.map((image): ServiceResolution => ({ type: "docker", image })));
  return nativeBinary.pipe(
    Effect.catchTag("BinaryNotFoundError", dockerFallback),
    Effect.catchTag("DownloadError", dockerFallback),
  );
};

const runPullCommand = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  image: string,
): Effect.Effect<{ readonly exitCode: number; readonly stderr: string }, Error> =>
  Effect.gen(function* () {
    const child = yield* spawner.spawn(ChildProcess.make("docker", ["pull", image]));
    const [stderr, exitCode] = yield* Effect.all(
      [collectStreamAsString(child.stderr), child.exitCode.pipe(Effect.map(Number))],
      { concurrency: "unbounded" },
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
