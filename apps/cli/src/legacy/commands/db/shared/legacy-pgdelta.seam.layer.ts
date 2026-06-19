import { Effect, FileSystem, Layer, Option, Path, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { LegacyNetworkIdFlag, LegacyProfileFlag } from "../../../../shared/legacy/global-flags.ts";
import { resolveBinary } from "../../../../shared/legacy/go-proxy.layer.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { legacyReadDbToml } from "../../../shared/legacy-db-config.toml-read.ts";
import {
  legacyResolveLocalProjectId,
  localDbContainerId,
} from "../../../shared/legacy-docker-ids.ts";
import { LegacyDeclarativeShadowDbError } from "./legacy-pgdelta.errors.ts";
import { LegacyDeclarativeSeam, type LegacyShadowSource } from "./legacy-pgdelta.seam.service.ts";
import { legacyInjectPostgresPassword } from "./legacy-pgdelta.seam.url.ts";

/**
 * Real `LegacyDeclarativeSeam`: runs the bundled `supabase-go`'s hidden
 * `db schema declarative __catalog --mode <m> --experimental` with stdout piped
 * (the catalog path) and stderr inherited (shadow-DB progress / image pulls).
 * The Go binary is resolved exactly like `LegacyGoProxy` (`resolveBinary`).
 */
export const legacyDeclarativeSeamLayer = Layer.effect(
  LegacyDeclarativeSeam,
  Effect.gen(function* () {
    const cliConfig = yield* LegacyCliConfig;
    const networkId = yield* LegacyNetworkIdFlag;
    const profile = yield* LegacyProfileFlag;
    // Forward a flag-selected `--profile` into the hidden seam subprocesses. Go's
    // root loads the profile before config (`cmd/root.go`) and applies
    // profile-specific overrides, but a flag-only `--profile snap` isn't in the
    // child's env (only `SUPABASE_PROFILE` is, via `extendEnv`). Pass the raw flag
    // token (built-in name or YAML path) so the child re-runs Go's identical
    // resolution; skip the default so unselected runs are unchanged.
    const profileArgs = profile !== "supabase" ? ["--profile", profile] : [];
    const spawner = yield* ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolved = resolveBinary();

    return LegacyDeclarativeSeam.of({
      exportCatalog: ({ mode, noCache, projectRef }) =>
        Effect.scoped(
          Effect.gen(function* () {
            if (!("found" in resolved)) {
              return yield* Effect.fail(
                new LegacyDeclarativeShadowDbError({
                  message:
                    "Could not find the supabase-go binary required to provision the shadow database.",
                }),
              );
            }
            const args = [
              "db",
              "schema",
              "declarative",
              "__catalog",
              "--mode",
              mode,
              "--experimental",
              ...(noCache ? ["--no-cache"] : []),
              // The shadow DB is provisioned via DockerStart, which reads the root
              // --network-id from viper (`apps/cli-go/internal/utils/docker.go:267-271`).
              // Forward it on the seam argv so catalog/shadow containers land on the
              // same custom network as the pg-delta containers (LegacyGoProxy forwards
              // it the same way).
              ...(Option.isSome(networkId) ? ["--network-id", networkId.value] : []),
              // Linked path (e.g. `generate --linked`, `db diff --from linked --to
              // migrations`): pass the resolved ref as a flag so the catalog merges
              // the matching `[remotes.<ref>]` override. It MUST be a flag, not
              // SUPABASE_PROJECT_ID env: the `__catalog` command's group pre-run
              // calls `flags.LoadConfig` directly without `LoadProjectRef`, so the
              // env (read only by LoadProjectRef) never reaches the merge — the Go
              // command seeds `flags.ProjectRef` from `--project-ref` before
              // LoadConfig instead (mirrors `db __shadow`).
              ...(projectRef !== undefined ? ["--project-ref", projectRef] : []),
              ...profileArgs,
            ];
            const command = ChildProcess.make(resolved.found, args, {
              cwd: cliConfig.workdir,
              stdin: "inherit",
              stdout: "pipe",
              stderr: "inherit",
              extendEnv: true,
              // Disable the child's telemetry so the hidden `__catalog` seam
              // doesn't emit its own `cli_command_executed` on top of the user's
              // TS command (matching the explicit LegacyGoProxy delegates).
              // `extendEnv` keeps the rest of the environment.
              env: { SUPABASE_TELEMETRY_DISABLED: "1" },
              detached: false,
            });
            const handle = yield* spawner.spawn(command).pipe(
              Effect.mapError(
                () =>
                  new LegacyDeclarativeShadowDbError({
                    message: "failed to run the shadow-database provisioner (supabase-go).",
                  }),
              ),
            );
            const chunks: Array<Uint8Array> = [];
            yield* Stream.runForEach(handle.stdout, (chunk) =>
              Effect.sync(() => {
                chunks.push(chunk);
              }),
            ).pipe(Effect.mapError(() => failure()));
            const exitCode = yield* handle.exitCode.pipe(Effect.mapError(() => failure()));
            if (exitCode !== 0) {
              return yield* Effect.fail(failure(exitCode));
            }
            const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
            const bytes = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.length;
            }
            return new TextDecoder().decode(bytes).trim();
          }),
        ),
      execInherit: (args) =>
        Effect.gen(function* () {
          if (!("found" in resolved)) {
            return yield* Effect.fail(
              new LegacyDeclarativeShadowDbError({
                message: "Could not find the supabase-go binary.",
              }),
            );
          }
          const command = ChildProcess.make(resolved.found, args, {
            cwd: cliConfig.workdir,
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
            extendEnv: true,
            detached: false,
          });
          return yield* spawner
            .exitCode(command)
            .pipe(
              Effect.mapError(
                () => new LegacyDeclarativeShadowDbError({ message: "failed to run supabase-go." }),
              ),
            );
        }),
      ensureLocalDatabaseStarted: () =>
        Effect.scoped(
          Effect.gen(function* () {
            // Go's `utils.DbId` derives from `utils.Config.ProjectId`, which viper sets
            // from config.toml's `project_id` and then overrides via `AutomaticEnv` with
            // `SUPABASE_PROJECT_ID`. So the env override wins over config.toml, which wins
            // over the workdir basename (matches `gen types`). `cliConfig.projectId` is
            // exactly `SUPABASE_PROJECT_ID`; the config.toml read is best-effort (the
            // handler already validated config, so a re-read error falls back).
            const tomlProjectId = yield* legacyReadDbToml(fs, path, cliConfig.workdir).pipe(
              Effect.map((toml) => toml.projectId),
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
            const inspect = ChildProcess.make("docker", ["container", "inspect", containerId], {
              stdin: "ignore",
              stdout: "ignore",
              stderr: "pipe",
              extendEnv: true,
            });
            const child = yield* spawner
              .spawn(inspect)
              .pipe(
                Effect.mapError(
                  () =>
                    new LegacyDeclarativeShadowDbError({ message: "failed to inspect service" }),
                ),
              );
            const stderrChunks: Array<Uint8Array> = [];
            yield* Stream.runForEach(child.stderr, (chunk) =>
              Effect.sync(() => {
                stderrChunks.push(chunk);
              }),
            ).pipe(
              Effect.mapError(
                () => new LegacyDeclarativeShadowDbError({ message: "failed to inspect service" }),
              ),
            );
            const inspectExit = yield* child.exitCode.pipe(
              Effect.map(Number),
              Effect.mapError(
                () => new LegacyDeclarativeShadowDbError({ message: "failed to inspect service" }),
              ),
            );
            if (inspectExit === 0) return; // already running

            const stderr = new TextDecoder()
              .decode(
                (() => {
                  const total = stderrChunks.reduce((s, c) => s + c.length, 0);
                  const bytes = new Uint8Array(total);
                  let offset = 0;
                  for (const c of stderrChunks) {
                    bytes.set(c, offset);
                    offset += c.length;
                  }
                  return bytes;
                })(),
              )
              .trim();
            // Only a missing container means "not running" → start it. Any other
            // inspect failure (e.g. Docker daemon down) propagates, matching Go.
            if (!stderr.includes("No such container")) {
              return yield* Effect.fail(
                new LegacyDeclarativeShadowDbError({
                  message:
                    stderr.length > 0
                      ? `failed to inspect service: ${stderr}`
                      : "failed to inspect service",
                }),
              );
            }
            if (!("found" in resolved)) {
              return yield* Effect.fail(
                new LegacyDeclarativeShadowDbError({
                  message:
                    "Could not find the supabase-go binary required to start the local stack.",
                }),
              );
            }
            // Start ONLY the database via `supabase-go db start` — Go's
            // `ensureLocalDatabaseStarted` calls the DB-only `internal/db/start.Run`
            // (`cmd/db_schema_declarative.go:191`), the same path `supabase db start`
            // uses (`cmd/db.go:267-273`), not the full `supabase start` stack. This
            // avoids failing on unavailable auth/storage/etc. ports or images.
            // Forward --network-id: Go's `DockerStart` reads the root viper network-id
            // (`internal/utils/docker.go:267-271`), so the spawned start must carry it.
            const startArgs = [
              "db",
              "start",
              ...(Option.isSome(networkId) ? ["--network-id", networkId.value] : []),
              ...profileArgs,
            ];
            const startCmd = ChildProcess.make(resolved.found, startArgs, {
              cwd: cliConfig.workdir,
              stdin: "inherit",
              stdout: "inherit",
              stderr: "inherit",
              extendEnv: true,
              detached: false,
            });
            const startExit = yield* spawner.exitCode(startCmd).pipe(
              Effect.mapError(
                () =>
                  new LegacyDeclarativeShadowDbError({
                    message: "failed to start local database.",
                  }),
              ),
            );
            if (startExit !== 0) {
              return yield* Effect.fail(
                new LegacyDeclarativeShadowDbError({
                  message: `failed to start local database: exit ${startExit}`,
                }),
              );
            }
          }),
        ),
      provisionShadow: ({ mode, targetLocal, usePgDelta, schema, projectRef }) =>
        Effect.scoped(
          Effect.gen(function* () {
            if (!("found" in resolved)) {
              return yield* Effect.fail(
                new LegacyDeclarativeShadowDbError({
                  message:
                    "Could not find the supabase-go binary required to provision the shadow database.",
                }),
              );
            }
            const args = [
              "db",
              "__shadow",
              "--mode",
              mode,
              ...(targetLocal ? ["--target-local"] : []),
              ...(usePgDelta ? ["--use-pg-delta"] : []),
              ...(schema.length > 0 ? ["--schema", schema.join(",")] : []),
              ...(Option.isSome(networkId) ? ["--network-id", networkId.value] : []),
              // Linked path only: pass the resolved ref so the hidden `db __shadow`
              // child's LoadConfig merges the matching `[remotes.<ref>]` override
              // into the shadow baseline (db.major_version, service enables, vault),
              // matching the Go monolith which builds the shadow from the
              // remote-merged config. A flag (not env) keeps the Go-proxy channel
              // parity and avoids over-merging on local/db-url shadows.
              ...(projectRef !== undefined ? ["--project-ref", projectRef] : []),
              ...profileArgs,
            ];
            const command = ChildProcess.make(resolved.found, args, {
              cwd: cliConfig.workdir,
              stdin: "inherit",
              stdout: "pipe",
              stderr: "inherit",
              extendEnv: true,
              // Disable the child's telemetry so the hidden `db __shadow` seam
              // doesn't record its own `cli_command_executed` (and run Go post-run
              // work) on top of the user's TS command, matching the explicit
              // LegacyGoProxy delegates which set the same env.
              env: { SUPABASE_TELEMETRY_DISABLED: "1" },
              detached: false,
            });
            const handle = yield* spawner.spawn(command).pipe(
              Effect.mapError(
                () =>
                  new LegacyDeclarativeShadowDbError({
                    message: "failed to run the shadow-database provisioner (supabase-go).",
                  }),
              ),
            );
            const chunks: Array<Uint8Array> = [];
            yield* Stream.runForEach(handle.stdout, (chunk) =>
              Effect.sync(() => {
                chunks.push(chunk);
              }),
            ).pipe(Effect.mapError(() => failure()));
            const exitCode = yield* handle.exitCode.pipe(Effect.mapError(() => failure()));
            if (exitCode !== 0) {
              return yield* Effect.fail(failure(exitCode));
            }
            const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
            const bytes = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.length;
            }
            // stdout is three newline-separated lines: container id, source URL,
            // and an optional target-override URL (empty unless the local-target
            // declarative branch redirected the target to a second shadow db).
            // The URLs arrive WITHOUT a password — the Go seam prints them via
            // ToPostgresURLWithoutPassword so it never logs a credential to stdout
            // (CWE-312). The shadow uses the local Postgres password, so we re-inject
            // the password resolved from config.toml before handing the URLs to the
            // differ / sql-pg connection. On the linked path the child built the
            // shadow from the remote-merged config (via --project-ref), so re-read
            // with the same ref to pick up a `[remotes.<ref>].db.password` override —
            // otherwise the injected password wouldn't match the shadow's and the
            // connection would fail auth. Absent (local/db-url) → base config.
            const lines = new TextDecoder().decode(bytes).split(/\r?\n/u);
            const container = (lines[0] ?? "").trim();
            const sourceUrl = (lines[1] ?? "").trim();
            const targetOverride = (lines[2] ?? "").trim();
            if (container.length === 0 || sourceUrl.length === 0) {
              return yield* Effect.fail(failure());
            }
            const password = yield* legacyReadDbToml(fs, path, cliConfig.workdir, projectRef).pipe(
              Effect.map((toml) => toml.password),
              Effect.mapError(
                () =>
                  new LegacyDeclarativeShadowDbError({
                    message:
                      "failed to read the local database password from config.toml to connect to the shadow database.",
                  }),
              ),
            );
            return {
              container,
              sourceUrl: legacyInjectPostgresPassword(sourceUrl, password),
              targetUrlOverride:
                targetOverride.length > 0
                  ? legacyInjectPostgresPassword(targetOverride, password)
                  : undefined,
            } satisfies LegacyShadowSource;
          }),
        ),
      removeShadowContainer: (container) =>
        Effect.gen(function* () {
          if (container.length === 0) return;
          // Remove the shadow left running by provisionShadow. Best-effort — a
          // failure here must never mask the diff result. `-v` removes the
          // Postgres anonymous data volume too, matching Go's `DockerRemove`
          // (`RemoveOptions{RemoveVolumes: true, Force: true}`,
          // `internal/utils/docker.go:330`); without it every shadow leaves a
          // dangling volume behind.
          const command = ChildProcess.make("docker", ["rm", "-f", "-v", container], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            extendEnv: true,
          });
          yield* spawner.exitCode(command).pipe(Effect.ignore);
        }),
    });
  }),
);

const failure = (exitCode?: number) =>
  new LegacyDeclarativeShadowDbError({
    message:
      exitCode === undefined
        ? "failed to provision the shadow database."
        : `failed to provision the shadow database: exit ${exitCode}`,
  });
