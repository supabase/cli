import { Effect, Exit, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { containerCliExitCode, spawnContainerCli } from "./legacy-container-cli.ts";
import { LegacyDockerRunError } from "./legacy-docker-run.errors.ts";
import { LEGACY_SUGGEST_DOCKER_INSTALL } from "./legacy-docker-suggest.ts";
import { legacyGetRegistryImageUrlCandidates } from "./legacy-docker-registry.ts";

type Spawner = ChildProcessSpawner["Service"];

const DOCKER_PULL_RETRY_DELAYS_MS = [4_000, 8_000] as const;

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

/**
 * Builds a Docker image resolver bound to `spawner`: given an image, finds the
 * best registry candidate (already-local first, then pulled with retry),
 * mirroring Go's `DockerResolveImageIfNotCached` /
 * `DockerImagePullWithRetry` (`apps/cli-go/internal/utils/docker.go:304-343`).
 * A pull failure is retried unconditionally — Go retries on any non-nil error
 * as long as the context wasn't canceled, with no message-pattern gating — up
 * to 2 times per candidate (3 total attempts) with an escalating 4s/8s
 * backoff (`DOCKER_PULL_RETRY_DELAYS_MS`), matching Go's `2<<(i+1)` seconds
 * for `i` in `0,1`. A spawn failure (the Docker/Podman binary itself
 * couldn't be run) is a different, non-retryable case — see `spawnError`
 * below. Used by both the foreground `db dump`-style run-to-completion
 * containers (`legacy-docker-run.layer.ts`) and `start`'s detached,
 * long-running service containers — the resolve/pull/retry algorithm is
 * identical for both, only the caller's process lifecycle differs.
 *
 * `projectEnvValues` is optional (see `legacy-docker-registry.ts`'s doc
 * comment) — only `start` currently threads it through, since its caller
 * already has the project's dotenv-merged values in scope; `legacy-docker-run.layer.ts`
 * is a statically-composed `Layer` built before any `projectEnvValues` is
 * known, so its own callers stay ambient-only for now.
 */
export function legacyMakeDockerImageResolver(
  spawner: Spawner,
  projectEnvValues?: Readonly<Record<string, string>>,
): (image: string) => Effect.Effect<string, LegacyDockerRunError> {
  const hasLocalImage = (image: string): Effect.Effect<boolean> =>
    // `stdin`/`stdout`/`stderr: "ignore"`: this only awaits the exit code, but
    // `docker image inspect` writes the full image JSON to stdout on a cache
    // hit, which can exceed the OS pipe buffer and deadlock the child against
    // an unread default `"pipe"` stdio — see `legacy-docker-remove-all.ts`'s
    // fuller explanation of this same hazard.
    containerCliExitCode(spawner, ["image", "inspect", image], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }).pipe(
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
      // buffered copies are kept only to report the error message on a
      // non-zero exit. Decode each stream separately so a multi-byte UTF-8
      // sequence is never split across interleaved chunks.
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
      const candidates = legacyGetRegistryImageUrlCandidates(image, projectEnvValues);
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
            if (attemptIndex === DOCKER_PULL_RETRY_DELAYS_MS.length) {
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
