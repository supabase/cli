import { Effect, FileSystem, Layer, Option, Path, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { LegacyNetworkIdFlag, LegacyProfileFlag } from "../../../../shared/legacy/global-flags.ts";
import { resolveBinary } from "../../../../shared/legacy/go-proxy.layer.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { spawnContainerCli } from "../../../shared/legacy-container-cli.ts";
import { legacyResolveDbImage } from "../../../shared/legacy-db-image.ts";
import { legacyReadDbToml } from "../../../shared/legacy-db-config.toml-read.ts";
import { legacyGetRegistryImageUrl } from "../../../shared/legacy-docker-registry.ts";
import { legacyIsDockerDaemonUnreachable } from "../../../shared/legacy-docker-suggest.ts";
import {
  legacyResolveLocalProjectId,
  localDbContainerId,
} from "../../../shared/legacy-docker-ids.ts";
import { LegacyDeclarativeShadowDbError } from "./legacy-pgdelta.errors.ts";
import { LegacyDeclarativeSeam } from "./legacy-pgdelta.seam.service.ts";

const legacyShadowDockerCause = (
  stderr: string,
): { readonly docker: "daemon" } | Record<never, never> =>
  legacyIsDockerDaemonUnreachable(stderr) ? { docker: "daemon" } : {};

/**
 * Real `LegacyDeclarativeSeam`: runs the bundled `supabase-go`'s hidden
 * `db schema declarative __catalog --mode <m> --experimental` with stdout piped
 * (the catalog path) and stderr inherited (shadow-DB progress / image pulls).
 * The Go binary is resolved exactly like `LegacyGoProxy` (`resolveBinary`).
 *
 * `exportCatalog`'s `mode` is now restricted to `"baseline" | "declarative"`
 * (CLI-1959 removed `"migrations"` from `LegacyCatalogMode` — see that type's
 * doc comment in `legacy-pgdelta.seam.service.ts` for why those two modes still
 * need this hidden Go command while `"migrations"` no longer does).
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
              // LoadConfig instead (the same trick the Go `db __shadow` hidden
              // command used to use, before CLI-1956 removed it in favor of a
              // native shadow-provisioning port).
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
              env: { SUPABASE_TELEMETRY_DISABLED: "1", SUPABASE_NO_UPDATE_NOTIFIER: "1" },
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
            const child = yield* spawnContainerCli(spawner, ["container", "inspect", containerId], {
              stdin: "ignore",
              stdout: "ignore",
              stderr: "pipe",
              extendEnv: true,
            }).pipe(
              Effect.mapError(
                () =>
                  new LegacyDeclarativeShadowDbError({
                    message: "failed to inspect service",
                    docker: "daemon",
                  }),
              ),
            );
            const stderrChunks: Array<Uint8Array> = [];
            yield* Stream.runForEach(child.stderr, (chunk) =>
              Effect.sync(() => {
                stderrChunks.push(chunk);
              }),
            ).pipe(
              Effect.mapError(
                () =>
                  new LegacyDeclarativeShadowDbError({
                    message: "failed to inspect service",
                    docker: "daemon",
                  }),
              ),
            );
            const inspectExit = yield* child.exitCode.pipe(
              Effect.map(Number),
              Effect.mapError(
                () =>
                  new LegacyDeclarativeShadowDbError({
                    message: "failed to inspect service",
                    docker: "daemon",
                  }),
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
            // Only a missing container means "not running" → start it. Docker reports
            // this as either "No such container" or "No such object" (the same pair
            // handled in `shared/functions/serve.ts`). Any other inspect failure (e.g.
            // Docker daemon down) propagates, matching Go.
            if (!stderr.includes("No such container") && !stderr.includes("No such object")) {
              return yield* Effect.fail(
                new LegacyDeclarativeShadowDbError({
                  message:
                    stderr.length > 0
                      ? `failed to inspect service: ${stderr}`
                      : "failed to inspect service",
                  ...legacyShadowDockerCause(stderr),
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
              // The TS parent owns the upgrade notice; this child's stderr is inherited.
              env: { SUPABASE_NO_UPDATE_NOTIFIER: "1" },
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
      ensureLocalPostgresImageCurrent: () =>
        Effect.scoped(
          Effect.gen(function* () {
            const toml = yield* legacyReadDbToml(fs, path, cliConfig.workdir).pipe(
              Effect.mapError(
                (error) =>
                  new LegacyDeclarativeShadowDbError({
                    message: `failed to read config for local Postgres image check: ${error.message}`,
                  }),
              ),
            );
            const image = yield* legacyResolveDbImage(
              fs,
              path,
              cliConfig.workdir,
              toml.majorVersion,
              Option.getOrUndefined(toml.orioledbVersion),
            );
            const tomlProjectId = toml.projectId;
            const projectId = legacyResolveLocalProjectId(
              Option.getOrUndefined(cliConfig.projectId),
              Option.getOrUndefined(tomlProjectId),
              cliConfig.workdir,
            );
            const containerId = localDbContainerId(projectId);
            const child = yield* spawnContainerCli(spawner, ["container", "inspect", containerId], {
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
              extendEnv: true,
            }).pipe(
              Effect.mapError(
                () =>
                  new LegacyDeclarativeShadowDbError({
                    message: "failed to inspect local Postgres container.",
                    docker: "daemon",
                  }),
              ),
            );
            const stdoutChunks: Array<Uint8Array> = [];
            const stderrChunks: Array<Uint8Array> = [];
            yield* Stream.runForEach(child.stdout, (chunk) =>
              Effect.sync(() => {
                stdoutChunks.push(chunk);
              }),
            ).pipe(
              Effect.mapError(
                () =>
                  new LegacyDeclarativeShadowDbError({
                    message: "failed to inspect local Postgres container.",
                    docker: "daemon",
                  }),
              ),
            );
            yield* Stream.runForEach(child.stderr, (chunk) =>
              Effect.sync(() => {
                stderrChunks.push(chunk);
              }),
            ).pipe(
              Effect.mapError(
                () =>
                  new LegacyDeclarativeShadowDbError({
                    message: "failed to inspect local Postgres container.",
                    docker: "daemon",
                  }),
              ),
            );
            const inspectExit = yield* child.exitCode.pipe(
              Effect.map(Number),
              Effect.mapError(
                () =>
                  new LegacyDeclarativeShadowDbError({
                    message: "failed to inspect local Postgres container.",
                    docker: "daemon",
                  }),
              ),
            );
            const decodeChunks = (chunks: ReadonlyArray<Uint8Array>): string => {
              const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
              const bytes = new Uint8Array(total);
              let offset = 0;
              for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.length;
              }
              return new TextDecoder().decode(bytes).trim();
            };
            const stderr = decodeChunks(stderrChunks);
            const stdout = decodeChunks(stdoutChunks);
            if (inspectExit !== 0) {
              if (legacyIsMissingContainerInspectError(stderr)) return;
              return yield* Effect.fail(
                new LegacyDeclarativeShadowDbError({
                  message:
                    stderr.length > 0
                      ? `failed to inspect local Postgres container: ${stderr}`
                      : "failed to inspect local Postgres container.",
                  ...legacyShadowDockerCause(stderr),
                }),
              );
            }
            const actual = legacyResolveContainerInspectImageName(stdout);
            const expected = legacyGetRegistryImageUrl(image).trim();
            const actualTag = dockerImageTag(actual);
            const expectedTag = dockerImageTag(expected);
            if (actualTag.length === 0 || expectedTag.length === 0 || actualTag === expectedTag) {
              return;
            }
            return yield* Effect.fail(
              new LegacyDeclarativeShadowDbError({
                message: `local Postgres container image is stale: running ${actual} but expected ${expected}. Run supabase stop --all --no-backup, then supabase start before syncing declarative schemas.`,
              }),
            );
          }),
        ),
    });
  }),
);

// Intentionally NOT `LegacyGoChildExitError` (contrast the now-removed `db __db-bootstrap`
// seam, fixed under CLI-1879): this seam's failure is a TS-authored domain summary over noisy
// docker/pgdelta child stderr, not a passthrough of a real Go-CLI child the user invoked
// directly — Go itself wraps every shadow-DB failure into a generic error that `cmd/root.go`'s
// `recoverAndExit` exits `1` for, so propagating THIS child's exact exit code would itself
// diverge from Go, and suppressing this message (as `LegacyGoChildExitError` does for its own,
// already-detailed child stderr) would drop the only actionable line the user sees.
const failure = (exitCode?: number) =>
  new LegacyDeclarativeShadowDbError({
    message:
      exitCode === undefined
        ? "failed to provision the shadow database."
        : `failed to provision the shadow database: exit ${exitCode}`,
  });

function dockerImageTag(image: string): string {
  const trimmed = image.trim();
  const index = trimmed.lastIndexOf(":");
  if (index < 0 || index === trimmed.length - 1) return "";
  return trimmed.slice(index + 1);
}

export function legacyIsMissingContainerInspectError(stderr: string): boolean {
  return stderr.toLowerCase().includes("no such container");
}

export function legacyResolveContainerInspectImageName(stdout: string): string {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
  const inspect = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!isJsonRecord(inspect)) return "";
  const imageName = inspect["ImageName"];
  if (typeof imageName === "string" && imageName.trim().length > 0) {
    return imageName.trim();
  }
  const config = inspect["Config"];
  if (!isJsonRecord(config)) return "";
  const configImage = config["Image"];
  return typeof configImage === "string" && configImage.trim().length > 0 ? configImage.trim() : "";
}

function isJsonRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null;
}
