/**
 * Post-recreate satellite-container restart + Kong reload, shared by both PG14's and PG15's
 * `db reset` paths. Neither `db start` nor `supabase start` calls this: it exists purely to
 * bring the satellite containers (storage/auth/realtime/pooler) back in sync with a `db`
 * container that was just recreated or force-restarted out from under them, and to reload Kong's
 * nginx so its cached upstream addresses (which may have changed) stop 502ing.
 */

import { Data, Effect, Option, Result } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";
import { aqua } from "../colors.ts";
import {
  collectText,
  describeContainerCliFailure,
  isContainerNotFoundMessage,
  runContainerCliExpectSuccess,
  spawnContainerCli,
} from "../container-cli.ts";
import { inspectContainerState } from "../docker-lifecycle.ts";
import { serviceContainerName } from "../docker-ids.ts";

type Spawner = ChildProcessSpawner["Service"];

/** `docker restart <id>` (the db container itself) failed — used only by PG14's `RestartDatabase`. */
export class ContainerRestartError extends Data.TaggedError("ContainerRestartError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.startStack;
  }
}

/**
 * Restarts the `db` container itself, used only by PG14's reset path after
 * `pg_terminate_backend` (pg_cron must restart). Unlike the satellite restarts below, this does
 * not tolerate "not found" — any failure is a hard error.
 */
export function restartContainer(
  spawner: Spawner,
  containerId: string,
): Effect.Effect<void, ContainerRestartError> {
  return runContainerCliExpectSuccess(
    spawner,
    ["restart", containerId],
    "restart container",
    (message) => new ContainerRestartError({ message }),
  );
}

/**
 * One satellite service's restart, tolerant of "not found" — a service excluded from the stack
 * has no container to restart, and that's not an error. Never fails the surrounding `Effect.all`
 * itself: resolves `Option.some(message)` on a genuine failure so the caller can join every
 * service's outcome, and `Option.none()` on success or a tolerated not-found.
 */
const restartSatelliteService = (
  spawner: Spawner,
  containerId: string,
): Effect.Effect<Option.Option<string>> =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawnContainerCli(spawner, ["restart", containerId], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
      const [exitCode, stderr] = yield* Effect.all(
        [child.exitCode.pipe(Effect.map(Number)), collectText(child.stderr)],
        { concurrency: "unbounded" },
      );
      if (exitCode === 0) return Option.none();
      const trimmed = stderr.trim();
      if (isContainerNotFoundMessage(trimmed)) return Option.none();
      return Option.some(
        `failed to restart ${containerId}: ${trimmed.length > 0 ? trimmed : `exit ${exitCode}`}`,
      );
    }),
  ).pipe(
    Effect.catch((cause) =>
      Effect.succeed(
        Option.some(`failed to restart ${containerId}: ${describeContainerCliFailure(cause)}`),
      ),
    ),
  );

/** One or more satellite-service restarts failed. Messages are newline-joined, matching Go's `errors.Join`. */
export class RestartServicesError extends Data.TaggedError("RestartServicesError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.startStack;
  }
}

/**
 * Port of Go's `restartServices` restart half (`reset.go:227-239`): restarts
 * storage/auth/realtime/pooler CONCURRENTLY (Go's `utils.WaitAll`, a goroutine per
 * service) — NOT PostgREST, which "automatically reconnects and listens for schema
 * changes" (Go's own comment) — and does NOT wait for them to become healthy
 * afterward ("those services may be excluded from starting"). Every per-service
 * failure (excluding a tolerated not-found) is joined into one newline-separated
 * message, matching `errors.Join`. Not exported outside this module — only
 * {@link restartServicesAndReloadKong} calls this directly.
 */
function restartSatelliteServices(
  spawner: Spawner,
  projectId: string,
): Effect.Effect<void, RestartServicesError> {
  const containerIds = [
    serviceContainerName("storage", projectId),
    serviceContainerName("auth", projectId),
    serviceContainerName("realtime", projectId),
    serviceContainerName("pooler", projectId),
  ];
  return Effect.gen(function* () {
    const results = yield* Effect.all(
      containerIds.map((containerId) => restartSatelliteService(spawner, containerId)),
      { concurrency: "unbounded" },
    );
    const failures = results.filter(Option.isSome).map((result) => result.value);
    if (failures.length > 0) {
      return yield* Effect.fail(new RestartServicesError({ message: failures.join("\n") }));
    }
  });
}

/**
 * Gateway-recovery hint, byte-matching Go's `suggestKongRecovery`
 * (`reset.go:281-288`): rendered as a `Suggestion:` line by `Output.fail`, mirroring
 * `utils.CmdSuggestion`.
 */
function kongRecoverySuggestion(kongId: string): string {
  return (
    "Local services restarted, but API routes may return 502 until the gateway reloads.\n" +
    `Try restarting it with ${aqua(`docker restart ${kongId}`)}, and check ${aqua(
      `docker logs ${kongId}`,
    )} if the failure persists.`
  );
}

/** Kong could not be reloaded — fails the whole command (unlike `functions serve`'s best-effort reload). */
export class KongReloadError extends Data.TaggedError("KongReloadError")<{
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.startStack;
  }
}

/** `docker exec <id> <cmd...>`, combined stdout+stderr into one buffer. Never fails the Effect itself: a spawn failure (no docker/podman) folds into `exitCode: 1`. */
function execCaptureCombined(
  spawner: Spawner,
  containerId: string,
  cmd: ReadonlyArray<string>,
): Effect.Effect<{ readonly exitCode: number; readonly output: string }> {
  return Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawnContainerCli(spawner, ["exec", containerId, ...cmd], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = yield* Effect.all(
        [
          child.exitCode.pipe(Effect.map(Number)),
          collectText(child.stdout),
          collectText(child.stderr),
        ],
        { concurrency: "unbounded" },
      );
      return { exitCode, output: stdout + stderr };
    }),
  ).pipe(
    Effect.catch((cause) =>
      Effect.succeed({ exitCode: 1, output: describeContainerCliFailure(cause) }),
    ),
  );
}

/**
 * Port of Go's `reloadKong` (`reset.go:253-276`): inspect Kong's container — not
 * found means Kong is excluded from the stack (`return nil`, not an error); any OTHER
 * inspect failure is wrapped with the recovery suggestion; not running means there's
 * no stale cache to flush (`return nil`); otherwise `docker exec <kongId> kong reload
 * --nginx-conf /home/kong/custom_nginx.template` (the flag is required — a bare
 * `kong reload` regenerates nginx.conf from Kong's default template and drops the
 * custom `email_templates` server, reintroducing #6059), failing hard (with the same
 * suggestion) on a non-zero exit, the combined output appended when non-empty. Not
 * exported outside this module — only {@link restartServicesAndReloadKong}
 * calls this directly.
 */
function reloadKong(spawner: Spawner, projectId: string): Effect.Effect<void, KongReloadError> {
  const kongId = serviceContainerName("kong", projectId);
  return Effect.gen(function* () {
    const inspected = yield* inspectContainerState(spawner, kongId).pipe(Effect.result);
    if (Result.isFailure(inspected)) {
      if (isContainerNotFoundMessage(inspected.failure.message)) return;
      return yield* Effect.fail(
        new KongReloadError({
          message: `failed to inspect kong: ${inspected.failure.message}`,
          suggestion: kongRecoverySuggestion(kongId),
        }),
      );
    }
    if (!inspected.success.running) return;
    const result = yield* execCaptureCombined(spawner, kongId, [
      "kong",
      "reload",
      "--nginx-conf",
      "/home/kong/custom_nginx.template",
    ]);
    if (result.exitCode !== 0) {
      const trimmed = result.output.trim();
      // Go's `DockerExecOnceWithStream` (`utils/docker.go:646-648`) sets a FIXED constant
      // error, `errors.New("error executing command")`, for `iresp.ExitCode > 0` — not the
      // exit code itself. `reloadKong` then wraps it as `failed to reload kong: %w[:\n%s]`
      // (`reset.go:269-274`), so the `%w` slot is always this exact string, never `exit N`.
      return yield* Effect.fail(
        new KongReloadError({
          message:
            trimmed.length > 0
              ? `failed to reload kong: error executing command:\n${trimmed}`
              : "failed to reload kong: error executing command",
          suggestion: kongRecoverySuggestion(kongId),
        }),
      );
    }
  });
}

/**
 * Port of Go's `restartServices` (`reset.go:227-241`): the satellite restarts above,
 * then {@link reloadKong} — ONLY when every restart succeeded (Go returns the
 * joined restart error immediately, without ever attempting the Kong reload).
 */
export function restartServicesAndReloadKong(
  spawner: Spawner,
  projectId: string,
): Effect.Effect<void, RestartServicesError | KongReloadError> {
  return Effect.gen(function* () {
    yield* restartSatelliteServices(spawner, projectId);
    yield* reloadKong(spawner, projectId);
  });
}
