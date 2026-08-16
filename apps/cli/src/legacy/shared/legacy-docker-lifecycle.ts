import { isDockerDaemonDownMessage } from "@supabase/stack/effect";
import { Data, Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";
import {
  LegacyContainerRuntimeNotFoundError,
  legacyChildResult,
  legacyDescribeContainerCliFailure,
  spawnContainerCli,
} from "./legacy-container-cli.ts";
import { LEGACY_CLI_WORKDIR_LABEL } from "./legacy-docker-ids.ts";

type Spawner = ChildProcessSpawner["Service"];

/**
 * Listing containers or volumes by Docker label failed. Wraps the established
 * `Docker.ContainerList`/`Docker.VolumeList` errors (see
 * `checkServiceHealth`/`DockerRemoveAll`), which
 * wrap as `"failed to list containers: %w"` / equivalent.
 */
export class LegacyDockerLifecycleListError extends Data.TaggedError(
  "LegacyDockerLifecycleListError",
)<{
  readonly message: string;
}> {
  // `docker ps`/`docker volume ls` never fail because nothing matches the
  // label filter — an empty match is a successful, empty result. Every real
  // failure here is therefore a container-runtime problem: neither
  // docker/podman could be spawned, or the daemon itself rejected the call.
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dockerNotRunning;
  }
}

/**
 * Inspecting a single container's state failed for a reason other than "not
 * found" — except `assertContainerHealthy` (and this port, matching it,
 * see `status.handler.ts`) never special-cases a missing container either: an
 * absent container is just another non-zero `docker container inspect` exit,
 * which is by far the dominant real trigger of this error (the user hasn't
 * run `supabase start` yet) — same fix as the other "stack isn't running"
 * errors elsewhere in this codebase.
 */
export class LegacyDockerLifecycleInspectError extends Data.TaggedError(
  "LegacyDockerLifecycleInspectError",
)<{
  readonly message: string;
  /**
   * Set at the container boundary when neither runtime can be spawned or the
   * daemon is unreachable. Every other inspect failure (the dominant "stack
   * isn't running yet" case) keeps the `startStack` classification.
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

function splitNonEmptyLines(text: string): ReadonlyArray<string> {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Shared `docker ps --filter label=<filterValue> [--all] --format
 * <formatArg>` spawn: one Docker CLI invocation is one underlying `GET
 * /containers/json` Docker Engine API request regardless of `--format`
 * (`--format` only controls how the CLI renders the already-returned JSON
 * response client-side) — every exported listing function below funnels
 * through here so two differently-formatted needs never accidentally cost
 * two real requests. See {@link legacyListContainerIdsAndNames}'s doc
 * comment for why that distinction matters for Go-parity request-log tests.
 */
function spawnDockerPsLines(
  spawner: Spawner,
  opts: { readonly projectIdFilter: string; readonly all: boolean; readonly formatArg: string },
): Effect.Effect<ReadonlyArray<string>, LegacyDockerLifecycleListError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const args = [
        "ps",
        "--filter",
        `label=${opts.projectIdFilter}`,
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
            new LegacyDockerLifecycleListError({
              message: `failed to list containers: ${legacyDescribeContainerCliFailure(cause)}`,
            }),
        ),
      );
      const { exitCode, stdout, stderr } = yield* legacyChildResult(child, {
        stdout: true,
        stderr: true,
      }).pipe(
        Effect.mapError(
          () => new LegacyDockerLifecycleListError({ message: "failed to list containers" }),
        ),
      );
      if (exitCode !== 0) {
        const message = stderr.trim();
        return yield* Effect.fail(
          new LegacyDockerLifecycleListError({
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
 * `Docker.ContainerList(ctx, container.ListOptions{All, Filters})`
 * via `docker ps --filter
 * label=<filterValue>`. `all: false` mirrors `status`'s running-only list;
 * `all: true` mirrors `stop`'s "every container regardless of state" list.
 */
export const legacyListContainersByLabel = (
  spawner: Spawner,
  opts: {
    readonly projectIdFilter: string;
    readonly all: boolean;
    readonly format: "id" | "names";
  },
) =>
  spawnDockerPsLines(spawner, {
    projectIdFilter: opts.projectIdFilter,
    all: opts.all,
    formatArg: opts.format === "names" ? "{{.Names}}" : "{{.ID}}",
  });

/**
 * A single `docker ps` result row's id, name, and staging workdir together.
 *
 * `workdir` is `LEGACY_CLI_WORKDIR_LABEL`'s value read straight off the container (see
 * that constant's doc comment) — empty when the container carries no such label, which
 * `legacyCleanupStartSecrets` treats as "fall back to the caller's own workdir" (a
 * container `start` created before this label existed, or created by a Go binary).
 */
export interface LegacyContainerIdName {
  readonly id: string;
  readonly name: string;
  readonly workdir: string;
}

/**
 * Combined-format sibling of {@link legacyListContainersByLabel}: fetches a
 * container's id, name, AND staging workdir from a SINGLE `docker ps --format
 * "{{.ID}}\t{{.Names}}\t{{.Label \"com.supabase.cli.workdir\"}}"` invocation,
 * rather than one call per field. Go's SDK-based `Docker.ContainerList` gets
 * all of this (and every other field) from the one Engine API response it
 * already makes; two separately-`--format`ted CLI calls here would silently
 * double the real Docker request count relative to Go even though each call's
 * own output is individually correct — exactly the bug the cli-e2e-ci
 * request-log parity harness caught for `stop` (an extra `GET /containers/json`
 * versus Go's single call). Used by {@link legacyDockerRemoveAll}, which needs
 * ids to stop containers, for callers (`stop`, `start`'s rollback) that ALSO
 * need names and workdirs for {@link legacyCleanupStartSecrets} — see that
 * function's doc comment and {@link legacyDockerRemoveAll}'s
 * `onContainersRemoved` parameter.
 */
export const legacyListContainerIdsAndNames = (
  spawner: Spawner,
  opts: {
    readonly projectIdFilter: string;
    readonly all: boolean;
  },
): Effect.Effect<ReadonlyArray<LegacyContainerIdName>, LegacyDockerLifecycleListError> =>
  spawnDockerPsLines(spawner, {
    projectIdFilter: opts.projectIdFilter,
    all: opts.all,
    formatArg: `{{.ID}}\t{{.Names}}\t{{.Label "${LEGACY_CLI_WORKDIR_LABEL}"}}`,
  }).pipe(
    Effect.map((lines) =>
      lines.map((line) => {
        const [id = "", name = "", workdir = ""] = line.split("\t");
        return { id, name, workdir };
      }),
    ),
  );

/**
 * `Docker.ContainerInspect(ctx, containerId)` via `docker container inspect <id> --format
 * {{json .State}}`. `assertContainerHealthy` does not special-case a
 * missing container — it wraps whatever error `ContainerInspect` returns,
 * so every non-zero exit, including "no such
 * container", propagates as `LegacyDockerLifecycleInspectError` carrying the
 * real Docker stderr text.
 */
export const legacyInspectContainerState = (spawner: Spawner, containerId: string) =>
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
          const description = legacyDescribeContainerCliFailure(cause);
          return new LegacyDockerLifecycleInspectError({
            message: `failed to inspect container health: ${description}`,
            daemonDown:
              cause instanceof LegacyContainerRuntimeNotFoundError ||
              isDockerDaemonDownMessage(description),
          });
        }),
      );
      const { exitCode, stdout, stderr } = yield* legacyChildResult(child, {
        stdout: true,
        stderr: true,
      }).pipe(
        Effect.mapError(
          () =>
            new LegacyDockerLifecycleInspectError({
              message: "failed to inspect container health",
            }),
        ),
      );
      if (exitCode !== 0) {
        const message = stderr.trim();
        return yield* Effect.fail(
          new LegacyDockerLifecycleInspectError({
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
  // `assertContainerHealthy` gates
  // on the boolean `resp.State.Running`, not the status string — Docker's
  // inspect `State` struct exposes both independently, and a paused or
  // restarting container reports `Running: true` alongside a non-"running"
  // `Status` (`"paused"`/`"restarting"`). `status` is kept as-is for the
  // "container is not running: <status>" message text,
  // which still reads the string, but the gate itself must read the boolean.
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

/**
 * `Docker.VolumeList(ctx, volume.ListOptions{Filters})`
 * (`docker.go` — used by the `stop` post-run volume-suggestion check) via
 * `docker volume ls --filter label=<filterValue>`.
 */
export const legacyListVolumesByLabel = (spawner: Spawner, projectIdFilter: string) =>
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
            new LegacyDockerLifecycleListError({
              message: `failed to list volumes: ${legacyDescribeContainerCliFailure(cause)}`,
            }),
        ),
      );
      const { exitCode, stdout, stderr } = yield* legacyChildResult(child, {
        stdout: true,
        stderr: true,
      }).pipe(
        Effect.mapError(
          () => new LegacyDockerLifecycleListError({ message: "failed to list volumes" }),
        ),
      );
      if (exitCode !== 0) {
        const message = stderr.trim();
        return yield* Effect.fail(
          new LegacyDockerLifecycleListError({
            message:
              message.length > 0 ? `failed to list volumes: ${message}` : "failed to list volumes",
          }),
        );
      }
      return splitNonEmptyLines(stdout);
    }),
  );
