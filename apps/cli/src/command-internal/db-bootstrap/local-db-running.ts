import http from "node:http";

import { Context, Data, Effect, type FileSystem, Layer, Option, type Path, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";
import { isContainerNotFoundMessage, spawnContainerCli } from "../container-cli.ts";
import { readDbToml } from "../db-config.toml-read.ts";
import { resolveLocalProjectId, localDbContainerId } from "../docker-ids.ts";
import { SUGGEST_DOCKER_INSTALL, isDockerDaemonUnreachable } from "../docker-suggest.ts";
import { DebugLogger } from "../debug-logger.service.ts";
import { resolveDockerDaemonEndpoint } from "../hostname.ts";

type Spawner = ChildProcessSpawner["Service"];

/** `docker container inspect` failed for a reason other than "the container doesn't exist". */
export class LocalDbRunningError extends Data.TaggedError("LocalDbRunningError")<{
  readonly message: string;
  /** Classified at the container-runtime boundary; never inferred from `message` by telemetry. */
  readonly daemonDown?: boolean;
  /** Set when the failure is a daemon-connection error, mirroring `utils.CmdSuggestion`. */
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    if (this.daemonDown === true) {
      return { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" };
    }
    return actionability.startStack;
  }
}

/**
 * Direct Engine-API access to the locally addressable Docker daemon, so
 * {@link isLocalDbRunning} does not depend on a spawnable, responsive
 * `docker` CLI binary (issue #6110). `containerExists`: `Option.some(true)` —
 * an Engine-identified 200 with a valid inspect payload; `Option.some(false)`
 * — an Engine-identified 404; `Option.none()` — anything else (non-addressable
 * endpoint, transport failure, silent socket, non-Engine responder, abnormal
 * status, malformed body), telling the caller to fall back to the container
 * CLI, which preserves the established wording, daemon-down classification,
 * and Podman fallback.
 */
export class LocalDockerEngine extends Context.Service<
  LocalDockerEngine,
  {
    readonly containerExists: (containerId: string) => Effect.Effect<Option.Option<boolean>>;
  }
>()("supabase/cli/LocalDockerEngine") {}

/**
 * The local socket path for a `unix://`/`npipe://` daemon endpoint
 * (`npipe:////./pipe/X` -> `\\.\pipe\X`), as `node:http`'s `socketPath`
 * accepts it. Every other scheme returns `undefined` — tcp/ssh/fd endpoints
 * may need TLS material or transports only the `docker` CLI carries, so
 * callers keep shelling out. Exported for tests (npipe is Windows-only).
 */
export function dockerEndpointSocketPath(endpoint: string): string | undefined {
  if (endpoint.startsWith("unix://")) {
    const socketPath = endpoint.slice("unix://".length);
    return socketPath.length > 0 ? socketPath : undefined;
  }
  if (endpoint.startsWith("npipe://")) {
    const pipePath = endpoint.slice("npipe://".length);
    return pipePath.length > 0 ? pipePath.replaceAll("/", "\\") : undefined;
  }
  return undefined;
}

/**
 * Socket-inactivity deadline: a connected-but-silent endpoint degrades to the
 * container-CLI fallback instead of parking the command (#6110's hang shape).
 */
const ENGINE_PROBE_TIMEOUT_MS = 2000;

/**
 * Body bound (an inspect payload is a few KB); past it the probe stops
 * reading and falls back. Matches `ControlHttpReader`'s own cap.
 */
const ENGINE_MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Docker sets `Api-Version`/`Server: Docker/<v>` on every response, 404s
 * included (Podman's compat API sends `Api-Version` too). A 200/404 without
 * them is some other service on the socket, not an answer — fall back.
 */
const isEngineResponse = (response: http.IncomingMessage): boolean =>
  response.headers["api-version"] !== undefined ||
  String(response.headers["server"] ?? "").startsWith("Docker/");

/**
 * `GET /containers/<id>/json` over a local socket / named pipe. Total: every
 * terminal state settles exactly once, and anything that is not an
 * Engine-identified 200/404 settles `Option.none()`. `agent: false` keeps the
 * one-shot connection out of the process-global pool (`ControlHttpReader`'s
 * precedent).
 */
const inspectContainerOverSocket = (
  socketPath: string,
  containerId: string,
): Effect.Effect<Option.Option<boolean>> =>
  Effect.callback((resume, signal) => {
    let settled = false;
    const settle = (result: Option.Option<boolean>) => {
      if (settled) return;
      settled = true;
      resume(Effect.succeed(result));
    };
    const settleNone = () => {
      settle(Option.none());
    };

    let request: http.ClientRequest;
    try {
      request = http.request(
        {
          socketPath,
          method: "GET",
          path: `/containers/${encodeURIComponent(containerId)}/json`,
          // HTTP/1.1 requires a Host header; "docker" is what Docker's SDKs send.
          headers: { Host: "docker" },
          agent: false,
          timeout: ENGINE_PROBE_TIMEOUT_MS,
          signal,
        },
        (response) => {
          const chunks: Array<Buffer> = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > ENGINE_MAX_RESPONSE_BYTES) {
              response.destroy();
              settleNone();
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", settleNone);
          // A dropped connection can surface as `close` without `end` (no
          // `error` guaranteed); the latch no-ops the ordinary post-`end` close.
          response.on("close", settleNone);
          response.on("end", () => {
            if (!isEngineResponse(response)) {
              settleNone();
              return;
            }
            const status = response.statusCode ?? 0;
            if (status === 404) {
              settle(Option.some(false));
              return;
            }
            if (status !== 200) {
              settleNone();
              return;
            }
            // A 200 must carry a JSON-object inspect payload to count as "present".
            let payload: unknown;
            try {
              payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              payload = undefined;
            }
            if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
              settleNone();
              return;
            }
            settle(Option.some(true));
          });
        },
      );
      request.on("error", settleNone);
      // Node leaves the in-flight socket alive on `timeout` — destroy it. Also
      // the universal backstop; deliberately no `request.on("close")`: under
      // Bun that fires mid-response, between `data` and `end`.
      request.on("timeout", () => {
        request.destroy();
        settleNone();
      });
      request.end();
    } catch {
      // A transport that cannot even be constructed is a transport failure too.
      settleNone();
      return;
    }

    return Effect.sync(() => {
      settled = true;
      request.destroy();
    });
  });

/**
 * Production {@link LocalDockerEngine}: resolves the endpoint the way the
 * `docker` CLI itself would (`DOCKER_HOST` -> context store -> platform
 * default), inside `Effect.suspend` so every execution sees the current
 * environment. With `DebugLogger` provided (the db families provide it), the
 * probe's endpoint and fallback decisions surface under `--debug` — otherwise
 * this is the one HTTP call the debug side channel cannot see.
 */
export const localDockerEngineLayer: Layer.Layer<LocalDockerEngine> = Layer.effect(
  LocalDockerEngine,
  Effect.gen(function* () {
    const debugLogger = yield* Effect.serviceOption(DebugLogger);
    const debug = (line: string) =>
      Option.isSome(debugLogger) ? debugLogger.value.debug(line) : Effect.void;
    return LocalDockerEngine.of({
      containerExists: (containerId) =>
        Effect.suspend(() => {
          const endpoint = resolveDockerDaemonEndpoint();
          const socketPath =
            endpoint === undefined ? undefined : dockerEndpointSocketPath(endpoint);
          if (socketPath === undefined) {
            return debug(
              `local db engine probe: endpoint not directly addressable (${endpoint ?? "unresolved context"}) — using the container CLI`,
            ).pipe(Effect.as(Option.none()));
          }
          return debug(
            `local db engine probe: GET ${endpoint} /containers/${containerId}/json`,
          ).pipe(
            Effect.andThen(inspectContainerOverSocket(socketPath, containerId)),
            Effect.tap((answer) =>
              Option.isNone(answer)
                ? debug(
                    "local db engine probe: no definitive Engine answer — falling back to the container CLI",
                  )
                : Effect.void,
            ),
          );
        }),
    });
  }),
);

const decodeChunks = (chunks: ReadonlyArray<Uint8Array>): string => {
  const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
};

/**
 * Answers "does the local Postgres container exist?" (the stack-up probe run
 * before any database bootstrap). Resolves `true` when it exists and `false`
 * when it definitively does not; any other inspect failure (e.g. the Docker
 * daemon is unreachable) fails with {@link LocalDbRunningError} instead
 * of being silently treated as "not running".
 *
 * The probe asks the Engine API directly first ({@link LocalDockerEngine}),
 * so a stalled `docker` CLI binary can no longer block it (issue #6110); only
 * when the Engine gives no definitive answer does it fall back to the
 * container-CLI spawn below, which preserves the Podman fallback and the
 * daemon-down classification (via the shared `isContainerNotFoundMessage`
 * matcher in `../container-cli.ts`).
 *
 * Shared by `db start` (`commands/db/start/start.handler.ts`) and `db reset`
 * (`commands/db/reset/reset.handler.ts`) — hoisted out of the `db __db-bootstrap`
 * Go seam by CLI-1954, since this check was already a native TS `docker container
 * inspect`, not a Go subprocess call. CLI-1955 later removed the rest of that seam
 * too (`db reset`'s container-recreate + storage-health-gate primitives are now
 * native — `recreate-local-database.ts`/`await-storage-ready.ts`), so the seam
 * itself no longer exists at all.
 *
 * `resolveDbToml` mirrors the seam's own best-effort read: the caller has
 * already run the config load/validation before reaching this check, so here
 * we only want the resolved `projectId` and tolerate falling back to the
 * workdir basename on an unreadable `.env` rather than re-throwing.
 */
export function isLocalDbRunning(
  spawner: Spawner,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  configuredProjectId: string | undefined,
): Effect.Effect<boolean, LocalDbRunningError, LocalDockerEngine> {
  return Effect.scoped(
    Effect.gen(function* () {
      // `warnOnUnresolvedEnv: false` — this doc comment's own `resolveDbToml` note:
      // the caller has already run Go's `LoadConfig` validation (and, if the config
      // has an OrioleDB project with an unresolved S3 `env(VAR)`, already printed
      // Go's single `assertEnvLoaded` WARN) before reaching this probe. Re-printing
      // it here would diverge from Go's exactly-once `flags.LoadConfig` call.
      const tomlProjectId = yield* readDbToml(fs, path, workdir, undefined, {
        validate: false,
        warnOnUnresolvedEnv: false,
      }).pipe(
        Effect.map((toml) => toml.projectId),
        Effect.orElseSucceed(() => Option.none<string>()),
      );
      const projectId = resolveLocalProjectId(
        configuredProjectId,
        Option.getOrUndefined(tomlProjectId),
        workdir,
      );
      const containerId = localDbContainerId(projectId);
      // Engine probe first; `Option.none()` falls through to the CLI spawn below.
      const engine = yield* LocalDockerEngine;
      const engineAnswer = yield* engine.containerExists(containerId);
      if (Option.isSome(engineAnswer)) return engineAnswer.value;
      // Discard stdout (the inspect JSON) so the unconsumed pipe can never
      // deadlock; only the exit code + stderr matter.
      const child = yield* spawnContainerCli(spawner, ["container", "inspect", containerId], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        extendEnv: true,
      }).pipe(
        Effect.mapError(
          () =>
            new LocalDbRunningError({
              message: "failed to inspect service",
              daemonDown: true,
            }),
        ),
      );
      const stderrChunks: Array<Uint8Array> = [];
      yield* Stream.runForEach(child.stderr, (chunk) =>
        Effect.sync(() => {
          stderrChunks.push(chunk);
        }),
      ).pipe(
        Effect.mapError(() => new LocalDbRunningError({ message: "failed to inspect service" })),
      );
      const inspectExit = yield* child.exitCode.pipe(
        Effect.map(Number),
        Effect.mapError(() => new LocalDbRunningError({ message: "failed to inspect service" })),
      );
      if (inspectExit === 0) return true; // container exists ⇒ running

      const stderr = decodeChunks(stderrChunks).trim();
      // Only a missing container means "not running". Any other inspect
      // failure propagates, matching Go's `AssertSupabaseDbIsRunning`. Uses the
      // shared, Podman-aware matcher (`isContainerNotFoundMessage`) rather than a
      // Docker-only substring check, since `spawnContainerCli` above falls back to Podman
      // on Docker-less hosts, and Podman's inspect-miss wording ("no container with name
      // or ID ... found: no such container") differs from Docker's.
      if (!isContainerNotFoundMessage(stderr)) {
        // Go's `AssertServiceIsRunning` sets `CmdSuggestion = suggestDockerInstall`
        // on a daemon-connection failure (`misc.go:148-154`), so a down daemon
        // still surfaces the actionable Docker Desktop hint, not just raw stderr.
        const daemonDown = isDockerDaemonUnreachable(stderr);
        return yield* Effect.fail(
          new LocalDbRunningError({
            message:
              stderr.length > 0
                ? `failed to inspect service: ${stderr}`
                : "failed to inspect service",
            daemonDown,
            ...(daemonDown ? { suggestion: SUGGEST_DOCKER_INSTALL } : {}),
          }),
        );
      }
      return false;
    }),
  );
}
