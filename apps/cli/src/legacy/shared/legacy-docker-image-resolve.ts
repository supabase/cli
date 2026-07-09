import { Effect, Exit, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { containerCliExitCode, spawnContainerCli } from "./legacy-container-cli.ts";
import { LegacyDockerRunError } from "./legacy-docker-run.errors.ts";
import { LEGACY_SUGGEST_DOCKER_INSTALL } from "./legacy-docker-suggest.ts";
import { legacyGetRegistryImageUrlCandidates } from "./legacy-docker-registry.ts";

type Spawner = ChildProcessSpawner["Service"];

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

const spawnError = () =>
  // Never embed the spawn error verbatim: it can leak the full argv and
  // environment of the failed exec (CWE-214/209). Emit a fixed,
  // credential-free message that still points at the likely cause.
  new LegacyDockerRunError({
    message: `failed to run docker. ${LEGACY_SUGGEST_DOCKER_INSTALL}`,
  });

const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
};

const shouldRetryPull = (message: string): boolean =>
  RETRYABLE_PULL_PATTERNS.some((pattern) => pattern.test(message));

/**
 * Builds a Docker image resolver bound to `spawner`: given an image, finds the
 * best registry candidate (already-local first, then pulled with retry),
 * mirroring Go's `pullImage` (`apps/cli-go/internal/utils/docker.go`). Used by
 * both the foreground `db dump`-style run-to-completion containers
 * (`legacy-docker-run.layer.ts`) and `start`'s detached, long-running service
 * containers — the resolve/pull/retry algorithm is identical for both, only
 * the caller's process lifecycle differs.
 */
export function legacyMakeDockerImageResolver(
  spawner: Spawner,
): (image: string) => Effect.Effect<string, LegacyDockerRunError> {
  const hasLocalImage = (image: string): Effect.Effect<boolean> =>
    containerCliExitCode(spawner, ["image", "inspect", image]).pipe(
      Effect.map((exitCode) => exitCode === 0),
      Effect.catch(() => Effect.succeed(false)),
    );

  const pullImage = (
    image: string,
  ): Effect.Effect<{ readonly exitCode: number; readonly stderr: string }, Error> =>
    Effect.gen(function* () {
      const handle = yield* spawnContainerCli(spawner, ["pull", image], {
        stdin: "inherit",
        stdout: "pipe",
        stderr: "pipe",
        detached: false,
        extendEnv: true,
      }).pipe(Effect.mapError(() => new Error("spawn")));
      // Tee pull progress to the parent terminal in real time so a large,
      // uncached pull does not look frozen — Go streams the same progress via
      // `jsonmessage.DisplayJSONMessagesToStream`. Progress goes to stderr so
      // it never corrupts the captured stdout of the `db dump` run path. The
      // buffered copies are kept only to classify retryable failures and to
      // report the error on a non-zero exit. Decode each stream separately so
      // a multi-byte UTF-8 sequence is never split across interleaved chunks.
      const stdoutChunks: Array<Uint8Array> = [];
      const stderrChunks: Array<Uint8Array> = [];
      yield* Effect.all(
        [
          Stream.runForEach(handle.stdout, (chunk) =>
            Effect.sync(() => {
              stdoutChunks.push(chunk);
              globalThis.process.stderr.write(chunk);
            }),
          ),
          Stream.runForEach(handle.stderr, (chunk) =>
            Effect.sync(() => {
              stderrChunks.push(chunk);
              globalThis.process.stderr.write(chunk);
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      const exitCode = yield* handle.exitCode.pipe(Effect.map(Number));
      const stdout = new TextDecoder().decode(concat(stdoutChunks));
      const stderr = new TextDecoder().decode(concat(stderrChunks));
      return {
        exitCode,
        stderr: `${stdout}${stderr}`.trim(),
      };
    }).pipe(Effect.scoped);

  return (image: string): Effect.Effect<string, LegacyDockerRunError> =>
    Effect.gen(function* () {
      const candidates = legacyGetRegistryImageUrlCandidates(image);
      for (const candidate of candidates) {
        if (yield* hasLocalImage(candidate)) {
          return candidate;
        }
      }

      const failures: Array<string> = [];
      for (const candidate of candidates) {
        for (
          let attemptIndex = 0;
          attemptIndex <= DOCKER_PULL_RETRY_DELAYS_MS.length;
          attemptIndex += 1
        ) {
          const attempt = attemptIndex + 1;
          const result = yield* Effect.exit(pullImage(candidate));
          if (Exit.isSuccess(result)) {
            if (result.value.exitCode === 0) {
              return candidate;
            }
            const message =
              result.value.stderr.length > 0
                ? result.value.stderr
                : `docker pull exited with code ${result.value.exitCode}`;
            failures.push(`${candidate} attempt ${attempt}: ${message}`);
            if (!shouldRetryPull(message) || attemptIndex === DOCKER_PULL_RETRY_DELAYS_MS.length) {
              break;
            }
          } else {
            // A failed effect (rather than a non-zero exit, which returns a
            // value) means the container runtime could not be spawned at all.
            // No registry candidate can fix a missing Docker/Podman binary or
            // a down daemon, so stop here and surface the install hint instead
            // of an opaque, repeated spawn error across every candidate.
            return yield* Effect.fail(spawnError());
          }

          const delay = DOCKER_PULL_RETRY_DELAYS_MS[attemptIndex];
          if (delay === undefined) {
            break;
          }
          yield* Effect.sleep(`${delay} millis`);
        }
      }

      return yield* Effect.fail(
        new LegacyDockerRunError({
          message: `failed to pull docker image from all registries: ${failures.join("; ")}`,
        }),
      );
    });
}
