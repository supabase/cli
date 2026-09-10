/**
 * Satellite-container lifecycle around a database recreate: the pre-teardown fence
 * ({@link withSatelliteServicesStopped}) and the post-recreate restart + Kong reload,
 * shared by both reset paths. Neither `db
 * start` nor `supabase start` calls any of this: it exists purely to keep the
 * satellite containers (storage/auth/realtime/pooler) out of the way of a `db`
 * container that is being recreated or force-restarted under them, to bring them back
 * afterwards, and to
 * reload Kong's nginx so its cached upstream addresses (which may have changed if a
 * satellite container came back on a different one) stop 502ing.
 */

import { Cause, Data, Effect, Option, Result } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";
import { Output } from "../../shared/output/output.service.ts";
import { aqua, yellow } from "../colors.ts";
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
 * Port of Go's `Docker.ContainerRestart(ctx, utils.DbId, container.StopOptions{})`
 * (`apps/cli-go/internal/db/reset/reset.go:218-220`), used ONLY by PG14's
 * `RestartDatabase` to restart the `db` container itself after `pg_terminate_backend`
 * (pg_cron must restart, per Go's own comment). Unlike the satellite restarts below,
 * this one does NOT tolerate "not found" — Go's own `RestartDatabase` has no
 * `errdefs.IsNotFound` guard on this call at all, so ANY failure is a hard
 * `failed to restart container: %w`.
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
 * One satellite service's `docker <action>`, tolerant of "not found" — a service
 * excluded from the stack (e.g. `[realtime] enabled = false`) has no container to act
 * on, and that's not an error. Never fails the surrounding `Effect.all` itself:
 * resolves `Option.some(message)` on a genuine failure so the caller can join every
 * service's outcome, and `Option.none()` on success OR a tolerated not-found.
 */
const satelliteServiceAction = (
  spawner: Spawner,
  action: "restart" | "stop" | "start",
  containerId: string,
): Effect.Effect<Option.Option<string>> =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawnContainerCli(spawner, [action, containerId], {
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
        `failed to ${action} ${containerId}: ${trimmed.length > 0 ? trimmed : `exit ${exitCode}`}`,
      );
    }),
  ).pipe(
    Effect.catch((cause) =>
      Effect.succeed(
        Option.some(`failed to ${action} ${containerId}: ${describeContainerCliFailure(cause)}`),
      ),
    ),
  );

/** One or more satellite-service stops, starts, or restarts failed. Messages are newline-joined. */
export class RestartServicesError extends Data.TaggedError("RestartServicesError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.startStack;
  }
}

/**
 * The services fenced and restarted around a database recreate. PostgREST is excluded:
 * it reconnects and re-reads the schema on its own. Analytics is excluded too — it does
 * re-run its migrations on every start, but against `_supabase`/`_analytics`, while every
 * fenced init job runs against `postgres`, so it cannot collide with them. This fence is
 * not an exhaustive stop of every migrating container, and does not claim to be.
 */
const satelliteContainerIds = (projectId: string): ReadonlyArray<string> => [
  serviceContainerName("storage", projectId),
  serviceContainerName("auth", projectId),
  serviceContainerName("realtime", projectId),
  serviceContainerName("pooler", projectId),
];

/** Runs one action across every satellite concurrently, joining each failure message into one newline-separated error. */
const satelliteServicesAction = (
  spawner: Spawner,
  action: "restart" | "stop" | "start",
  projectId: string,
): Effect.Effect<void, RestartServicesError> =>
  Effect.gen(function* () {
    const results = yield* Effect.all(
      satelliteContainerIds(projectId).map((containerId) =>
        satelliteServiceAction(spawner, action, containerId),
      ),
      { concurrency: "unbounded" },
    );
    const failures = results.filter(Option.isSome).map((result) => result.value);
    if (failures.length > 0) {
      return yield* Effect.fail(new RestartServicesError({ message: failures.join("\n") }));
    }
  });

/**
 * Runs `work` with the satellite containers stopped (#6445): a running storage/auth/
 * realtime re-runs ITS OWN migrations against `postgres` the moment it reconnects to
 * the recreated database, racing the one-shot init jobs that migrate the same database
 * and failing one of them with `error running container: exit 1`. Stopping first also disarms the
 * `unless-stopped` policy, so nothing crash-restarts back into the window.
 *
 * The restore covers the STOP as well as `work`: the four stops run concurrently and
 * are joined only after all of them settle, so one genuine failure — or a Ctrl-C
 * during the multi-second stop — would otherwise leave the others stopped for good
 * (a stop disarms `unless-stopped`, and `supabase start` treats a running db with
 * stopped satellites as "already running"). On success the caller's own
 * `restartServicesAndReloadKong` brings them back instead (`docker restart` starts a
 * stopped container). The restore reloads Kong too, since a container that stopped
 * and started can come back on a different address (#6016), and it warns rather than
 * failing: the caller's own error is the one worth reporting.
 */
export const withSatelliteServicesStopped = <A, E, R>(
  spawner: Spawner,
  projectId: string,
  work: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | RestartServicesError, R | Output> =>
  Effect.gen(function* () {
    const output = yield* Output;
    return yield* Effect.gen(function* () {
      yield* satelliteServicesAction(spawner, "stop", projectId);
      return yield* work;
    }).pipe(
      Effect.onError(() =>
        satelliteServicesAction(spawner, "start", projectId).pipe(
          Effect.andThen(reloadKong(spawner, projectId)),
          Effect.catchCause((cause) =>
            output.raw(
              `${yellow("WARNING:")} local services may still be stopped after the failed reset: ${Cause.pretty(cause)}\n`,
              "stderr",
            ),
          ),
        ),
      ),
    );
  });

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

/** Kong could not be reloaded — fails the WHOLE command (unlike `functions serve`'s best-effort reload). */
export class KongReloadError extends Data.TaggedError("KongReloadError")<{
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.startStack;
  }
}

/** `docker exec <id> <cmd...>`, combined stdout+stderr into one buffer — mirrors Go's shared `io.Writer` in `DockerExecOnceWithStream(ctx, KongId, "", nil, cmd, &out, &out)`. Never fails the Effect itself: a spawn failure (no docker/podman) folds into `exitCode: 1`. */
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
    yield* satelliteServicesAction(spawner, "restart", projectId);
    yield* reloadKong(spawner, projectId);
  });
}
