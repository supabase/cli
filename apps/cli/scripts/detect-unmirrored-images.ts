// Detects images pinned in apps/cli/src/shared/services/Dockerfile that are missing from
// any mirror registry and emits them as JSON, for the mirror-template-images workflow's backfill
// matrix.
import { constants } from "node:os";
import { BunServices } from "@effect/platform-bun";
import {
  Config,
  Console,
  Data,
  Deferred,
  Effect,
  FileSystem,
  Predicate,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { dockerfileServiceImages } from "../src/shared/services/dockerfile-images.ts";

/**
 * Registries the mirror publishes to and the CLI pulls from. An image counts as mirrored only
 * when it exists on every one of these — a tag present on one but not another is a partial
 * mirror that must be re-pushed.
 */
export const MIRROR_REGISTRIES = ["public.ecr.aws", "ghcr.io"] as const;

/**
 * Mirror destination for an upstream image on a single registry. The upstream org is dropped —
 * every image is mirrored under the `supabase/` namespace, e.g.
 * `postgrest/postgrest:v14.14` -> `ghcr.io/supabase/postgrest:v14.14`.
 */
export function mirrorImageTarget(image: string, registry: string): string {
  const basename = image.slice(image.lastIndexOf("/") + 1);
  return `${registry}/supabase/${basename}`;
}

/** Mirror destinations for an upstream image across every mirror registry. */
export function mirrorImageTargets(
  image: string,
  registries: ReadonlyArray<string> = MIRROR_REGISTRIES,
): ReadonlyArray<string> {
  return registries.map((registry) => mirrorImageTarget(image, registry));
}

export interface MirrorPartition {
  /** Images present on every mirror registry — nothing to do. */
  readonly mirrored: ReadonlyArray<string>;
  /** Images missing from at least one mirror registry — these need backfilling. */
  readonly missing: ReadonlyArray<string>;
}

/**
 * Splits images by whether they exist on every registry in `registries`. An image missing from
 * any one registry lands in `missing`, since the backfill must re-push it everywhere; images
 * already mirrored everywhere land in `mirrored` and are skipped by a re-run.
 */
export const partitionUnmirroredImages = <E, R>(
  images: Iterable<string>,
  isMirrored: (target: string) => Effect.Effect<boolean, E, R>,
  registries: ReadonlyArray<string> = MIRROR_REGISTRIES,
): Effect.Effect<MirrorPartition, E, R> =>
  Effect.gen(function* () {
    const unique = [...new Set(images)];
    const results = yield* Effect.forEach(
      unique,
      (image) =>
        Effect.forEach(mirrorImageTargets(image, registries), (target) => isMirrored(target), {
          concurrency: "unbounded",
        }).pipe(Effect.map((presence) => ({ image, mirrored: presence.every(Boolean) }))),
      { concurrency: "unbounded" },
    );

    return {
      mirrored: results.filter((result) => result.mirrored).map((result) => result.image),
      missing: results.filter((result) => !result.mirrored).map((result) => result.image),
    };
  });

/**
 * Interprets a `docker buildx imagetools inspect` result. Only a registry "not found" means the
 * image is unmirrored; any other failure (auth, rate limit, network) throws, so a registry outage
 * fails detection instead of re-pushing every image.
 */
export function inspectResultIsMirrored(
  target: string,
  exit: number | NodeJS.Signals | null,
  stderr: string,
): boolean {
  if (exit === 0) {
    return true;
  }
  if (stderr.trimEnd().endsWith(": not found")) {
    return false;
  }
  throw new Error(`could not inspect ${target} (exit ${exit}): ${stderr.trim()}`);
}

export interface InspectResult {
  readonly exit: number | NodeJS.Signals | null;
  readonly stderr: string;
}

/** Backoff before each retry of a rate-limited (HTTP 429 or OCI `toomanyrequests`) registry probe. */
export const RATE_LIMIT_RETRY_DELAYS_MS: ReadonlyArray<number> = [10_000, 30_000, 60_000];

class MirrorInspectError extends Data.TaggedError("MirrorInspectError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Runs a registry probe, retrying with backoff while the registry rate-limits it (HTTP 429 or OCI
 * `toomanyrequests`); the anonymous public.ecr.aws quota is shared per runner IP and usually
 * recovers within a minute.
 */
export const inspectWithRateLimitRetry = <E, R>(
  target: string,
  inspect: Effect.Effect<InspectResult, E, R>,
  sleep: (ms: number) => Effect.Effect<void>,
  delaysMs: ReadonlyArray<number> = RATE_LIMIT_RETRY_DELAYS_MS,
): Effect.Effect<boolean, E | MirrorInspectError, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; ; attempt++) {
      const { exit, stderr } = yield* inspect;
      const delay = delaysMs[attempt];
      if (
        exit !== 0 &&
        /429 Too Many Requests|toomanyrequests/i.test(stderr) &&
        delay !== undefined
      ) {
        yield* Console.error(`rate limited inspecting ${target}, retrying in ${delay}ms`);
        yield* sleep(delay);
        continue;
      }
      return yield* Effect.try({
        try: () => inspectResultIsMirrored(target, exit, stderr),
        catch: (cause) =>
          new MirrorInspectError({
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
    }
  });

const platformMessage = (error: { readonly message: string; readonly cause?: unknown }) =>
  error.cause instanceof Error ? error.cause.message : error.message;

const isSignal = (name: string): name is NodeJS.Signals => Object.hasOwn(constants.signals, name);

const receivedSignal = (error: { readonly message: string; readonly cause?: unknown }) => {
  const name = /^Process interrupted due to receipt of signal: '(.+)'$/.exec(
    platformMessage(error),
  )?.[1];
  return name !== undefined && isSignal(name) ? name : undefined;
};

const MAX_STDERR_BYTES = 1024 * 1024;

function stderrOverflowError(args: ReadonlyArray<string>): Error {
  return Object.assign(
    new Error("spawnSync docker ENOBUFS (stdout or stderr buffer reached maxBuffer size limit)"),
    {
      path: "docker",
      syscall: "spawnSync docker",
      errno: -constants.errno.ENOBUFS,
      code: "ENOBUFS",
      spawnargs: [...args],
    },
  );
}

/* Decodes the whole stderr at once and keeps a leading byte order mark. */
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });

const inspectMirrorTarget = (target: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const args = ["buildx", "imagetools", "inspect", target];
    const handle = yield* spawner
      .spawn(
        ChildProcess.make("docker", args, {
          detached: false,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
        }),
      )
      .pipe(
        /* Spawn errors keep the `spawnSync docker` syscall label. */
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (
              Predicate.hasProperty(error.cause, "syscall") &&
              error.cause.syscall === "spawn docker"
            ) {
              error.cause.syscall = "spawnSync docker";
            }
          }),
        ),
        Effect.catchDefect((defect) =>
          Effect.fail(
            new MirrorInspectError({
              message: defect instanceof Error ? defect.message : String(defect),
              cause: defect,
            }),
          ),
        ),
      );
    const chunks: Array<Uint8Array> = [];
    let stderrBytes = 0;
    const readStderr = Stream.runForEach(handle.stderr, (chunk) =>
      Effect.suspend(() => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > MAX_STDERR_BYTES) {
          const cause = stderrOverflowError(args);
          return Effect.fail(new MirrorInspectError({ message: cause.message, cause }));
        }
        chunks.push(chunk);
        return Effect.void;
      }),
    ).pipe(
      Effect.map(() => {
        const bytes = new Uint8Array(stderrBytes);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return utf8.decode(bytes);
      }),
    );
    const [stderr, exit] = yield* Effect.all(
      [
        readStderr,
        handle.exitCode.pipe(
          Effect.map((code): number | NodeJS.Signals => Number(code)),
          Effect.catch((error) => {
            const signal = receivedSignal(error);
            return signal === undefined ? Effect.fail(error) : Effect.succeed(signal);
          }),
        ),
      ],
      { concurrency: "unbounded" },
    );
    return { exit, stderr } satisfies InspectResult;
  }).pipe(
    Effect.scoped,
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(new MirrorInspectError({ message: platformMessage(error), cause: error.cause })),
    ),
  );

const encodeMissing = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

const main = Effect.gen(function* () {
  /* Probes run one at a time, as the registries rate-limit bursts; a rate-limit backoff does not
     hold the permit, so other probes continue meanwhile. */
  const probe = yield* Semaphore.make(1);
  const images = dockerfileServiceImages.map((spec) => spec.image);

  /* Every target gets its first probe before a probe failure aborts detection, and the earliest
     failure is the one reported. */
  let firstProbesLeft = new Set(images).size * MIRROR_REGISTRIES.length;
  const firstProbesDone = yield* Deferred.make<void>();
  if (firstProbesLeft === 0) {
    yield* Deferred.succeed(firstProbesDone, undefined);
  }
  const probeFailure = yield* Deferred.make<never, MirrorInspectError>();
  const imageExistsOnMirror = (target: string) =>
    Effect.suspend(() => {
      let firstProbe = true;
      const inspect = probe.withPermit(inspectMirrorTarget(target)).pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            if (!firstProbe) {
              return Effect.void;
            }
            firstProbe = false;
            firstProbesLeft -= 1;
            return firstProbesLeft === 0
              ? Deferred.succeed(firstProbesDone, undefined)
              : Effect.void;
          }),
        ),
      );
      return inspectWithRateLimitRetry(target, inspect, (ms) => Effect.sleep(ms)).pipe(
        Effect.catch((error) =>
          Deferred.fail(probeFailure, error).pipe(Effect.andThen(Effect.never)),
        ),
      );
    });

  const { mirrored, missing } = yield* Effect.raceFirst(
    partitionUnmirroredImages(images, imageExistsOnMirror),
    Deferred.await(firstProbesDone).pipe(Effect.andThen(Deferred.await(probeFailure))),
  );

  for (const image of mirrored) {
    yield* Console.error(`already mirrored: ${image}`);
  }
  for (const image of missing) {
    yield* Console.error(`needs mirror: ${image} -> ${mirrorImageTargets(image).join(", ")}`);
  }

  const json = yield* encodeMissing(missing);
  yield* Console.log(json);

  // Expose the list to the workflow as a step output when running in CI.
  const githubOutput = yield* Config.String("GITHUB_OUTPUT").pipe(Config.withDefault(""));
  if (githubOutput) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(githubOutput, `missing=${json}\n`, { flag: "a" });
  }
});

if (import.meta.main) {
  await Effect.runPromise(
    main.pipe(
      Effect.mapError((error) => error.cause ?? error),
      Effect.provide(BunServices.layer),
    ),
  );
}
