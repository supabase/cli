import { Data, Effect, type FileSystem, Option, type Path, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { legacyIsContainerNotFoundMessage, spawnContainerCli } from "../legacy-container-cli.ts";
import { legacyReadDbToml } from "../legacy-db-config.toml-read.ts";
import { legacyResolveLocalProjectId, localDbContainerId } from "../legacy-docker-ids.ts";
import {
  LEGACY_SUGGEST_DOCKER_INSTALL,
  legacyIsDockerDaemonUnreachable,
} from "../legacy-docker-suggest.ts";

type Spawner = ChildProcessSpawner["Service"];

/** `docker container inspect` failed for a reason other than "the container doesn't exist". */
export class LegacyLocalDbRunningError extends Data.TaggedError("LegacyLocalDbRunningError")<{
  readonly message: string;
  /** Set when the failure is a daemon-connection error, mirroring `utils.CmdSuggestion`. */
  readonly suggestion?: string;
}> {}

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
 * Port of Go's `utils.AssertSupabaseDbIsRunning` (`internal/utils/misc.go:144`):
 * inspect the local Postgres container. Resolves `true` when it exists (the
 * stack is up) and `false` when the container-CLI reports a missing container —
 * Docker's "No such container"/"No such object" or Podman's own "no container with
 * name or ID ... found" wording, via the shared `legacyIsContainerNotFoundMessage`
 * matcher (`../legacy-container-cli.ts`) — Go's `ErrNotRunning`. Any other inspect
 * failure (e.g. the Docker daemon is
 * unreachable) fails with {@link LegacyLocalDbRunningError} instead of being
 * treated as "not running", matching Go, which returns the wrapped inspect
 * error rather than silently treating the database as stopped.
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
 * already run Go's `LoadConfig` validation before reaching this check, so here
 * we only want the resolved `projectId` and tolerate falling back to the
 * workdir basename on an unreadable `.env` rather than re-throwing.
 */
export function legacyIsLocalDbRunning(
  spawner: Spawner,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  configuredProjectId: string | undefined,
): Effect.Effect<boolean, LegacyLocalDbRunningError> {
  return Effect.scoped(
    Effect.gen(function* () {
      // `warnOnUnresolvedEnv: false` — this doc comment's own `resolveDbToml` note:
      // the caller has already run Go's `LoadConfig` validation (and, if the config
      // has an OrioleDB project with an unresolved S3 `env(VAR)`, already printed
      // Go's single `assertEnvLoaded` WARN) before reaching this probe. Re-printing
      // it here would diverge from Go's exactly-once `flags.LoadConfig` call.
      const tomlProjectId = yield* legacyReadDbToml(fs, path, workdir, undefined, {
        validate: false,
        warnOnUnresolvedEnv: false,
      }).pipe(
        Effect.map((toml) => toml.projectId),
        Effect.orElseSucceed(() => Option.none<string>()),
      );
      const projectId = legacyResolveLocalProjectId(
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
          () => new LegacyLocalDbRunningError({ message: "failed to inspect service" }),
        ),
      );
      const stderrChunks: Array<Uint8Array> = [];
      yield* Stream.runForEach(child.stderr, (chunk) =>
        Effect.sync(() => {
          stderrChunks.push(chunk);
        }),
      ).pipe(
        Effect.mapError(
          () => new LegacyLocalDbRunningError({ message: "failed to inspect service" }),
        ),
      );
      const inspectExit = yield* child.exitCode.pipe(
        Effect.map(Number),
        Effect.mapError(
          () => new LegacyLocalDbRunningError({ message: "failed to inspect service" }),
        ),
      );
      if (inspectExit === 0) return true; // container exists ⇒ running

      const stderr = decodeChunks(stderrChunks).trim();
      // Only a missing container means "not running". Any other inspect
      // failure propagates, matching Go's `AssertSupabaseDbIsRunning`. Uses the
      // shared, Podman-aware matcher (`legacyIsContainerNotFoundMessage`) rather than a
      // Docker-only substring check, since `spawnContainerCli` above falls back to Podman
      // on Docker-less hosts, and Podman's inspect-miss wording ("no container with name
      // or ID ... found: no such container") differs from Docker's.
      if (!legacyIsContainerNotFoundMessage(stderr)) {
        // Go's `AssertServiceIsRunning` sets `CmdSuggestion = suggestDockerInstall`
        // on a daemon-connection failure (`misc.go:148-154`), so a down daemon
        // still surfaces the actionable Docker Desktop hint, not just raw stderr.
        return yield* Effect.fail(
          new LegacyLocalDbRunningError({
            message:
              stderr.length > 0
                ? `failed to inspect service: ${stderr}`
                : "failed to inspect service",
            ...(legacyIsDockerDaemonUnreachable(stderr)
              ? { suggestion: LEGACY_SUGGEST_DOCKER_INSTALL }
              : {}),
          }),
        );
      }
      return false;
    }),
  );
}
