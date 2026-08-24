import { BunServices } from "@effect/platform-bun";
import { Cause, Clock, Data, Duration, Effect, Layer } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { ChildProcessSpawner as ChildProcessSpawnerTag } from "effect/unstable/process/ChildProcessSpawner";

import { legacyMakeDockerImageResolver } from "../../src/legacy/shared/legacy-docker-image-resolve.ts";

type Spawner = ChildProcessSpawnerTag["Service"];

// Overall per-image ceiling. Deliberately BELOW the tightest e2e test budget
// (120s): a stalled registry must leave the caller room to run its test body.
export const RESOLVE_BUDGET_MS = 90_000;

export class DockerImageResolutionError extends Data.TaggedError("DockerImageResolutionError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const resolvedImages = new Map<string, Promise<string>>();

/**
 * Serializes distinct-image resolution. The helper this replaced spawned
 * synchronously, so a `Promise.all` over several images was serialized whether
 * the caller meant it or not — and `serve-main-offline.e2e.test.ts` resolves
 * two images exactly that way. Letting them run concurrently would put two cold
 * pulls against the same registry at the same instant, which is the
 * `toomanyrequests` failure this helper exists to avoid, so the old ordering is
 * preserved deliberately rather than by accident.
 */
let resolveQueue: Promise<unknown> = Promise.resolve();

/**
 * Resolves an image for a raw e2e `docker run`/`docker pull` by running the
 * PRODUCTION resolver (`legacyMakeDockerImageResolver`) against a real
 * subprocess spawner — same candidate order, same local-cache-first check, same
 * retry ladder the CLI itself uses, so this can never drift from it. A raw
 * `docker run` of an uncached image implicit-pulls from a single registry,
 * where CI regularly fails with `toomanyrequests: Rate exceeded`; resolving
 * first lets the ECR → GHCR → Docker Hub fallback do its job.
 *
 * Returns the resolved reference the caller must use in its own docker argv.
 * Results (including failures) are memoized per process so parallel/subsequent
 * tests never re-pay the retry ladder.
 *
 * `deadline` bounds the resolve, but only for a subprocess that exits when
 * asked: the spawner's release sends one SIGTERM and then awaits the child, and
 * `forceKillAfter` does not change that — it races the signal call, not the
 * wait. A `docker` CLI that ignored SIGTERM outright could still outlast the
 * budget. Real ones don't, and the ceiling still covers what it was added for:
 * a registry that is slow rather than wedged.
 */
export function ensureImage(
  image: string,
  deadline?: number,
  // Injectable so the queue/memo behavior is unit-testable with a fake spawner;
  // every e2e caller uses the real default.
  services: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> = BunServices.layer,
): Promise<string> {
  const memo = resolvedImages.get(image);
  if (memo !== undefined) return memo;
  const resolving = resolveQueue.then(() =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // A defaulted deadline is stamped when this image's turn STARTS, not when
      // the caller enqueued it — otherwise time spent waiting behind another
      // image's resolution would silently shrink this one's window. An explicit
      // deadline is shared budget by contract and is left exactly as given.
      return yield* resolveImage(spawner, image, deadline ?? resolveDeadline());
    }).pipe(Effect.provide(services), Effect.runPromise),
  );
  // Both the queue link and the memo swallow nothing: callers still see the
  // rejection, this only stops one failure from becoming an unhandled rejection
  // or wedging the queue for the next image.
  resolveQueue = resolving.catch(() => undefined);
  resolving.catch(() => undefined);
  resolvedImages.set(image, resolving);
  return resolving;
}

/**
 * One deadline for a whole test's image setup: pass the same value to every
 * `ensureImage` call so multi-image tests pay at most one budget in total.
 * Callers with roomier test timeouts can size the budget to their own setup
 * window.
 */
export function resolveDeadline(budgetMs = RESOLVE_BUDGET_MS): number {
  return Effect.runSync(Clock.currentTimeMillis) + budgetMs;
}

/**
 * The production resolver spawns through `spawnContainerCli`, which falls back
 * to podman when docker is absent — but every caller then runs raw `docker`
 * argv, so an image pulled by podman would be invisible to the command under
 * test. Assert the docker CLI itself is present, turning that into one clear
 * failure instead of a confusing "docker: command not found" several steps on.
 * Deliberately a client-only probe: an unreachable daemon is a different
 * condition that the resolver already reports with its own message.
 */
function requireDocker(spawner: Spawner): Effect.Effect<void, DockerImageResolutionError> {
  return spawner.exitCode(ChildProcess.make("docker", ["--version"])).pipe(
    Effect.mapError(
      (cause) =>
        new DockerImageResolutionError({
          message: "docker is required for this test but could not be spawned",
          cause,
        }),
    ),
    Effect.filterOrFail(
      (exitCode) => Number(exitCode) === 0,
      () =>
        new DockerImageResolutionError({
          message: "docker is required for this test but exited non-zero",
        }),
    ),
    Effect.asVoid,
  );
}

/**
 * The resolve itself, taking its spawner explicitly so unit tests can drive it
 * with a fake instead of a real Docker daemon.
 */
export function resolveImage(
  spawner: Spawner,
  image: string,
  deadline: number,
): Effect.Effect<string, DockerImageResolutionError> {
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const remainingMs = Math.max(1, deadline - now);
    return yield* requireDocker(spawner).pipe(
      // The deadline goes INTO the resolver, which divides it across the
      // registry candidates — a stalled registry cannot starve the ECR → GHCR →
      // Docker Hub fallbacks behind it, and an exhausted share is reported
      // against the candidate that spent it. The outer timeout is only a
      // backstop for the paths the resolver does not bound (a wedged daemon
      // hanging `docker image inspect`); its 1s grace keeps the resolver's own
      // richer per-candidate error winning every race it can.
      Effect.andThen(() => legacyMakeDockerImageResolver(spawner, {})(image, deadline)),
      Effect.timeout(Duration.millis(remainingMs + 1_000)),
      Effect.mapError((cause) => {
        if (Cause.isTimeoutError(cause)) {
          return new DockerImageResolutionError({
            message: `timed out resolving ${image} after ${remainingMs}ms — is the docker daemon responding?`,
            cause,
          });
        }
        // The registry-pin hint only helps when the registries themselves were
        // the problem; gluing it onto a missing binary or an unreachable daemon
        // would misdirect the CI triage this helper exists to speed up.
        const hint = cause.message.includes("failed to pull docker image from all registries")
          ? " (set SUPABASE_INTERNAL_IMAGE_REGISTRY to pin one)"
          : "";
        return new DockerImageResolutionError({
          message: `failed to resolve ${image}${hint}: ${cause.message}`,
          cause,
        });
      }),
    );
  });
}
