import { Effect, Exit, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { ContainerRuntimeNotFoundError, spawnContainerCli } from "./container-cli.ts";
import { DockerRunError } from "./docker-run.errors.ts";
import { SUGGEST_DOCKER_INSTALL, isDockerDaemonUnreachable } from "./docker-suggest.ts";
import { getRegistryImageUrlCandidates } from "./docker-registry.ts";

type Spawner = ChildProcessSpawner["Service"];

const DOCKER_PULL_RETRY_DELAYS_MS = [4_000, 8_000] as const;

/**
 * Marks a pull attempt that timed out rather than failed, so the retry loop moves to the next
 * candidate instead of treating it like a broken Docker install and aborting every remaining one.
 */
const PULL_TIMED_OUT = Symbol("PULL_TIMED_OUT");

const spawnError = () =>
  // The raw spawn error can leak the failed exec's full argv and environment, so emit a fixed,
  // credential-free message instead.
  new DockerRunError({
    message: `failed to run docker. ${SUGGEST_DOCKER_INSTALL}`,
    reason: "spawn",
    daemonDown: false,
  });

const runtimeNotFound = (cause: ContainerRuntimeNotFoundError) =>
  new DockerRunError({ message: cause.message, reason: "spawn", daemonDown: false });

/**
 * Detects a confirmed "image not found" `image inspect` failure across Docker (`No such image`)
 * and Podman (`image not known`) — any other inspect error is unexpected and must not fall
 * through to the pull loop.
 */
const isImageNotFoundMessage = (message: string): boolean =>
  /no such image/iu.test(message) || /image not known/iu.test(message);

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
 * Builds an image resolver bound to `spawner`: returns the first registry candidate already
 * cached locally, or pulls candidates in order with the escalating backoff in
 * {@link DOCKER_PULL_RETRY_DELAYS_MS}. A local-image check failure or a failure to spawn
 * Docker/Podman at all skips retries and fails immediately. `projectEnvValues` is optional —
 * only callers that already have the project's dotenv-merged values in scope thread it through.
 */
export function makeDockerImageResolver(
  spawner: Spawner,
  projectEnvValues?: Readonly<Record<string, string>>,
): (image: string, deadline?: number) => Effect.Effect<string, DockerRunError> {
  const hasLocalImage = (image: string): Effect.Effect<boolean, DockerRunError> =>
    Effect.gen(function* () {
      // `stdout: "ignore"`: a cache hit writes the full image JSON to stdout, which can exceed
      // the pipe buffer and deadlock the child if left unread. `stderr` is captured so a
      // daemon-unreachable response can be told apart from a genuine "image not found".
      const handle = yield* spawnContainerCli(spawner, ["image", "inspect", image], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      }).pipe(Effect.mapError(runtimeNotFound));
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
      // Only a confirmed "not found" is a cache miss. Any other inspect failure (daemon
      // unreachable, auth-plugin denial, invalid reference, ...) must fail immediately, not fall
      // through to the pull loop and attempt an unauthorized network operation behind a retry
      // backoff.
      if (isImageNotFoundMessage(stderr)) return false;
      const daemonDown = isDockerDaemonUnreachable(stderr);
      const hint = daemonDown ? `\n\n${SUGGEST_DOCKER_INSTALL}` : "";
      return yield* Effect.fail(
        new DockerRunError({
          message: `failed to inspect docker image: ${stderr}${hint}`,
          reason: "inspect",
          daemonDown,
        }),
      );
    }).pipe(Effect.scoped);

  const pullImage = (
    image: string,
  ): Effect.Effect<
    { readonly exitCode: number; readonly stderr: string; readonly endedWithNewline: boolean },
    DockerRunError
  > =>
    Effect.gen(function* () {
      const handle = yield* spawnContainerCli(spawner, ["pull", image], {
        stdin: "inherit",
        stdout: "pipe",
        stderr: "pipe",
        detached: false,
        extendEnv: true,
      }).pipe(Effect.mapError(runtimeNotFound));
      // Tee pull progress to the parent's stderr in real time, so a slow uncached pull doesn't
      // look frozen; using stderr keeps the captured `db dump` stdout stream clean. The buffered
      // copies are kept only to report the error message on a non-zero exit, decoded separately
      // per stream so an interleaved multi-byte UTF-8 sequence is never split.
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
      ).pipe(Effect.mapError(() => spawnError()));
      const exitCode = yield* handle.exitCode.pipe(
        Effect.map(Number),
        Effect.mapError(() => spawnError()),
      );
      const stdout = new TextDecoder().decode(concat(stdoutChunks));
      const stderr = new TextDecoder().decode(concat(stderrChunks));
      return {
        exitCode,
        stderr: `${stdout}${stderr}`.trim(),
        endedWithNewline,
      };
    }).pipe(Effect.scoped);

  return (image: string, deadline?: number): Effect.Effect<string, DockerRunError> =>
    Effect.gen(function* () {
      const candidates = getRegistryImageUrlCandidates(image, projectEnvValues);
      for (const candidate of candidates) {
        if (yield* hasLocalImage(candidate)) {
          return candidate;
        }
      }

      const failures: Array<string> = [];
      for (const [candidateIndex, candidate] of candidates.entries()) {
        // `deadline` is opt-in — only the e2e helper passes one. Remaining time is re-split
        // across the candidates left after each one, so a fast failure's unused share carries
        // forward and a stalled registry can't starve the fallbacks behind it.
        let candidateShareMs: number | undefined;
        let candidateDeadline: number | undefined;
        if (deadline !== undefined) {
          candidateShareMs = Math.max(
            1,
            Math.floor((deadline - Date.now()) / (candidates.length - candidateIndex)),
          );
          candidateDeadline = Math.min(Date.now() + candidateShareMs, deadline);
        }
        let lastPullEndedWithNewline = true;
        for (
          let attemptIndex = 0;
          attemptIndex <= DOCKER_PULL_RETRY_DELAYS_MS.length;
          attemptIndex += 1
        ) {
          const attempt = attemptIndex + 1;
          const remainingMs =
            candidateDeadline === undefined ? undefined : candidateDeadline - Date.now();
          if (remainingMs !== undefined && remainingMs <= 0) {
            failures.push(
              `${candidate} attempt ${attempt}: candidate budget exhausted (${candidateShareMs}ms share)`,
            );
            break;
          }
          const result = yield* Effect.exit(
            remainingMs === undefined
              ? pullImage(candidate)
              : Effect.timeoutOrElse(pullImage(candidate), {
                  duration: `${remainingMs} millis`,
                  orElse: () => Effect.succeed(PULL_TIMED_OUT),
                }),
          );
          if (Exit.isSuccess(result)) {
            if (result.value === PULL_TIMED_OUT) {
              failures.push(`${candidate} attempt ${attempt}: timed out after ${remainingMs}ms`);
              // The share is spent — move straight to the next candidate.
              break;
            }
            const pulled = result.value;
            lastPullEndedWithNewline = pulled.endedWithNewline;
            if (pulled.exitCode === 0) {
              return candidate;
            }
            const message =
              pulled.stderr.length > 0
                ? pulled.stderr
                : `docker pull exited with code ${pulled.exitCode}`;
            failures.push(`${candidate} attempt ${attempt}: ${message}`);
            if (attemptIndex === DOCKER_PULL_RETRY_DELAYS_MS.length) {
              break;
            }
          } else {
            // A failed effect (vs a non-zero exit) means Docker/Podman itself couldn't be
            // spawned — no registry candidate can fix that, so stop here instead of repeating
            // the same spawn error.
            return yield* Effect.failCause(result.cause);
          }

          const delay = DOCKER_PULL_RETRY_DELAYS_MS[attemptIndex];
          if (delay === undefined) {
            break;
          }
          // Never sleep past this candidate's share — the backoff would spend
          // budget the remaining registries still need.
          if (candidateDeadline !== undefined && Date.now() + delay >= candidateDeadline) {
            break;
          }
          // Add a newline before the banner only when the child's own output didn't end with
          // one, so the two don't glue together.
          yield* Effect.sync(() => {
            if (!lastPullEndedWithNewline) {
              globalThis.process.stderr.write("\n");
            }
            globalThis.process.stderr.write(`Retrying after ${delay / 1000}s: ${candidate}\n`);
          });
          yield* Effect.sleep(`${delay} millis`);
        }
      }

      return yield* Effect.fail(
        new DockerRunError({
          message: `failed to pull docker image from all registries: ${failures.join("; ")}`,
          reason: "pull",
          daemonDown: failures.some(isDockerDaemonUnreachable),
        }),
      );
    });
}
