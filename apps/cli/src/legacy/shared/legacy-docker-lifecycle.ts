import { Data, Effect, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { legacyDescribeContainerCliFailure, spawnContainerCli } from "./legacy-container-cli.ts";

type Spawner = ChildProcessSpawner["Service"];

/**
 * Listing containers or volumes by Docker label failed. Wraps Go's
 * `Docker.ContainerList`/`Docker.VolumeList` errors (`docker.go:99-104`,
 * `docker.go:334-336` — see `checkServiceHealth`/`DockerRemoveAll`), which Go
 * wraps as `"failed to list containers: %w"` / equivalent.
 */
export class LegacyDockerLifecycleListError extends Data.TaggedError(
  "LegacyDockerLifecycleListError",
)<{
  readonly message: string;
}> {}

/** Inspecting a single container's state failed for a reason other than "not found". */
export class LegacyDockerLifecycleInspectError extends Data.TaggedError(
  "LegacyDockerLifecycleInspectError",
)<{
  readonly message: string;
}> {}

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
 * Go's `Docker.ContainerList(ctx, container.ListOptions{All, Filters})`
 * (`docker.go:99-104`, `status.go:126-131`) via `docker ps --filter
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
  Effect.scoped(
    Effect.gen(function* () {
      const formatArg = opts.format === "names" ? "{{.Names}}" : "{{.ID}}";
      const args = [
        "ps",
        "--filter",
        `label=${opts.projectIdFilter}`,
        ...(opts.all ? ["--all"] : []),
        "--format",
        formatArg,
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
      // Concurrency is required, not cosmetic: sequential `Effect.all` would
      // await `exitCode` (resolved by Node's "exit" event) before subscribing
      // to `stdout`/`stderr` at all. Node's "exit" can fire before a fast
      // process's stdio pipes are drained, so a late subscriber sees an
      // already-ended, empty stream instead of the buffered bytes.
      const [exitCode, stdout, stderr] = yield* Effect.all(
        [
          child.exitCode.pipe(Effect.map(Number)),
          collectByteStream(child.stdout),
          collectByteStream(child.stderr),
        ],
        { concurrency: "unbounded" },
      ).pipe(
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

/**
 * Go's `Docker.ContainerInspect(ctx, containerId)` (`docker.go:148`,
 * `status.go:148-155`) via `docker container inspect <id> --format
 * {{json .State}}`. Go's `assertContainerHealthy` does not special-case a
 * missing container — it wraps whatever error `ContainerInspect` returns
 * (`status.go:148-149`), so every non-zero exit, including "no such
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
        Effect.mapError(
          (cause) =>
            new LegacyDockerLifecycleInspectError({
              message: `failed to inspect container health: ${legacyDescribeContainerCliFailure(cause)}`,
            }),
        ),
      );
      // Concurrency is required, not cosmetic — see the matching comment in
      // `legacyListContainersByLabel` above.
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
  // Go's `assertContainerHealthy` (`internal/status/status.go:147-156`) gates
  // on the boolean `resp.State.Running`, not the status string — Docker's
  // inspect `State` struct exposes both independently, and a paused or
  // restarting container reports `Running: true` alongside a non-"running"
  // `Status` (`"paused"`/`"restarting"`). `status` is kept as-is for the
  // "container is not running: <status>" message text (`status.go:151`),
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
 * Go's `Docker.VolumeList(ctx, volume.ListOptions{Filters})`
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
      // Concurrency is required, not cosmetic — see the matching comment in
      // `legacyListContainersByLabel` above.
      const [exitCode, stdout, stderr] = yield* Effect.all(
        [
          child.exitCode.pipe(Effect.map(Number)),
          collectByteStream(child.stdout),
          collectByteStream(child.stderr),
        ],
        { concurrency: "unbounded" },
      ).pipe(
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
