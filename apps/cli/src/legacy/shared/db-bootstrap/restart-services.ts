/**
 * Post-recreate satellite-container restart + Kong reload, shared by both PG14's
 * `RestartDatabase` and PG15's `resetDatabase15` (`apps/cli-go/internal/db/reset/
 * reset.go:214-288`) — the ONLY two Go call sites of `restartServices`. Neither `db
 * start` nor `supabase start` calls any of this: it exists purely to bring the
 * satellite containers (storage/auth/realtime/pooler) back in sync with a `db`
 * container that was just recreated or force-restarted out from under them, and to
 * reload Kong's nginx so its cached upstream addresses (which may have changed if a
 * satellite container came back on a different one) stop 502ing.
 */

import { Data, Effect, Option, Result } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";
import { legacyAqua } from "../legacy-colors.ts";
import {
  legacyCollectText,
  legacyDescribeContainerCliFailure,
  legacyIsContainerNotFoundMessage,
  legacyRunContainerCliExpectSuccess,
  spawnContainerCli,
} from "../legacy-container-cli.ts";
import { legacyInspectContainerState } from "../legacy-docker-lifecycle.ts";
import { legacyServiceContainerName } from "../legacy-docker-ids.ts";

type Spawner = ChildProcessSpawner["Service"];

/** `docker restart <id>` (the db container itself) failed — used only by PG14's `RestartDatabase`. */
export class LegacyContainerRestartError extends Data.TaggedError("LegacyContainerRestartError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.startStack;
  }
}

/**
 * Port of Go's `Docker.ContainerRestart(ctx, utils.DbId, container.StopOptions{})`
 * (`apps/cli-go/internal/db/reset/reset.go:218-220`), used ONLY by PG14's
 * `RestartDatabase` to restart the `db` container itself after `pg_terminate_backend`
 * (pg_cron must restart, per Go's own comment). Unlike the satellite restarts below,
 * this one does NOT tolerate "not found" — Go's own `RestartDatabase` has no
 * `errdefs.IsNotFound` guard on this call at all, so ANY failure is a hard
 * `failed to restart container: %w`.
 */
export function legacyRestartContainer(
  spawner: Spawner,
  containerId: string,
): Effect.Effect<void, LegacyContainerRestartError> {
  return legacyRunContainerCliExpectSuccess(
    spawner,
    ["restart", containerId],
    "restart container",
    (message) => new LegacyContainerRestartError({ message }),
  );
}

/**
 * One satellite service's restart, tolerant of "not found" (Go's `!errdefs.IsNotFound(err)`
 * guard, `reset.go:231`) — a service excluded from the stack (e.g. `[realtime] enabled =
 * false`) has no container to restart, and that's not an error. Never fails the surrounding
 * `Effect.all` itself: resolves `Option.some(message)` on a genuine failure so the caller
 * can join every service's outcome the way Go's `errors.Join(result...)` does, and
 * `Option.none()` on success OR a tolerated not-found.
 */
const legacyRestartSatelliteService = (
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
        [child.exitCode.pipe(Effect.map(Number)), legacyCollectText(child.stderr)],
        { concurrency: "unbounded" },
      );
      if (exitCode === 0) return Option.none();
      const trimmed = stderr.trim();
      if (legacyIsContainerNotFoundMessage(trimmed)) return Option.none();
      return Option.some(
        `failed to restart ${containerId}: ${trimmed.length > 0 ? trimmed : `exit ${exitCode}`}`,
      );
    }),
  ).pipe(
    Effect.catch((cause) =>
      Effect.succeed(
        Option.some(
          `failed to restart ${containerId}: ${legacyDescribeContainerCliFailure(cause)}`,
        ),
      ),
    ),
  );

/** One or more satellite-service restarts failed. Messages are newline-joined, matching Go's `errors.Join`. */
export class LegacyRestartServicesError extends Data.TaggedError("LegacyRestartServicesError")<{
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
 * {@link legacyRestartServicesAndReloadKong} calls this directly.
 */
function legacyRestartSatelliteServices(
  spawner: Spawner,
  projectId: string,
): Effect.Effect<void, LegacyRestartServicesError> {
  const containerIds = [
    legacyServiceContainerName("storage", projectId),
    legacyServiceContainerName("auth", projectId),
    legacyServiceContainerName("realtime", projectId),
    legacyServiceContainerName("pooler", projectId),
  ];
  return Effect.gen(function* () {
    const results = yield* Effect.all(
      containerIds.map((containerId) => legacyRestartSatelliteService(spawner, containerId)),
      { concurrency: "unbounded" },
    );
    const failures = results.filter(Option.isSome).map((result) => result.value);
    if (failures.length > 0) {
      return yield* Effect.fail(new LegacyRestartServicesError({ message: failures.join("\n") }));
    }
  });
}

/**
 * Gateway-recovery hint, byte-matching Go's `suggestKongRecovery`
 * (`reset.go:281-288`): rendered as a `Suggestion:` line by `Output.fail`, mirroring
 * `utils.CmdSuggestion`.
 */
function legacyKongRecoverySuggestion(kongId: string): string {
  return (
    "Local services restarted, but API routes may return 502 until the gateway reloads.\n" +
    `Try restarting it with ${legacyAqua(`docker restart ${kongId}`)}, and check ${legacyAqua(
      `docker logs ${kongId}`,
    )} if the failure persists.`
  );
}

/** Kong could not be reloaded — fails the WHOLE command (unlike `functions serve`'s best-effort reload). */
export class LegacyKongReloadError extends Data.TaggedError("LegacyKongReloadError")<{
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.startStack;
  }
}

/** `docker exec <id> <cmd...>`, combined stdout+stderr into one buffer — mirrors Go's shared `io.Writer` in `DockerExecOnceWithStream(ctx, KongId, "", nil, cmd, &out, &out)`. Never fails the Effect itself: a spawn failure (no docker/podman) folds into `exitCode: 1`. */
function legacyExecCaptureCombined(
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
          legacyCollectText(child.stdout),
          legacyCollectText(child.stderr),
        ],
        { concurrency: "unbounded" },
      );
      return { exitCode, output: stdout + stderr };
    }),
  ).pipe(
    Effect.catch((cause) =>
      Effect.succeed({ exitCode: 1, output: legacyDescribeContainerCliFailure(cause) }),
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
 * exported outside this module — only {@link legacyRestartServicesAndReloadKong}
 * calls this directly.
 */
function legacyReloadKong(
  spawner: Spawner,
  projectId: string,
): Effect.Effect<void, LegacyKongReloadError> {
  const kongId = legacyServiceContainerName("kong", projectId);
  return Effect.gen(function* () {
    const inspected = yield* legacyInspectContainerState(spawner, kongId).pipe(Effect.result);
    if (Result.isFailure(inspected)) {
      if (legacyIsContainerNotFoundMessage(inspected.failure.message)) return;
      return yield* Effect.fail(
        new LegacyKongReloadError({
          message: `failed to inspect kong: ${inspected.failure.message}`,
          suggestion: legacyKongRecoverySuggestion(kongId),
        }),
      );
    }
    if (!inspected.success.running) return;
    const result = yield* legacyExecCaptureCombined(spawner, kongId, [
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
        new LegacyKongReloadError({
          message:
            trimmed.length > 0
              ? `failed to reload kong: error executing command:\n${trimmed}`
              : "failed to reload kong: error executing command",
          suggestion: legacyKongRecoverySuggestion(kongId),
        }),
      );
    }
  });
}

/**
 * Port of Go's `restartServices` (`reset.go:227-241`): the satellite restarts above,
 * then {@link legacyReloadKong} — ONLY when every restart succeeded (Go returns the
 * joined restart error immediately, without ever attempting the Kong reload).
 */
export function legacyRestartServicesAndReloadKong(
  spawner: Spawner,
  projectId: string,
): Effect.Effect<void, LegacyRestartServicesError | LegacyKongReloadError> {
  return Effect.gen(function* () {
    yield* legacyRestartSatelliteServices(spawner, projectId);
    yield* legacyReloadKong(spawner, projectId);
  });
}
