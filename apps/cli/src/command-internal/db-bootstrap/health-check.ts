/**
 * A single shared probe across every still-unhealthy started container, on a 1-second constant
 * backoff for up to `timeoutSeconds` retries — not independent per-container timers. Each tick
 * narrows the "still watching" set to just the containers that failed this round, and only the
 * final timeout's failures surface to the caller.
 */

import { Data, Duration, Effect, Schedule, Stream } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";
import { spawnContainerCliWithRuntime, type ContainerRuntime } from "../container-cli.ts";
import { DbConnection, type PgConnInput } from "../db-connection.service.ts";
import { inspectContainerState } from "../docker-lifecycle.ts";
import { kongAuthHeaders } from "../kong-auth.ts";

type Spawner = ChildProcessSpawner["Service"];

/** Default retry budget when the caller doesn't specify one. */
const HEALTH_CHECK_TIMEOUT_SECONDS = 30;

/** Caps a single HTTP readiness probe so a hung response cannot stall the retry loop. */
const HTTP_PROBE_TIMEOUT_SECONDS = 10;

/** PostgREST does not support native Docker healthchecks. */
const POSTGREST_READY_PATH = "/rest-admin/v1/ready";

/**
 * Edge Runtime also bypasses its native Docker healthcheck (too noisy) and goes through the
 * same {@link checkHttpReady}/Kong-gateway path as PostgREST — hence
 * {@link HealthCheckPostgrestGateway}'s generic shape being reused for both
 * {@link WaitForHealthyServicesOptions.postgrest} and {@link WaitForHealthyServicesOptions.edgeRuntime}.
 */
const EDGE_RUNTIME_READY_PATH = "/functions/v1/_internal/health";

/** Identifies a single container's readiness failure this round. */
export interface HealthCheckFailure {
  /**
   * The container name (`supabase_<service>_<project id>`), not the opaque id `docker create`
   * returns — only the name tells a user which service failed.
   */
  readonly containerId: string;
  readonly reason: string;
}

/** Runtime-internal probe sentinel; exported only for the exhaustive actionability guard. */
class HealthCheckProbeError extends Data.TaggedError("HealthCheckProbeError")<{
  readonly failures: ReadonlyArray<HealthCheckFailure>;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.startStack;
  }
}

/** The retry loop's final, and only surfaced, failure. */
export class HealthCheckTimeoutError extends Data.TaggedError("HealthCheckTimeoutError")<{
  readonly message: string;
  readonly unhealthy: ReadonlyArray<HealthCheckFailure>;
  /**
   * Kept out of {@link message} so `Output.fail` renders it unstyled and drops the generic
   * "rerun with --debug" line: once an exact command is named, pointing at an HTTP request
   * logger is a non-sequitur.
   */
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.startStack;
  }
}

/**
 * PostgREST's local Kong gateway coordinates. TLS/CA trust for a local https gateway is the
 * caller's responsibility when composing the `HttpClient.HttpClient` layer this module requires
 * — when `api.tls.enabled`, the caller resolves the local Kong CA and overrides the HTTP client
 * around the health-check call, so `checkHttpReady` trusts it instead of exhausting the full
 * retry budget on a TLS verification failure.
 */
export interface HealthCheckPostgrestGateway {
  readonly containerId: string;
  readonly apiExternalUrl: string;
  readonly secretKey: string;
}

export interface WaitForHealthyServicesOptions {
  readonly timeoutSeconds?: number;
  readonly postgrest?: HealthCheckPostgrestGateway;
  /** Reuses {@link postgrest}'s gateway shape; see {@link EDGE_RUNTIME_READY_PATH}. */
  readonly edgeRuntime?: HealthCheckPostgrestGateway;
  /** Each watched container's already-resolved image, keyed by container name. */
  readonly images?: ReadonlyMap<string, string>;
}

/** The container runtime's message when an image cannot be executed by the host kernel. */
const EXEC_FORMAT_ERROR = "exec format error";

/**
 * Scans a byte stream for {@link EXEC_FORMAT_ERROR} in constant memory:
 * retaining the trailing marker-length window is exactly enough to match a
 * marker split across a chunk boundary. One scanner per stream, so stdout and
 * stderr bytes cannot splice into a marker neither stream contains.
 */
function makeExecFormatScanner() {
  const decoder = new TextDecoder();
  let tail = "";
  let found = false;
  return {
    scan(chunk: Uint8Array): void {
      const text = tail + decoder.decode(chunk, { stream: true });
      found ||= text.includes(EXEC_FORMAT_ERROR);
      tail = text.slice(-EXEC_FORMAT_ERROR.length);
    },
    get found(): boolean {
      return found;
    },
  };
}

/**
 * Recovery advice for a timeout whose logs showed {@link EXEC_FORMAT_ERROR}, or `undefined` when
 * no affected image can be named.
 *
 * `supabase stop` leads the sequence because a bare restart is a no-op on the
 * `--ignore-health-check` path, which leaves the stack up by design. `runtime` (not a hardcoded
 * `docker`) accounts for a Podman-only host. The closing line covers what re-pulling cannot fix:
 * a pinned image with no build for this host's architecture.
 */
function execFormatRecoveryHint(
  containerIds: ReadonlyArray<string>,
  images: ReadonlyMap<string, string> | undefined,
  runtime: ContainerRuntime,
): string | undefined {
  // Both names, always: `supabase_inbucket_*` runs `mailpit`, so naming only the container would
  // leave the reader guessing whether this is the same failure as the reason above.
  const affected = containerIds.flatMap((containerId) => {
    const image = images?.get(containerId);
    return image === undefined ? [] : [{ containerId, image }];
  });
  if (affected.length === 0) return undefined;
  const uniqueImages = [...new Set(affected.map((entry) => entry.image))];
  return [
    `${affected.map((entry) => `${entry.containerId}'s image ${entry.image}`).join(", ")} could not be executed ("${EXEC_FORMAT_ERROR}").`,
    "Either the cached copy is corrupt, or it was built for a different architecture.",
    "Remove the cached copy and start again, from this project directory or with the same --workdir:",
    `\n  supabase stop\n  ${runtime} image rm -f ${uniqueImages.join(" ")}\n  supabase start\n`,
    "If it fails the same way, that image has no build for this machine's architecture.",
  ].join("\n");
}

/** Not-running/not-ready gating, via the same {@link inspectContainerState} primitive `status.handler.ts` uses. */
function checkContainerReady(spawner: Spawner, containerId: string): Effect.Effect<void, string> {
  return inspectContainerState(spawner, containerId).pipe(
    Effect.mapError((cause) => cause.message),
    Effect.flatMap((state) => {
      if (!state.running) {
        return Effect.fail(`container is not running: ${state.status}`);
      }
      if (state.health !== undefined && state.health !== "healthy") {
        return Effect.fail(`container is not ready: ${state.health}`);
      }
      return Effect.void;
    }),
  );
}

/** An HTTP HEAD through the local Kong gateway, expecting exactly 200. */
function checkHttpReady(
  gateway: HealthCheckPostgrestGateway,
  path: string,
): Effect.Effect<void, string, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.head(`${gateway.apiExternalUrl}${path}`).pipe(
      HttpClientRequest.setHeaders(kongAuthHeaders(gateway.secretKey)),
    );
    const response = yield* httpClient.execute(request).pipe(
      Effect.timeout(`${HTTP_PROBE_TIMEOUT_SECONDS} seconds`),
      Effect.mapError((cause) => String(cause)),
    );
    if (response.status !== 200) {
      return yield* Effect.fail(`unexpected status ${response.status}`);
    }
  });
}

/**
 * `docker logs <id>`, teed to this process's stderr. Best-effort: a failure to stream logs must
 * never mask the timeout error it was printed alongside, so every failure here is swallowed.
 *
 * Resolves to whether the logs contained {@link EXEC_FORMAT_ERROR}, scanned off the bytes already
 * being teed, and to the runtime that answered, so recovery advice can name the right binary.
 */
function streamContainerLogsOnce(
  spawner: Spawner,
  containerId: string,
): Effect.Effect<ExecFormatScanResult> {
  // Outside the effect that can fail, so a stream breaking mid-dump cannot
  // discard a marker the scanner has already seen.
  const stdoutScanner = makeExecFormatScanner();
  const stderrScanner = makeExecFormatScanner();
  let runtime: ContainerRuntime | undefined;
  return Effect.scoped(
    Effect.gen(function* () {
      const spawned = yield* spawnContainerCliWithRuntime(spawner, ["logs", containerId], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      runtime = spawned.runtime;
      const handle = spawned.handle;
      yield* Effect.all(
        [
          Stream.runForEach(handle.stdout, (chunk) =>
            Effect.sync(() => {
              globalThis.process.stderr.write(chunk);
              stdoutScanner.scan(chunk);
            }),
          ),
          Stream.runForEach(handle.stderr, (chunk) =>
            Effect.sync(() => {
              globalThis.process.stderr.write(chunk);
              stderrScanner.scan(chunk);
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      yield* handle.exitCode;
    }),
  ).pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.map(() => ({ found: stdoutScanner.found || stderrScanner.found, runtime })),
  );
}

/** What one container's log dump learned, beyond the bytes it teed to stderr. */
interface ExecFormatScanResult {
  readonly found: boolean;
  /** `undefined` only when neither runtime could be spawned at all. */
  readonly runtime: ContainerRuntime | undefined;
}

/** Prints "<containerId> container logs:" then dumps the container's logs. */
function dumpContainerLogs(
  spawner: Spawner,
  containerId: string,
): Effect.Effect<ExecFormatScanResult> {
  return Effect.gen(function* () {
    yield* Effect.sync(() => {
      globalThis.process.stderr.write(`${containerId} container logs:\n`);
    });
    return yield* streamContainerLogsOnce(spawner, containerId);
  });
}

/**
 * Waits for every container in `containerIds` to become ready. Resolves once all are ready;
 * fails with {@link HealthCheckTimeoutError} (carrying every still-unhealthy container's
 * last-seen reason) once the retry budget is exhausted. The caller decides whether
 * `--ignore-health-check` turns that failure into a warning instead of a hard exit.
 */
export function waitForHealthyServices(
  spawner: Spawner,
  containerIds: ReadonlyArray<string>,
  opts: WaitForHealthyServicesOptions = {},
): Effect.Effect<void, HealthCheckTimeoutError, HttpClient.HttpClient> {
  const timeoutSeconds = opts.timeoutSeconds ?? HEALTH_CHECK_TIMEOUT_SECONDS;
  const postgrest = opts.postgrest;
  const edgeRuntime = opts.edgeRuntime;

  const checkOne = (containerId: string): Effect.Effect<void, string, HttpClient.HttpClient> => {
    if (postgrest !== undefined && containerId === postgrest.containerId) {
      return checkHttpReady(postgrest, POSTGREST_READY_PATH);
    }
    if (edgeRuntime !== undefined && containerId === edgeRuntime.containerId) {
      return checkHttpReady(edgeRuntime, EDGE_RUNTIME_READY_PATH);
    }
    return checkContainerReady(spawner, containerId);
  };

  return Effect.gen(function* () {
    let stillWatching = containerIds;

    // Each round narrows `stillWatching` to just the containers that failed, so a container
    // that becomes healthy mid-run stops being probed on later rounds.
    const probe: Effect.Effect<void, HealthCheckProbeError, HttpClient.HttpClient> = Effect.gen(
      function* () {
        const outcomes = yield* Effect.forEach(
          stillWatching,
          (containerId) =>
            checkOne(containerId).pipe(
              Effect.match({
                onFailure: (reason): HealthCheckFailure | undefined => ({
                  containerId,
                  reason,
                }),
                onSuccess: (): HealthCheckFailure | undefined => undefined,
              }),
            ),
          { concurrency: 1 },
        );
        const failures = outcomes.filter(
          (outcome): outcome is HealthCheckFailure => outcome !== undefined,
        );
        stillWatching = failures.map((failure) => failure.containerId);
        if (failures.length > 0) {
          return yield* Effect.fail(new HealthCheckProbeError({ failures }));
        }
      },
    );

    // A 1-second constant delay, capped at `timeoutSeconds` retries after the initial attempt.
    const schedule = Schedule.max([Schedule.spaced("1 seconds"), Schedule.recurs(timeoutSeconds)]);

    yield* probe.pipe(
      Effect.retry(schedule),
      Effect.catch((probeError) =>
        Effect.gen(function* () {
          // An interrupted fiber never reaches this `Effect.catch` handler, so no separate
          // cancellation check is needed here.
          const scans = yield* Effect.forEach(probeError.failures, (failure) =>
            dumpContainerLogs(spawner, failure.containerId).pipe(
              Effect.map((scan) => ({ ...scan, containerId: failure.containerId })),
            ),
          );
          const execFormatErrors = scans
            .filter((scan) => scan.found)
            .map((scan) => scan.containerId);
          const suggestion = execFormatRecoveryHint(
            execFormatErrors,
            opts.images,
            scans.find((scan) => scan.runtime !== undefined)?.runtime ?? "docker",
          );
          return yield* Effect.fail(
            new HealthCheckTimeoutError({
              message: probeError.failures
                .map((failure) => `${failure.containerId} ${failure.reason}`)
                .join("\n"),
              unhealthy: probeError.failures,
              ...(suggestion === undefined ? {} : { suggestion }),
            }),
          );
        }),
      ),
    );
  });
}

/** Caps a hung dial so one probe cannot swallow the whole poll budget. */
const SHADOW_READY_CONNECT_TIMEOUT_SECONDS = 2;

/**
 * One round's verdict. `fatal` makes an exited container fail fast instead of burning the
 * remaining budget: nothing about a dead container can change on a later round.
 */
interface ShadowReadyFailure {
  readonly reason: string;
  readonly fatal: boolean;
}

const shadowNotReady = (reason: string): ShadowReadyFailure => ({
  reason,
  fatal: false,
});

/**
 * A single short-lived connect attempt, dialled the same way `connectShadowDatabase` does (same
 * `isLocal`/`dnsResolver` pair), so a config that authenticates for the probe authenticates for
 * the real connection too. `Effect.scoped` closes the session the moment the probe resolves; the
 * caller opens its own connection afterwards.
 */
const probeShadowConnect = (
  connConfig: PgConnInput,
): Effect.Effect<void, ShadowReadyFailure, DbConnection> =>
  Effect.scoped(
    Effect.gen(function* () {
      const dbConnection = yield* DbConnection;
      yield* dbConnection.connect(
        { ...connConfig, connectTimeoutSeconds: SHADOW_READY_CONNECT_TIMEOUT_SECONDS },
        { isLocal: true, dnsResolver: "native" },
      );
    }),
  ).pipe(Effect.mapError((cause) => shadowNotReady(cause.message)));

export interface WaitForShadowReadyOptions {
  readonly timeoutSeconds?: number;
  /** The shadow container's already-resolved postgres image, named in the exec-format recovery hint. */
  readonly image?: string;
}

/**
 * Shadow readiness: inspect + connect probe, polled every 500ms. Docker's
 * healthcheck is `interval=10s` with no start period, so Postgres is connectable
 * ~6.5s before `Health.Status` flips. Same error shape as the health gate,
 * plus a wall-clock cap so a hung 2s dial cannot overrun the retry budget.
 */
export function waitForShadowReady(
  spawner: Spawner,
  containerId: string,
  connConfig: PgConnInput,
  opts: WaitForShadowReadyOptions = {},
): Effect.Effect<void, HealthCheckTimeoutError, DbConnection> {
  const timeoutSeconds = opts.timeoutSeconds ?? HEALTH_CHECK_TIMEOUT_SECONDS;

  // Twice the second-counted budget: 500ms spacing would otherwise exhaust `timeoutSeconds`
  // retries in half the wall time of a 1-second poll.
  const schedule = Schedule.max([
    Schedule.spaced("500 millis"),
    Schedule.recurs(timeoutSeconds * 2),
  ]);
  const boundSeconds = timeoutSeconds + SHADOW_READY_CONNECT_TIMEOUT_SECONDS;

  // Per-evaluation state: the retry rounds within one evaluation share the latest failure for
  // the timeout diagnostic, while re-evaluating the returned Effect starts from a fresh slot.
  return Effect.suspend(() => {
    let lastFailure: ShadowReadyFailure | undefined;

    const probe: Effect.Effect<void, ShadowReadyFailure, DbConnection> = Effect.gen(function* () {
      const state = yield* inspectContainerState(spawner, containerId).pipe(
        Effect.mapError((cause) => shadowNotReady(cause.message)),
      );
      if (!state.running) {
        return yield* Effect.fail({
          reason: `container is not running: ${state.status}`,
          fatal: true,
        });
      }
      yield* probeShadowConnect(connConfig);
    }).pipe(
      Effect.tapError((failure) =>
        Effect.sync(() => {
          lastFailure = failure;
        }),
      ),
    );

    return probe.pipe(
      Effect.retry({ schedule, while: (failure) => !failure.fatal }),
      Effect.timeoutOrElse({
        duration: Duration.seconds(boundSeconds),
        orElse: () =>
          Effect.fail(
            lastFailure ??
              shadowNotReady(`not ready after ${boundSeconds}s: connection attempt hung`),
          ),
      }),
      Effect.catch((failure) =>
        Effect.gen(function* () {
          const scan = yield* dumpContainerLogs(spawner, containerId);
          const suggestion =
            scan.found && opts.image !== undefined
              ? execFormatRecoveryHint(
                  [containerId],
                  new Map([[containerId, opts.image]]),
                  scan.runtime ?? "docker",
                )
              : undefined;
          return yield* Effect.fail(
            new HealthCheckTimeoutError({
              message: `${containerId} ${failure.reason}`,
              unhealthy: [{ containerId, reason: failure.reason }],
              ...(suggestion === undefined ? {} : { suggestion }),
            }),
          );
        }),
      ),
    );
  });
}
