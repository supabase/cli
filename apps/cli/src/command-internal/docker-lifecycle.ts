import { isDockerDaemonDownMessage } from "../shared/stack-constants.ts";
import { Data, Effect, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import {
  ContainerRuntimeNotFoundError,
  describeContainerCliFailure,
  spawnContainerCli,
} from "./container-cli.ts";
import { CLI_WORKDIR_LABEL } from "./docker-ids.ts";

type Spawner = ChildProcessSpawner["Service"];

/** Listing containers or volumes by Docker label failed. */
export class DockerLifecycleListError extends Data.TaggedError("DockerLifecycleListError")<{
  readonly message: string;
}> {
  // An empty match from `docker ps`/`docker volume ls` is a successful empty result, not a
  // failure — so every real failure here means the runtime itself is broken.
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dockerNotRunning;
  }
}

/**
 * Inspecting a single container's state failed. A missing container isn't special-cased — an
 * absent container is just another non-zero `docker container inspect` exit, and by far the most
 * common cause is that `supabase start` hasn't been run yet.
 */
export class DockerLifecycleInspectError extends Data.TaggedError("DockerLifecycleInspectError")<{
  readonly message: string;
  /**
   * True when neither runtime could be spawned or the daemon is unreachable; every other inspect
   * failure keeps the `startStack` classification.
   */
  readonly daemonDown?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    if (this.daemonDown === true) {
      return { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" };
    }
    return actionability.startStack;
  }
}

function collectByteStream(stream: Stream.Stream<Uint8Array, unknown>) {
  const decoder = new TextDecoder();
  return Stream.runFold(
    stream,
    () => "",
    (text, chunk) => text + decoder.decode(chunk, { stream: true }),
  ).pipe(Effect.map((text) => text + decoder.decode()));
}

function splitNonEmptyLines(text: string): ReadonlyArray<string> {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Shared `docker ps` spawn behind every listing function below, so two differently-formatted
 * needs (`{{.ID}}` vs `{{.Names}}`) never cost two separate invocations. Multiple `labelFilters`
 * are ANDed by Docker itself, so scoping to a second label adds no extra cost either.
 */
function spawnDockerPsLines(
  spawner: Spawner,
  opts: {
    readonly labelFilters: ReadonlyArray<string>;
    readonly all: boolean;
    readonly formatArg: string;
  },
): Effect.Effect<ReadonlyArray<string>, DockerLifecycleListError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const args = [
        "ps",
        ...opts.labelFilters.flatMap((filterValue) => ["--filter", `label=${filterValue}`]),
        ...(opts.all ? ["--all"] : []),
        "--format",
        opts.formatArg,
      ];
      const child = yield* spawnContainerCli(spawner, args, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }).pipe(
        Effect.mapError(
          (cause) =>
            new DockerLifecycleListError({
              message: `failed to list containers: ${describeContainerCliFailure(cause)}`,
            }),
        ),
      );
      // Concurrency is required, not cosmetic: sequential `Effect.all` would await `exitCode`
      // before subscribing to `stdout`/`stderr`, and Node's "exit" event can fire before a fast
      // process's stdio pipes are drained — a late subscriber would see an already-ended, empty
      // stream.
      const [exitCode, stdout, stderr] = yield* Effect.all(
        [
          child.exitCode.pipe(Effect.map(Number)),
          collectByteStream(child.stdout),
          collectByteStream(child.stderr),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          () => new DockerLifecycleListError({ message: "failed to list containers" }),
        ),
      );
      if (exitCode !== 0) {
        const message = stderr.trim();
        return yield* Effect.fail(
          new DockerLifecycleListError({
            message:
              message.length > 0
                ? `failed to list containers: ${message}`
                : "failed to list containers",
          }),
        );
      }
      return splitNonEmptyLines(stdout);
    }),
  );
}

/**
 * Lists containers by project label via `docker ps --filter label=<filterValue>`. `all: false`
 * matches `status`'s running-only list; `all: true` matches `stop`'s "every container regardless
 * of state" list.
 */
export const listContainersByLabel = (
  spawner: Spawner,
  opts: {
    readonly projectIdFilter: string;
    readonly all: boolean;
    readonly format: "id" | "names";
  },
) =>
  spawnDockerPsLines(spawner, {
    labelFilters: [opts.projectIdFilter],
    all: opts.all,
    formatArg: opts.format === "names" ? "{{.Names}}" : "{{.ID}}",
  });

/**
 * A single `docker ps` result row's id, name, and staging workdir together.
 *
 * `workdir` is empty when the container carries no {@link CLI_WORKDIR_LABEL} —
 * `cleanupStartSecrets` treats that as "fall back to the caller's own workdir".
 */
export interface ContainerIdName {
  readonly id: string;
  readonly name: string;
  readonly workdir: string;
}

/**
 * Combined-format sibling of {@link listContainersByLabel}: fetches a container's id, name, and
 * staging workdir from a single `docker ps` invocation instead of one call per field, since each
 * `docker ps` is a real Docker Engine API request.
 */
export const listContainerIdsAndNames = (
  spawner: Spawner,
  opts: {
    readonly projectIdFilter: string;
    readonly all: boolean;
  },
): Effect.Effect<ReadonlyArray<ContainerIdName>, DockerLifecycleListError> =>
  spawnDockerPsLines(spawner, {
    labelFilters: [opts.projectIdFilter],
    all: opts.all,
    formatArg: `{{.ID}}\t{{.Names}}\t{{.Label "${CLI_WORKDIR_LABEL}"}}`,
  }).pipe(
    Effect.map((lines) =>
      lines.map((line) => {
        const [id = "", name = "", workdir = ""] = line.split("\t");
        return { id, name, workdir };
      }),
    ),
  );

/**
 * Inspects a container's state via `docker container inspect <id> --format {{json .State}}`.
 * A missing container isn't special-cased — every non-zero exit, including "no such container",
 * propagates as {@link DockerLifecycleInspectError} carrying the real Docker stderr text.
 */
export const inspectContainerState = (spawner: Spawner, containerId: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawnContainerCli(
        spawner,
        ["container", "inspect", containerId, "--format", "{{json .State}}"],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      ).pipe(
        Effect.mapError((cause) => {
          const description = describeContainerCliFailure(cause);
          return new DockerLifecycleInspectError({
            message: `failed to inspect container health: ${description}`,
            daemonDown:
              cause instanceof ContainerRuntimeNotFoundError ||
              isDockerDaemonDownMessage(description),
          });
        }),
      );
      // Concurrency is required, not cosmetic; see `spawnDockerPsLines` above.
      const [exitCode, stdout, stderr] = yield* Effect.all(
        [
          child.exitCode.pipe(Effect.map(Number)),
          collectByteStream(child.stdout),
          collectByteStream(child.stderr),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          () =>
            new DockerLifecycleInspectError({
              message: "failed to inspect container health",
            }),
        ),
      );
      if (exitCode !== 0) {
        const message = stderr.trim();
        return yield* Effect.fail(
          new DockerLifecycleInspectError({
            message:
              message.length > 0
                ? `failed to inspect container health: ${message}`
                : "failed to inspect container health",
            daemonDown: isDockerDaemonDownMessage(message),
          }),
        );
      }
      return parseContainerState(stdout);
    }),
  );

function parseContainerState(stdout: string): {
  readonly running: boolean;
  readonly status: string;
  readonly health?: string;
} {
  const trimmed = stdout.trim();
  let parsed: unknown;
  try {
    parsed = trimmed.length > 0 ? JSON.parse(trimmed) : {};
  } catch {
    parsed = {};
  }
  const state = isJsonRecord(parsed) ? parsed : {};
  // A paused or restarting container reports `Running: true` in Docker's inspect `State`
  // alongside a non-"running" `Status` string, so callers must gate on the boolean, not the
  // status text; `status` is kept only for error message text.
  const status = typeof state["Status"] === "string" ? state["Status"] : "";
  const running = state["Running"] === true;
  const health = state["Health"];
  const healthStatus =
    isJsonRecord(health) && typeof health["Status"] === "string" ? health["Status"] : undefined;
  return healthStatus !== undefined
    ? { running, status, health: healthStatus }
    : { running, status };
}

function isJsonRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null;
}

/** Lists volumes by project label via `docker volume ls --filter label=<filterValue>`. */
export const listVolumesByLabel = (spawner: Spawner, projectIdFilter: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const args = [
        "volume",
        "ls",
        "--filter",
        `label=${projectIdFilter}`,
        "--format",
        "{{.Name}}",
      ];
      const child = yield* spawnContainerCli(spawner, args, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }).pipe(
        Effect.mapError(
          (cause) =>
            new DockerLifecycleListError({
              message: `failed to list volumes: ${describeContainerCliFailure(cause)}`,
            }),
        ),
      );
      // Concurrency is required, not cosmetic; see `spawnDockerPsLines` above.
      const [exitCode, stdout, stderr] = yield* Effect.all(
        [
          child.exitCode.pipe(Effect.map(Number)),
          collectByteStream(child.stdout),
          collectByteStream(child.stderr),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(() => new DockerLifecycleListError({ message: "failed to list volumes" })),
      );
      if (exitCode !== 0) {
        const message = stderr.trim();
        return yield* Effect.fail(
          new DockerLifecycleListError({
            message:
              message.length > 0 ? `failed to list volumes: ${message}` : "failed to list volumes",
          }),
        );
      }
      return splitNonEmptyLines(stdout);
    }),
  );
