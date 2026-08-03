import { Effect, Exit, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { spawnContainerCli } from "./legacy-container-cli.ts";
import { LegacyDockerRunError } from "./legacy-docker-run.errors.ts";
import {
  LEGACY_SUGGEST_DOCKER_INSTALL,
  legacyIsDockerDaemonUnreachable,
} from "./legacy-docker-suggest.ts";
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
 * The local-image check fails fast (never reaching the pull loop at all) when
 * the daemon itself is unreachable — Go's own inspect call distinguishes a
 * typed `errdefs.IsNotFound` from any other inspect error and returns the
 * latter immediately (`docker.go:326-334`); see `hasLocalImage` below for how
 * this port makes the same distinction from a CLI subprocess's stderr instead
 * of a typed Engine API error. Once past that gate, a pull failure IS retried
 * unconditionally — Go retries on any non-nil error as long as the context
 * wasn't canceled, with no message-pattern gating — up to 2 times per
 * candidate (3 total attempts) with an escalating 4s/8s backoff
 * (`DOCKER_PULL_RETRY_DELAYS_MS`), matching Go's `2<<(i+1)` seconds for `i` in
 * `0,1`. A spawn failure (the Docker/Podman binary itself couldn't be run) is
 * a different, non-retryable case — see `spawnError` below. Used by both the
 * foreground `db dump`-style run-to-completion containers
 * (`legacy-docker-run.layer.ts`) and `start`'s detached, long-running service
 * containers — the resolve/pull/retry algorithm is identical for both, only
 * the caller's process lifecycle differs.
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
  const hasLocalImage = (image: string): Effect.Effect<boolean, LegacyDockerRunError> =>
    Effect.gen(function* () {
      // `stdout: "ignore"`: `docker image inspect` writes the full image JSON
      // to stdout on a cache hit, which can exceed the OS pipe buffer and
      // deadlock the child against an unread default `"pipe"` stdio — see
      // `legacy-docker-remove-all.ts`'s fuller explanation of this same
      // hazard. `stderr` IS captured (unlike a plain exit-code check) so a
      // "daemon unreachable" response can be told apart from a genuine
      // "image not found" — see this function's own doc comment above.
      const handle = yield* spawnContainerCli(spawner, ["image", "inspect", image], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      }).pipe(Effect.mapError(() => spawnError()));
      const stderrChunks: Array<Uint8Array> = [];
      yield* Stream.runForEach(handle.stderr, (chunk) =>
        Effect.sync(() => {
          stderrChunks.push(chunk);
        }),
      ).pipe(Effect.mapError(() => spawnError()));
      const exitCode = yield* handle.exitCode.pipe(
        Effect.map(Number),
        Effect.mapError(() => spawnError()),
      );
      if (exitCode === 0) return true;
      const stderr = new TextDecoder().decode(concat(stderrChunks)).trim();
      if (legacyIsDockerDaemonUnreachable(stderr)) {
        return yield* Effect.fail(
          new LegacyDockerRunError({
            message: `failed to inspect docker image: ${stderr}\n\n${LEGACY_SUGGEST_DOCKER_INSTALL}`,
          }),
        );
      }
      return false;
    }).pipe(Effect.scoped);

  const pullImage = (
    image: string,
  ): Effect.Effect<
    { readonly exitCode: number; readonly stderr: string; readonly endedWithNewline: boolean },
    Error
  > =>
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
      // `endedWithNewline` records whether the last byte teed to the parent's
      // stderr was `\n` (both streams share it — last write wins, which is
      // what the terminal shows), so the retry loop can start its banner on a
      // fresh line when the child's final output wasn't newline-terminated.
      const stdoutChunks: Array<Uint8Array> = [];
      const stderrChunks: Array<Uint8Array> = [];
      let endedWithNewline = true;
      yield* Effect.all(
        [
          Stream.runForEach(handle.stdout, (chunk) =>
            Effect.sync(() => {
              stdoutChunks.push(chunk);
              globalThis.process.stderr.write(chunk);
              if (chunk.length > 0) endedWithNewline = chunk[chunk.length - 1] === 0x0a;
            }),
          ),
          Stream.runForEach(handle.stderr, (chunk) =>
            Effect.sync(() => {
              stderrChunks.push(chunk);
              globalThis.process.stderr.write(chunk);
              if (chunk.length > 0) endedWithNewline = chunk[chunk.length - 1] === 0x0a;
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
        endedWithNewline,
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
            // value) means the container runtime could not be spawned at all
            // — a down daemon is caught earlier, by `hasLocalImage`'s own
            // fail-fast check above, and never reaches this loop. No registry
            // candidate can fix a missing Docker/Podman binary, so stop here
            // and surface the install hint instead of an opaque, repeated
            // spawn error across every candidate.
            return yield* Effect.fail(spawnError());
          }

          const delay = DOCKER_PULL_RETRY_DELAYS_MS[attemptIndex];
          if (delay === undefined) {
            break;
          }
          // Go prints a per-retry banner before sleeping (`docker.go:314`):
          // `fmt.Fprintf(os.Stderr, "Retrying after %v: %s\n", period, image)`
          // — `%v` of the 4s/8s backoff `time.Duration` renders as `4s`/`8s`.
          // Go also `Fprintln`s the failed attempt's error just before the
          // banner (`docker.go:312`); here the `docker pull` child's own
          // stderr — already teed live to the parent's stderr above — plays
          // that role. `Fprintln` always newline-terminates, so when the
          // child's final output didn't, add the `\n` ourselves — otherwise
          // the banner would glue onto the error text where Go prints two
          // lines.
          yield* Effect.sync(() => {
            if (!result.value.endedWithNewline) {
              globalThis.process.stderr.write("\n");
            }
            globalThis.process.stderr.write(`Retrying after ${delay / 1000}s: ${candidate}\n`);
          });
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
