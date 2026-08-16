import { Effect, Exit, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import {
  legacyChildResult,
  legacyDecodeChunks,
  legacyGateOnExitCode,
  spawnContainerCli,
} from "./legacy-container-cli.ts";
import { LegacyDockerRunError } from "./legacy-docker-run.errors.ts";
import {
  LEGACY_SUGGEST_DOCKER_INSTALL,
  legacyIsDockerDaemonUnreachable,
} from "./legacy-docker-suggest.ts";
import { legacyGetRegistryImageUrlCandidates } from "./legacy-docker-registry.ts";

type Spawner = ChildProcessSpawner["Service"];

const DOCKER_PULL_RETRY_DELAYS_MS = [4_000, 8_000] as const;

/**
 * Distinguishes a deadline-bounded pull attempt expiring from a spawn failure:
 * the loop below treats a failed `pullImage` EFFECT as "docker itself is
 * broken" and aborts every remaining candidate, which is exactly wrong for a
 * timeout — a slow registry is the one failure the next candidate can fix.
 */
const PULL_TIMED_OUT = Symbol("PULL_TIMED_OUT");

const spawnError = () =>
  // Never embed the spawn error verbatim: it can leak the full argv and
  // environment of the failed exec (CWE-214/209). Emit a fixed,
  // credential-free message that still points at the likely cause.
  new LegacyDockerRunError({
    message: `failed to run docker. ${LEGACY_SUGGEST_DOCKER_INSTALL}`,
    reason: "spawn",
    daemonDown: false,
  });

/**
 * Docker's/Podman's "image not found" stderr shape for `image inspect` — the subprocess
 * equivalent of `errdefs.IsNotFound`, mirroring `db-bootstrap/container-lifecycle.ts`'s
 * (private) `isVolumeNotFoundMessage` for `volume inspect`. Confirmed empirically: `docker image
 * inspect <missing>` prints `Error response from daemon: No such image: <ref>` and exits 1;
 * an uncached Podman inspect exits non-zero with the differently worded `<ref>: image not
 * known` instead (Podman's `libimage` not-found error, independent of Docker's daemon-response
 * wording — see e.g. containers/podman-compose#358's `failed to find image …: image not known`
 * trace). Both must resolve to "not cached" or the pull loop below never runs on a Podman-only
 * host, matching the same Docker/Podman fallback `spawnContainerCli` already builds in.
 */
const isImageNotFoundMessage = (message: string): boolean =>
  /no such image/iu.test(message) || /image not known/iu.test(message);

/**
 * Builds a Docker image resolver bound to `spawner`: given an image, finds the
 * best registry candidate (already-local first, then pulled with retry),
 * mirroring `DockerResolveImageIfNotCached` /
 * `DockerImagePullWithRetry`.
 * The local-image check fails fast (never reaching the pull loop at all) when
 * the daemon itself is unreachable — Go's own inspect call distinguishes a
 * typed `errdefs.IsNotFound` from any other inspect error and returns the
 * latter immediately; see `hasLocalImage` below for how
 * this port makes the same distinction from a CLI subprocess's stderr instead
 * of a typed Engine API error. Once past that gate, a pull failure IS retried
 * unconditionally — Go retries on any non-nil error as long as the context
 * wasn't canceled, with no message-pattern gating — up to 2 times per
 * candidate (3 total attempts) with an escalating 4s/8s backoff
 * (`DOCKER_PULL_RETRY_DELAYS_MS`), matching `2<<(i+1)` seconds for `i` in
 * `0,1`. A spawn failure (the Docker/Podman binary itself couldn't be run) is
 * a different, non-retryable case — see `spawnError` below. Used by both the
 * foreground `db dump`-style run-to-completion containers
 * (`legacy-docker-run.layer.ts`) and `start`'s detached, long-running service
 * containers — the resolve/pull/retry algorithm is identical for both, only
 * the caller's process lifecycle differs.
 *
 * `projectEnvValues` is optional (see `legacy-docker-registry.ts`'s doc
 * comment) — `start` and the `functions` Docker paths (`deploy`, `download`,
 * `serve`, via `resolveFunctionsDockerImage`) all thread it through, since
 * each already has the project's dotenv-merged values in scope by the time
 * it resolves an image; `legacy-docker-run.layer.ts` is a statically-composed
 * `Layer` built before any `projectEnvValues` is known, so its own callers
 * stay ambient-only for now.
 */
export function legacyMakeDockerImageResolver(
  spawner: Spawner,
  projectEnvValues?: Readonly<Record<string, string>>,
): (image: string, deadline?: number) => Effect.Effect<string, LegacyDockerRunError> {
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
      const { exitCode, stderr: stderrText } = yield* legacyChildResult(handle, {
        stderr: true,
      }).pipe(Effect.mapError(() => spawnError()));
      if (exitCode === 0) return true;
      const stderr = stderrText.trim();
      // `DockerResolveImageIfNotCached` proceeds to the pull loop only when the inspect
      // error is a confirmed `errdefs.IsNotFound` — any OTHER inspect error (daemon unreachable,
      // an auth-plugin denial, an invalid reference, an API error, ...) returns immediately
      // instead. Defaulting anything-but-daemon-unreachable
      // to "not cached" (as this used to) would instead send every OTHER inspect failure through
      // the multi-registry pull loop too — performing unauthorized network operations, delaying
      // the failure by each retry backoff, and replacing the real inspect error with a pull
      // aggregate. So this must default to failing, and only treat a confirmed not-found as a
      // cache miss — the inverse of the daemon-unreachable-only gate this replaced.
      if (isImageNotFoundMessage(stderr)) return false;
      const daemonDown = legacyIsDockerDaemonUnreachable(stderr);
      const hint = daemonDown ? `\n\n${LEGACY_SUGGEST_DOCKER_INSTALL}` : "";
      return yield* Effect.fail(
        new LegacyDockerRunError({
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
      const teeInto = (chunks: Array<Uint8Array>) => (chunk: Uint8Array) =>
        Effect.sync(() => {
          chunks.push(chunk);
          globalThis.process.stderr.write(chunk);
          if (chunk.length > 0) endedWithNewline = chunk[chunk.length - 1] === 0x0a;
        });
      const { exitCode } = yield* legacyGateOnExitCode(
        handle,
        [
          Stream.runForEach(handle.stdout, teeInto(stdoutChunks)),
          Stream.runForEach(handle.stderr, teeInto(stderrChunks)),
        ],
        () => stdoutChunks.length + stderrChunks.length,
      );
      const stdout = legacyDecodeChunks(stdoutChunks);
      const stderr = legacyDecodeChunks(stderrChunks);
      return {
        exitCode,
        stderr: `${stdout}${stderr}`.trim(),
        endedWithNewline,
      };
    }).pipe(Effect.scoped);

  return (image: string, deadline?: number): Effect.Effect<string, LegacyDockerRunError> =>
    Effect.gen(function* () {
      const candidates = legacyGetRegistryImageUrlCandidates(image, projectEnvValues);
      for (const candidate of candidates) {
        if (yield* hasLocalImage(candidate)) {
          return candidate;
        }
      }

      const failures: Array<string> = [];
      for (const [candidateIndex, candidate] of candidates.entries()) {
        // `deadline` (epoch ms) is opt-in and no production caller passes one:
        // a human watching `supabase start` can Ctrl-C a slow pull, CI cannot,
        // so only the e2e helper (`tests/helpers/docker-image.ts`) bounds the
        // resolve. Remaining time is split across the candidates still to run —
        // recomputed per candidate so a fast failure carries its unused
        // share forward and the last candidate gets all remaining time — and
        // a stalled registry can never starve the fallbacks behind it.
        let candidateShareMs: number | undefined;
        let candidateDeadline: number | undefined;
        if (deadline !== undefined) {
          candidateShareMs = Math.max(
            1,
            Math.floor((deadline - Date.now()) / (candidates.length - candidateIndex)),
          );
          candidateDeadline = Math.min(Date.now() + candidateShareMs, deadline);
        }
        // Whether the most recent failed attempt's teed output ended with a
        // newline — read by the retry banner below, which runs outside the
        // block the pull result is scoped to.
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
            // A failed effect (rather than a non-zero exit, which returns a
            // value) means the container runtime could not be spawned at all —
            // a down daemon is caught earlier, by `hasLocalImage`'s own
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
          // Never sleep past this candidate's share — the backoff would spend
          // budget the remaining registries still need.
          if (candidateDeadline !== undefined && Date.now() + delay >= candidateDeadline) {
            break;
          }
          // Go prints a per-retry banner before sleeping:
          // `fmt.Fprintf(os.Stderr, "Retrying after %v: %s\n", period, image)` —
          // `%v` of the 4s/8s backoff `time.Duration` renders as `4s`/`8s`.
          // Go also `Fprintln`s the failed attempt's error just before the
          // banner; here the `docker pull` child's own
          // stderr — already teed live to the parent's stderr above — plays
          // that role. `Fprintln` always newline-terminates, so when the
          // child's final output didn't, add the `\n` ourselves — otherwise
          // the banner would glue onto the error text where Go prints two
          // lines.
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
        new LegacyDockerRunError({
          message: `failed to pull docker image from all registries: ${failures.join("; ")}`,
          reason: "pull",
          daemonDown: failures.some(legacyIsDockerDaemonUnreachable),
        }),
      );
    });
}
