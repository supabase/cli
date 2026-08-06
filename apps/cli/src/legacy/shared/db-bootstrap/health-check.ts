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

import {
  legacySpawnContainerCliWithRuntime,
  type LegacyContainerRuntime,
} from "../legacy-container-cli.ts";
import { legacyInspectContainerState } from "../legacy-docker-lifecycle.ts";
import { legacyKongAuthHeaders } from "../legacy-kong-auth.ts";

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
  /**
   * The container NAME (`supabase_<service>_<project id>`), not the opaque id
   * `docker create` returns — both work with `docker container inspect`/`docker
   * logs`, but only the name tells a user which service failed.
   */
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
  /**
   * Kept out of {@link message} so `Output.fail` renders it unstyled and drops
   * the generic "rerun with --debug" line: once an exact command is named,
   * pointing at an HTTP request logger is a non-sequitur (as in CLI-1973).
   */
  readonly suggestion?: string;
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
  /** Each watched container's already-resolved image, keyed by container name. */
  readonly images?: ReadonlyMap<string, string>;
}

/** The container runtime's message when an image cannot be executed by the host kernel. */
const LEGACY_EXEC_FORMAT_ERROR = "exec format error";

/**
 * Scans a byte stream for {@link LEGACY_EXEC_FORMAT_ERROR} in constant memory:
 * retaining the trailing marker-length window is exactly enough to match a
 * marker split across a chunk boundary. One scanner per stream, so stdout and
 * stderr bytes cannot splice into a marker neither stream contains.
 */
function legacyMakeExecFormatScanner() {
  const decoder = new TextDecoder();
  let tail = "";
  let found = false;
  return {
    scan(chunk: Uint8Array): void {
      const text = tail + decoder.decode(chunk, { stream: true });
      found ||= text.includes(LEGACY_EXEC_FORMAT_ERROR);
      tail = text.slice(-LEGACY_EXEC_FORMAT_ERROR.length);
    },
    get found(): boolean {
      return found;
    },
  };
}

/**
 * Recovery advice for a timeout whose logs showed {@link LEGACY_EXEC_FORMAT_ERROR},
 * or `undefined` when no affected image can be named.
 *
 * `supabase stop` leads the sequence because a bare restart is a no-op on the
 * `--ignore-health-check` path: that path leaves the stack up by design, so the
 * next `supabase start` takes the already-running short-circuit and never
 * recreates the broken container. `stop` without `--no-backup` preserves the
 * database volume, and is harmless after the hard-fail path's own rollback.
 *
 * Both `supabase` steps resolve their own project the way this run did, so the
 * sequence names that requirement rather than embedding the resolved workdir:
 * a path rendered into a copy-pasteable command needs shell quoting, and the
 * correct quoting differs between POSIX shells and `cmd.exe`.
 *
 * `-f` because the container may still reference the image, and `runtime`
 * rather than a hardcoded `docker` because `spawnContainerCli` falls back to
 * Podman on hosts without Docker. The closing line covers the case re-pulling
 * cannot fix: a pinned version with no build for this host (supabase/cli#3718,
 * #4674), where the same image comes straight back.
 */
function legacyExecFormatRecoveryHint(
  containerIds: ReadonlyArray<string>,
  images: ReadonlyMap<string, string> | undefined,
  runtime: LegacyContainerRuntime,
): string | undefined {
  // Both names, always: a container and its image can be named after different
  // things (`supabase_inbucket_*` runs `mailpit`), so naming only one leaves
  // the reader guessing whether this is the same failure as the reason above.
  const affected = containerIds.flatMap((containerId) => {
    const image = images?.get(containerId);
    return image === undefined ? [] : [{ containerId, image }];
  });
  if (affected.length === 0) return undefined;
  const uniqueImages = [...new Set(affected.map((entry) => entry.image))];
  return [
    `${affected.map((entry) => `${entry.containerId}'s image ${entry.image}`).join(", ")} could not be executed ("${LEGACY_EXEC_FORMAT_ERROR}").`,
    "Either the cached copy is corrupt, or it was built for a different architecture.",
    "Remove the cached copy and start again, from this project directory or with the same --workdir:",
    `\n  supabase stop\n  ${runtime} image rm -f ${uniqueImages.join(" ")}\n  supabase start\n`,
    "If it fails the same way, that image has no build for this machine's architecture.",
  ].join("\n");
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
 *
 * Resolves to whether the logs contained {@link LEGACY_EXEC_FORMAT_ERROR},
 * scanned off the bytes already being teed — no extra Docker call, no buffer —
 * and to the runtime that answered, so recovery advice can name the binary the
 * user actually has.
 */
function legacyStreamContainerLogsOnce(
  spawner: Spawner,
  containerId: string,
): Effect.Effect<LegacyExecFormatScanResult> {
  // Outside the effect that can fail, so a stream breaking mid-dump cannot
  // discard a marker the scanner has already seen.
  const stdoutScanner = legacyMakeExecFormatScanner();
  const stderrScanner = legacyMakeExecFormatScanner();
  let runtime: LegacyContainerRuntime | undefined;
  return Effect.scoped(
    Effect.gen(function* () {
      const spawned = yield* legacySpawnContainerCliWithRuntime(spawner, ["logs", containerId], {
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
interface LegacyExecFormatScanResult {
  readonly found: boolean;
  /** `undefined` only when neither runtime could be spawned at all. */
  readonly runtime: LegacyContainerRuntime | undefined;
}

/** Go's `fmt.Fprintln(os.Stderr, containerId, "container logs:")` (`start.go:218`) + the log dump itself. */
function legacyDumpContainerLogs(
  spawner: Spawner,
  containerId: string,
): Effect.Effect<LegacyExecFormatScanResult> {
  return Effect.gen(function* () {
    yield* Effect.sync(() => {
      globalThis.process.stderr.write(`${containerId} container logs:\n`);
    });
    return yield* legacyStreamContainerLogsOnce(spawner, containerId);
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
          const scans = yield* Effect.forEach(probeError.failures, (failure) =>
            legacyDumpContainerLogs(spawner, failure.containerId).pipe(
              Effect.map((scan) => ({ ...scan, containerId: failure.containerId })),
            ),
          );
          const execFormatErrors = scans
            .filter((scan) => scan.found)
            .map((scan) => scan.containerId);
          const suggestion = legacyExecFormatRecoveryHint(
            execFormatErrors,
            opts.images,
            scans.find((scan) => scan.runtime !== undefined)?.runtime ?? "docker",
          );
          return yield* Effect.fail(
            new LegacyHealthCheckTimeoutError({
              message: probeError.failures
                .map((failure) => `${failure.containerId}: ${failure.reason}`)
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
