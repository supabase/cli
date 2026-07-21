/**
 * Port of Go's `WaitForHealthyService`/`IsServiceReady`
 * (`apps/cli-go/internal/db/start/start.go:192-231`,
 * `apps/cli-go/internal/status/status.go:147-168`): a single shared probe
 * across every still-unhealthy started container, on a 1-second constant
 * backoff, for up to `timeoutSeconds` retries (Go's default `serviceTimeout =
 * 30 * time.Second`) — NOT independent per-container timers. Each tick probes
 * every still-unhealthy container, narrows the "still watching" set to just
 * the ones that failed this round (a healthy container stops being probed),
 * and only the final timeout's failures surface to the caller.
 */

import { Data, Effect, Schedule, Stream } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { spawnContainerCli } from "../../../shared/legacy-container-cli.ts";
import { legacyInspectContainerState } from "../../../shared/legacy-docker-lifecycle.ts";
import { legacyKongAuthHeaders } from "../../../shared/legacy-kong-auth.ts";

type Spawner = ChildProcessSpawner["Service"];

/** Go's `serviceTimeout` (`apps/cli-go/internal/start/start.go:161`). */
const LEGACY_HEALTH_CHECK_TIMEOUT_SECONDS = 30;

/**
 * Go's `healthProbeTimeout` (`apps/cli-go/internal/status/status.go:209`): caps
 * a single HTTP readiness probe so a hung response cannot stall the
 * surrounding retry loop.
 */
const LEGACY_HTTP_PROBE_TIMEOUT_SECONDS = 10;

/** `apps/cli-go/internal/status/status.go:161` — PostgREST does not support native Docker healthchecks. */
const LEGACY_POSTGREST_READY_PATH = "/rest-admin/v1/ready";

/**
 * `apps/cli-go/internal/status/status.go:163-166` — Edge Runtime bypasses its
 * native Docker healthcheck too ("native health check logs too much
 * hyper::Error(IncompleteMessage)"), through the exact same
 * {@link legacyCheckHttpReady}/Kong-gateway path as PostgREST, just its own
 * path and container id. Go's `checkHTTPHead` even shares one lazily-built
 * `healthClient` across both call sites (`status.go:202-219`) — the closest
 * equivalent here is {@link LegacyHealthCheckPostgrestGateway} being reused
 * as-is (name notwithstanding — its shape is generic, not
 * PostgREST-specific) for both {@link LegacyWaitForHealthyServicesOptions.postgrest}
 * and {@link LegacyWaitForHealthyServicesOptions.edgeRuntime}.
 */
const LEGACY_EDGE_RUNTIME_READY_PATH = "/functions/v1/_internal/health";

/** Identifies a single container's readiness failure this round. */
export interface LegacyHealthCheckFailure {
  readonly containerId: string;
  readonly reason: string;
}

/** Internal-only: one probe round's failures, narrowing which containers are still watched next round. */
class LegacyHealthCheckProbeError extends Data.TaggedError("LegacyHealthCheckProbeError")<{
  readonly failures: ReadonlyArray<LegacyHealthCheckFailure>;
}> {}

/**
 * The retry loop's final, and only surfaced, failure — mirrors Go returning
 * `errors.Join(errHealth...)` from the last failed `probe()` call once
 * `backoff.Retry` gives up (`start.go:210-214`).
 */
export class LegacyHealthCheckTimeoutError extends Data.TaggedError(
  "LegacyHealthCheckTimeoutError",
)<{
  readonly message: string;
  readonly unhealthy: ReadonlyArray<LegacyHealthCheckFailure>;
}> {}

/**
 * PostgREST's local Kong gateway coordinates, mirroring Go's
 * `fetcher.NewServiceGateway(utils.Config.Api.ExternalUrl,
 * utils.Config.Auth.SecretKey.Value, ...)` (`status.go:213-218`). TLS/CA trust
 * for a local https gateway is the caller's responsibility when composing the
 * `HttpClient.HttpClient` layer this module requires — same split as
 * `legacy-storage-gateway.ts`/`legacyStorageGatewayFetch`.
 *
 * `start.command.ts` composes the `HttpClient.HttpClient` this module
 * requires via `legacyHttpClientLayer` (itself `FetchHttpClient`-backed, and
 * on its own CA-unaware; see that layer's own header) — the same layer
 * `db reset`/`seed buckets` compose for the equivalent gateway calls.
 * `start.handler.ts` layers a CA-trusting override on top of that: when
 * `api.tls.enabled`, `apiExternalUrl` is `https://` against Kong's
 * self-signed local cert (`KONG_LOCAL_CA_CERT`, or a validated
 * `api.tls.cert_path` override), so before calling
 * {@link legacyWaitForHealthyServices} it resolves that same CA via
 * `legacy-storage-credentials.ts`'s `legacyResolveStorageCredentials` (the
 * mechanism `seed buckets`/`storage`/`db reset` already use) and, when a
 * local CA resolves, overrides `FetchHttpClient.Fetch` with
 * `legacyStorageGatewayFetch` around the health-check call via
 * `Effect.provideService`. That override only takes effect against a
 * `FetchHttpClient`-backed `HttpClient.HttpClient` — exactly what
 * `legacyHttpClientLayer` provides — so a stack started with
 * `[api.tls] enabled = true` now gets a `legacyCheckHttpReady` probe that
 * trusts the local Kong CA instead of exhausting `legacyWaitForHealthyServices`'s
 * full 30s budget on a TLS verification failure.
 */
export interface LegacyHealthCheckPostgrestGateway {
  readonly containerId: string;
  readonly apiExternalUrl: string;
  readonly secretKey: string;
}

export interface LegacyWaitForHealthyServicesOptions {
  readonly timeoutSeconds?: number;
  readonly postgrest?: LegacyHealthCheckPostgrestGateway;
  /** See {@link LEGACY_EDGE_RUNTIME_READY_PATH}'s doc comment for why this reuses the same gateway shape as {@link postgrest}. */
  readonly edgeRuntime?: LegacyHealthCheckPostgrestGateway;
}

/**
 * Go's `assertContainerHealthy` (`status.go:147-156`), reused verbatim via
 * {@link legacyInspectContainerState} — the same primitive `status.handler.ts`
 * already uses for the exact same not-running/not-ready gating.
 */
function legacyCheckContainerReady(
  spawner: Spawner,
  containerId: string,
): Effect.Effect<void, string> {
  return legacyInspectContainerState(spawner, containerId).pipe(
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

/**
 * Go's `checkHTTPHead` (`status.go:211-229`): an HTTP HEAD through the local
 * Kong gateway, expecting exactly 200. Bypasses the Docker healthcheck
 * entirely — PostgREST "does not support native health checks"
 * (`status.go:159-161`).
 */
function legacyCheckHttpReady(
  gateway: LegacyHealthCheckPostgrestGateway,
  path: string,
): Effect.Effect<void, string, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.head(`${gateway.apiExternalUrl}${path}`).pipe(
      HttpClientRequest.setHeaders(legacyKongAuthHeaders(gateway.secretKey)),
    );
    const response = yield* httpClient.execute(request).pipe(
      Effect.timeout(`${LEGACY_HTTP_PROBE_TIMEOUT_SECONDS} seconds`),
      Effect.mapError((cause) => String(cause)),
    );
    if (response.status !== 200) {
      return yield* Effect.fail(`unexpected status ${response.status}`);
    }
  });
}

/**
 * Go's `DockerStreamLogsOnce` (`apps/cli-go/internal/utils/docker.go:593-606`)
 * via `docker logs <id>`, teed to this process's stderr — best-effort: a
 * failure to stream logs must never mask the timeout error it was printed
 * alongside, so every failure here is swallowed.
 */
function legacyStreamContainerLogsOnce(spawner: Spawner, containerId: string): Effect.Effect<void> {
  return Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawnContainerCli(spawner, ["logs", containerId], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      yield* Effect.all(
        [
          Stream.runForEach(handle.stdout, (chunk) =>
            Effect.sync(() => {
              globalThis.process.stderr.write(chunk);
            }),
          ),
          Stream.runForEach(handle.stderr, (chunk) =>
            Effect.sync(() => {
              globalThis.process.stderr.write(chunk);
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      yield* handle.exitCode;
    }),
  ).pipe(Effect.orElseSucceed(() => undefined));
}

/** Go's `fmt.Fprintln(os.Stderr, containerId, "container logs:")` (`start.go:218`) + the log dump itself. */
function legacyDumpContainerLogs(spawner: Spawner, containerId: string): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* Effect.sync(() => {
      globalThis.process.stderr.write(`${containerId} container logs:\n`);
    });
    yield* legacyStreamContainerLogsOnce(spawner, containerId);
  });
}

/**
 * Waits for every container in `containerIds` to become ready, mirroring
 * Go's `WaitForHealthyService(ctx, timeout, started...)`. Resolves once all
 * are ready; fails with {@link LegacyHealthCheckTimeoutError} (carrying every
 * still-unhealthy container's last-seen reason) once the retry budget is
 * exhausted. The caller (`start.handler.ts`) decides whether
 * `--ignore-health-check` turns that failure into a warning instead of a hard
 * exit — this module only implements the polling contract.
 */
export function legacyWaitForHealthyServices(
  spawner: Spawner,
  containerIds: ReadonlyArray<string>,
  opts: LegacyWaitForHealthyServicesOptions = {},
): Effect.Effect<void, LegacyHealthCheckTimeoutError, HttpClient.HttpClient> {
  const timeoutSeconds = opts.timeoutSeconds ?? LEGACY_HEALTH_CHECK_TIMEOUT_SECONDS;
  const postgrest = opts.postgrest;
  const edgeRuntime = opts.edgeRuntime;

  const checkOne = (containerId: string): Effect.Effect<void, string, HttpClient.HttpClient> => {
    if (postgrest !== undefined && containerId === postgrest.containerId) {
      return legacyCheckHttpReady(postgrest, LEGACY_POSTGREST_READY_PATH);
    }
    if (edgeRuntime !== undefined && containerId === edgeRuntime.containerId) {
      return legacyCheckHttpReady(edgeRuntime, LEGACY_EDGE_RUNTIME_READY_PATH);
    }
    return legacyCheckContainerReady(spawner, containerId);
  };

  return Effect.gen(function* () {
    let stillWatching = containerIds;

    // Mirrors Go's closure-captured `started` slice
    // (`db/start/start.go:200-212`): each round narrows `stillWatching` to
    // just the containers that failed, so a container that becomes healthy
    // mid-run stops being probed on later rounds.
    const probe: Effect.Effect<void, LegacyHealthCheckProbeError, HttpClient.HttpClient> =
      Effect.gen(function* () {
        const outcomes = yield* Effect.forEach(
          stillWatching,
          (containerId) =>
            checkOne(containerId).pipe(
              Effect.match({
                onFailure: (reason): LegacyHealthCheckFailure | undefined => ({
                  containerId,
                  reason,
                }),
                onSuccess: (): LegacyHealthCheckFailure | undefined => undefined,
              }),
            ),
          { concurrency: "unbounded" },
        );
        const failures = outcomes.filter(
          (outcome): outcome is LegacyHealthCheckFailure => outcome !== undefined,
        );
        stillWatching = failures.map((failure) => failure.containerId);
        if (failures.length > 0) {
          return yield* Effect.fail(new LegacyHealthCheckProbeError({ failures }));
        }
      });

    // `backoff.WithMaxRetries(backoff.NewConstantBackOff(time.Second),
    // uint64(timeout.Seconds()))` (`db/start/start.go:192-198`): a 1-second
    // constant delay, capped at `timeoutSeconds` retries after the initial
    // attempt (~`timeoutSeconds` further seconds elapsed on total failure).
    const schedule = Schedule.max([Schedule.spaced("1 seconds"), Schedule.recurs(timeoutSeconds)]);

    yield* probe.pipe(
      Effect.retry(schedule),
      Effect.catch((probeError) =>
        Effect.gen(function* () {
          // Go skips this dump on context cancellation (`start.go:215`,
          // `!errors.Is(err, context.Canceled)`) — an interrupted fiber never
          // reaches this `Effect.catch` handler at all, so no separate check
          // is needed here.
          yield* Effect.forEach(probeError.failures, (failure) =>
            legacyDumpContainerLogs(spawner, failure.containerId),
          );
          return yield* Effect.fail(
            new LegacyHealthCheckTimeoutError({
              message: probeError.failures
                .map((failure) => `${failure.containerId}: ${failure.reason}`)
                .join("\n"),
              unhealthy: probeError.failures,
            }),
          );
        }),
      ),
    );
  });
}
