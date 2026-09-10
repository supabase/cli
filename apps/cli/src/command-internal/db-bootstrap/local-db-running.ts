import { Data, Effect, type FileSystem, Option, type Path, Stream } from "effect";
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

type Spawner = ChildProcessSpawner["Service"];

/** `docker container inspect` failed for a reason other than "the container doesn't exist". */
export class LocalDbRunningError extends Data.TaggedError("LocalDbRunningError")<{
  readonly message: string;
  /** Classified at the container-runtime boundary; never inferred from `message` by telemetry. */
  readonly daemonDown?: boolean;
  /** Set when the failure is a daemon-connection error. */
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    if (this.daemonDown === true) {
      return { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" };
    }
    return actionability.startStack;
  }
}

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
 * Inspects the local Postgres container. Resolves `true` when it exists and `false` when the
 * container-CLI reports the container is missing (recognizing both Docker's and Podman's
 * not-found wording). Any other inspect failure (e.g. an unreachable Docker daemon) fails with
 * {@link LocalDbRunningError} rather than being treated as "not running".
 */
export function isLocalDbRunning(
  spawner: Spawner,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  configuredProjectId: string | undefined,
): Effect.Effect<boolean, LocalDbRunningError> {
  return Effect.scoped(
    Effect.gen(function* () {
      // Config was already validated (and any unresolved-env WARN already printed) by the
      // caller; only the resolved projectId matters here.
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
      if (inspectExit === 0) return true;

      const stderr = decodeChunks(stderrChunks).trim();
      if (!isContainerNotFoundMessage(stderr)) {
        // Surface the Docker install hint instead of raw stderr when the daemon is unreachable.
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
