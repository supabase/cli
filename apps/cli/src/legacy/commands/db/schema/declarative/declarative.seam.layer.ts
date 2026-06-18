import { Effect, FileSystem, Layer, Option, Path, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { LegacyNetworkIdFlag } from "../../../../../shared/legacy/global-flags.ts";
import { resolveBinary } from "../../../../../shared/legacy/go-proxy.layer.ts";
import { LegacyCliConfig } from "../../../../config/legacy-cli-config.service.ts";
import { legacyReadDbToml } from "../../../../shared/legacy-db-config.toml-read.ts";
import {
  legacyResolveLocalProjectId,
  localDbContainerId,
} from "../../../../shared/legacy-docker-ids.ts";
import { LegacyDeclarativeShadowDbError } from "./declarative.errors.ts";
import { LegacyDeclarativeSeam } from "./declarative.seam.service.ts";

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
            ];
            const command = ChildProcess.make(resolved.found, args, {
              cwd: cliConfig.workdir,
              stdin: "inherit",
              stdout: "pipe",
              stderr: "inherit",
              extendEnv: true,
              // For `generate --linked`, pass the resolved ref as SUPABASE_PROJECT_ID
              // so the Go config load merges the `[remotes.<ref>]` override into the
              // platform baseline (viper AutomaticEnv binds it to `project_id`;
              // `config.go:492-516`), matching the monolith. `extendEnv` keeps the
              // rest of the environment.
              ...(projectRef !== undefined ? { env: { SUPABASE_PROJECT_ID: projectRef } } : {}),
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
