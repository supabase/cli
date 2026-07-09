import { Effect, FileSystem, Layer, Option, Path, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import {
  LegacyNetworkIdFlag,
  LegacyProfileFlag,
  legacyResolveExperimental,
} from "../../../../shared/legacy/global-flags.ts";
import { resolveBinary } from "../../../../shared/legacy/go-proxy.layer.ts";
import { LegacyGoChildExitError } from "../../../../shared/legacy/legacy-go-child-exit.error.ts";
import { ProcessControl } from "../../../../shared/runtime/process-control.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { spawnContainerCli } from "../../../shared/legacy-container-cli.ts";
import { legacyReadDbToml } from "../../../shared/legacy-db-config.toml-read.ts";
import {
  legacyResolveLocalProjectId,
  localDbContainerId,
} from "../../../shared/legacy-docker-ids.ts";
import {
  LEGACY_SUGGEST_DOCKER_INSTALL,
  legacyIsDockerDaemonUnreachable,
} from "../../../shared/legacy-docker-suggest.ts";
import { LegacyDbBootstrapError } from "./legacy-db-bootstrap.errors.ts";
import { LegacyDbBootstrapSeam } from "./legacy-db-bootstrap.seam.service.ts";

const seamFailure = (message: string) => new LegacyDbBootstrapError({ message });

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
 * Real {@link LegacyDbBootstrapSeam}: drives the bundled `supabase-go`'s hidden
 * `db __db-bootstrap --mode <m>` command. The binary is resolved exactly like
 * `LegacyGoProxy` (`resolveBinary`); the child's telemetry is disabled and its
 * progress teed to stderr, matching the `db __shadow` seam. `--network-id` and a
 * flag-selected `--profile` are forwarded so the spawned containers land on the
 * same network and the child re-runs Go's identical config resolution.
 */
export const legacyDbBootstrapSeamLayer = Layer.effect(
  LegacyDbBootstrapSeam,
  Effect.gen(function* () {
    const cliConfig = yield* LegacyCliConfig;
    const networkId = yield* LegacyNetworkIdFlag;
    const profile = yield* LegacyProfileFlag;
    const profileArgs = profile !== "supabase" ? ["--profile", profile] : [];
    const networkArgs = Option.isSome(networkId) ? ["--network-id", networkId.value] : [];
    // Forward `--experimental` (env-aware) so the seam's `SetupLocalDatabase` /
    // `apply.MigrateAndSeed` takes Go's experimental schema-file path on a
    // versionless reset/start, matching `viper.GetBool("EXPERIMENTAL")`.
    const experimental = yield* legacyResolveExperimental;
    const experimentalArgs = experimental ? ["--experimental"] : [];
    const spawner = yield* ChildProcessSpawner;
    const processControl = yield* ProcessControl;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolved = resolveBinary();

    /**
     * Run `db __db-bootstrap` with the given mode args. `captureStdout` pipes
     * stdout (for the `await-storage` marker); otherwise stdout is inherited.
     * Returns the captured stdout (empty when inherited).
     */
    const runBootstrap = (modeArgs: ReadonlyArray<string>, captureStdout: boolean) =>
      Effect.scoped(
        Effect.gen(function* () {
          if (!("found" in resolved)) {
            return yield* Effect.fail(
              seamFailure(
                "Could not find the supabase-go binary required to bootstrap the local database.",
              ),
            );
          }
          // `runCli` treats `db start`/`db reset` as self-managed and installs no
          // global signal handler, and this direct child spawn (unlike
          // `LegacyGoProxy.exec`) inherits the foreground process group. Hold
          // SIGINT/SIGTERM/SIGHUP with no-op listeners so an interactive Ctrl-C
          // during container startup/restore does not default-terminate the TS
          // parent out from under the Go child's docker-cleanup path — the parent
          // stays blocked on the child's exit and propagates its real status.
          // Scoped, so the listeners are removed on completion/failure/interrupt.
          yield* processControl.holdSignals(["SIGINT", "SIGTERM", "SIGHUP"]);
          const args = [
            "db",
            "__db-bootstrap",
            ...modeArgs,
            ...networkArgs,
            ...profileArgs,
            ...experimentalArgs,
          ];
          const command = ChildProcess.make(resolved.found, args, {
            cwd: cliConfig.workdir,
            stdin: "inherit",
            stdout: captureStdout ? "pipe" : "inherit",
            stderr: "inherit",
            extendEnv: true,
            // Disable the child's telemetry so the hidden seam never records its
            // own `cli_command_executed` on top of the user's TS command, matching
            // the `db __shadow` seam and the explicit LegacyGoProxy delegates.
            env: { SUPABASE_TELEMETRY_DISABLED: "1" },
            detached: false,
          });
          if (!captureStdout) {
            const exitCode = yield* spawner
              .exitCode(command)
              .pipe(Effect.mapError(() => seamFailure("failed to run supabase-go.")));
            if (exitCode !== 0) {
              // `LegacyGoChildExitError` (not `seamFailure`/`processControl.exit`) so the
              // handler's finalizers — `Effect.ensuring(telemetryState.flush)` + the legacy
              // command instrumentation — still run (an immediate `process.exit` would skip
              // them), AND the child's exact exit code (e.g. 130 after Ctrl-C cleanup) reaches
              // `runCli`'s `processControl.exit()` instead of collapsing to a generic 1. The
              // child's detailed failure is already on the inherited stderr, so `runCli`
              // special-cases this error class to suppress its own normally-would-print
              // generic stderr line — Go itself never prints a second line here. CLI-1879.
              return yield* Effect.fail(
                new LegacyGoChildExitError({
                  exitCode,
                  message: `failed to bootstrap the local database: exit ${exitCode}`,
                }),
              );
            }
            return "";
          }
          const handle = yield* spawner
            .spawn(command)
            .pipe(Effect.mapError(() => seamFailure("failed to run supabase-go.")));
          const chunks: Array<Uint8Array> = [];
          yield* Stream.runForEach(handle.stdout, (chunk) =>
            Effect.sync(() => {
              chunks.push(chunk);
            }),
          ).pipe(Effect.mapError(() => seamFailure("failed to bootstrap the local database.")));
          const exitCode = yield* handle.exitCode.pipe(
            Effect.mapError(() => seamFailure("failed to bootstrap the local database.")),
          );
          if (exitCode !== 0) {
            // See the `!captureStdout` branch above for why `LegacyGoChildExitError`
            // replaces `seamFailure` here — same exact-code + finalizer + no-duplicate-line
            // reasoning (CLI-1879).
            return yield* Effect.fail(
              new LegacyGoChildExitError({
                exitCode,
                message: `failed to bootstrap the local database: exit ${exitCode}`,
              }),
            );
          }
          return decodeChunks(chunks);
        }),
      );

    return LegacyDbBootstrapSeam.of({
      isDbRunning: () =>
        Effect.scoped(
          Effect.gen(function* () {
            // Resolve `utils.DbId` exactly as Go does (env → config.toml → workdir
            // basename); the config.toml read is best-effort (`validate: false`) since
            // the handler has already run Go's `LoadConfig` validation — an invalid
            // config would have failed there, so here we only want the `projectId` and
            // tolerate a fallback to the workdir basename rather than re-throwing.
            const tomlProjectId = yield* legacyReadDbToml(fs, path, cliConfig.workdir, undefined, {
              validate: false,
            }).pipe(
              Effect.map((toml) => toml.projectId),
              // The lenient read still surfaces a genuinely unreadable/malformed project
              // `.env`; fall back to the workdir basename in that case rather than failing
              // the running-check (the handler has already validated config).
              Effect.orElseSucceed(() => Option.none<string>()),
            );
            const projectId = legacyResolveLocalProjectId(
              Option.getOrUndefined(cliConfig.projectId),
              Option.getOrUndefined(tomlProjectId),
              cliConfig.workdir,
            );
            const containerId = localDbContainerId(projectId);
            // Go's AssertSupabaseDbIsRunning = ContainerInspect → NotFound ⇒ not
            // running. Discard stdout (the inspect JSON) so the unconsumed pipe can
            // never deadlock; only the exit code + stderr matter.
            const child = yield* spawnContainerCli(spawner, ["container", "inspect", containerId], {
              stdin: "ignore",
              stdout: "ignore",
              stderr: "pipe",
              extendEnv: true,
            }).pipe(Effect.mapError(() => seamFailure("failed to inspect service")));
            const stderrChunks: Array<Uint8Array> = [];
            yield* Stream.runForEach(child.stderr, (chunk) =>
              Effect.sync(() => {
                stderrChunks.push(chunk);
              }),
            ).pipe(Effect.mapError(() => seamFailure("failed to inspect service")));
            const inspectExit = yield* child.exitCode.pipe(
              Effect.map(Number),
              Effect.mapError(() => seamFailure("failed to inspect service")),
            );
            if (inspectExit === 0) return true; // container exists ⇒ running

            const stderr = decodeChunks(stderrChunks).trim();
            // Only a missing container means "not running". Docker reports this as
            // either "No such container" or "No such object" depending on daemon
            // version/CLI path (the same pair handled in `shared/functions/serve.ts`).
            // Any other inspect failure (e.g. the Docker daemon is down) propagates,
            // matching Go's `AssertSupabaseDbIsRunning`.
            if (!stderr.includes("No such container") && !stderr.includes("No such object")) {
              // Go's `AssertServiceIsRunning` sets `CmdSuggestion = suggestDockerInstall`
              // on a daemon-connection failure (`misc.go:148-154`), so a down daemon
              // still surfaces the actionable Docker Desktop hint, not just raw stderr.
              return yield* Effect.fail(
                new LegacyDbBootstrapError({
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
        ),
      startDatabase: ({ fromBackup }) =>
        runBootstrap(
          ["--mode", "start", ...(fromBackup !== undefined ? ["--from-backup", fromBackup] : [])],
          false,
        ).pipe(Effect.asVoid),
      recreateDatabase: ({ version, noSeed, sqlPaths }) =>
        runBootstrap(
          [
            "--mode",
            "recreate",
            ...(version !== "" ? ["--version", version] : []),
            ...(noSeed ? ["--no-seed"] : []),
            ...sqlPaths.flatMap((p) => ["--sql-paths", p]),
          ],
          false,
        ).pipe(Effect.asVoid),
      awaitStorageReady: () =>
        runBootstrap(["--mode", "await-storage"], true).pipe(
          Effect.map((stdout) => stdout.trim() === "ready"),
        ),
    });
  }),
);
