/**
 * Post-Postgres-health local database setup pipeline — a strict 1:1 port of Go's
 * `SetupLocalDatabase` (`apps/cli-go/internal/db/start/start.go:359-381`), run once
 * the `db` container's healthcheck passes on a FRESH volume (Go's `NoBackupVolume`
 * gate, `start.go:184` — the caller decides whether to invoke this at all; see
 * `legacyStartVolumeExists` in `./container-lifecycle.ts`). The single exported
 * entry point, {@link legacyStartSetupLocalDatabase}, runs the exact Go call chain
 * in order:
 *
 * 1. **`initSchema`** (`start.go:243-266`) — prints `Initialising schema...`, then
 *    branches on `db.major_version`:
 *    - **PG <= 14**: execs {@link LEGACY_START_DB_GLOBALS_SQL} (`utils.GlobalsSql`)
 *      then either {@link LEGACY_START_DB_INITIAL_SCHEMA_13_SQL} or
 *      {@link LEGACY_START_DB_INITIAL_SCHEMA_14_SQL} (`InitSchema14`, `start.go:256-266`,
 *      keyed on `major_version == 13`), each via `legacyExecSqlFile` against a temp file.
 *    - **PG >= 15** (`initSchema15`, `start.go:334-357`): runs up to three one-shot,
 *      foreground Docker jobs (`utils.DockerRunJob` = `DockerRunOnceWithStream`, a
 *      run-to-completion container on the SAME Docker network as `db` — Go's
 *      `DockerStart` defaults `NetworkMode` to `utils.NetId` when unset,
 *      `docker.go:379-383`), each gated on its own service's `enabled` flag and none
 *      of which touch `conn` directly:
 *      - `initRealtimeJob` (`start.go:268-295`) — reuses
 *        `./realtime-env.ts`'s `legacyBuildRealtimeEnv`, which builds
 *        the byte-identical env-var literal Go's own `initRealtimeJob` embeds
 *        verbatim (both are the same Go `Env` list, just addressed from two call
 *        sites: the long-running container and this one-shot job).
 *      - `initStorageJob` (`start.go:297-317`) — a DELIBERATELY SMALLER, differently-
 *        keyed env set than the long-running Storage container's own
 *        `storage.service.ts` builder (`PGRST_JWT_SECRET` not `AUTH_JWT_SECRET`,
 *        `STORAGE_FILE_BACKEND_PATH` not `FILE_STORAGE_BACKEND_PATH`, `REGION` not
 *        `STORAGE_S3_REGION`, no JWKS) — built locally, not reused.
 *      - `initAuthJob` (`start.go:319-332`) — ditto, a minimal env distinct from
 *        `gotrue.service.ts`'s full container builder.
 * 2. **`ApplyApiPrivileges`** (`start.go:414-435`) — tri-state on
 *    `api.auto_expose_new_tables`: `true` is a no-op (keep the bundled initial-schema
 *    grants); unset/`false` execs {@link LEGACY_START_REVOKE_API_PRIVILEGES_SQL}
 *    (Go's inline `RevokeDefaultDataApiPrivilegesSql` constant, `start.go:405-412`)
 *    via a temp file, same as the schema SQL above.
 * 3. **Vault upsert** (`start.go:390-393`) — `legacyUpsertVaultSecrets`, run BEFORE
 *    the custom-roles seed "so roles.sql can reference them" (Go's own comment).
 * 4. **Custom-roles seed** (`start.go:394-398` + `pkg/migration/seed.go:84-97`) —
 *    prints "Seeding globals from roles.sql..." UNCONDITIONALLY, BEFORE checking
 *    whether `supabase/roles.sql` even exists (Go's `SeedGlobals` prints first,
 *    then attempts the read), then execs the file via `legacyExecSqlFile` only when
 *    it's actually present. A missing file is tolerated (Go's `errors.Is(err,
 *    os.ErrNotExist)` check, reproduced here as an existence check ahead of the read
 *    rather than a caught not-found error — see the call site's own comment for why);
 *    any other read/exec error propagates.
 * 5. **`apply.MigrateAndSeed`** (`start.go:368`, via the already-ported
 *    `legacyMigrateAndSeed`) with `version: ""` — every pending migration, matching
 *    `SetupLocalDatabase`'s own call in the `start` context.
 * 6. **`pgcache.TryCacheMigrationsCatalog`** (`start.go:371-379`) — a best-effort
 *    warmup of the `catalog-local-migrations-*` snapshot subsequent pg-delta
 *    workflows (`db diff`/`db push`) consume, via the already-ported
 *    `legacyTryCacheMigrationsCatalog` ({@link legacy-pgdelta.cache.ts}, the exact
 *    same function `db push` already calls after its own migration apply). Gated
 *    identically to Go's `ShouldCacheMigrationsCatalog()` (`pgcache/cache.go:93-95`):
 *    `toml.pgDelta.enabled` OR the `SUPABASE_EXPERIMENTAL_PG_DELTA` env override —
 *    Go's other half of the gate, `len(version) == 0`, is unconditionally true here
 *    since step 5 above always runs with `version: ""`. A failure prints Go's exact
 *    warning (`Warning: failed to cache migrations catalog: <err>`, `start.go:378`)
 *    to stderr and is otherwise swallowed, reusing the identical best-effort
 *    catch/warn shape `legacy-db-push-core.ts` already established for its own call
 *    — this step never fails {@link legacyStartSetupLocalDatabase} or the caller's
 *    `start`/`db start` run. Requires `LegacyEdgeRuntimeScript`/`LegacyPgDeltaSslProbe`
 *    in this function's own effect environment (widened accordingly below), so both
 *    `start.command.ts` and `db/start/start.layers.ts` now compose
 *    `legacyEdgeRuntimeScriptLayer`/`legacyPgDeltaSslProbeLayer`, matching `db push`'s
 *    own layer composition (`push.layers.ts`). The underlying `legacyExportCatalogPgDelta`
 *    reads `PGDELTA_NPM_REGISTRY` straight off bare `process.env` ({@link
 *    legacy-pgdelta.ts}'s `legacyPgDeltaNpmRegistryOption`) — Go's `Config.Load` already
 *    `os.Setenv`'d the project `.env` into the process before `start`/`db start` ever
 *    reaches this call (`loadNestedEnv`, `config.go:788`), so a registry override set
 *    only in `supabase/.env` (not the shell) must be visible here too. This module never
 *    mutates `process.env` globally the way `start`/`db start`'s own config resolution
 *    does — every other Go env override is threaded explicitly via `projectEnvValues` —
 *    so this ONE call is scoped with `legacyApplyProjectEnv` (the same opt-in helper
 *    `db push`/`db pull`/`db dump`/`bootstrap` already use around their own pg-delta/image
 *    work) for just its own duration, then reverted.
 *
 * Go's `initCurrentBranch` (`start.go:233-241`, writes `supabase/.branches/
 * _current_branch` = `"main"` if absent) is NOT part of this pipeline, even though
 * it's exported from this module ({@link legacyStartInitCurrentBranch}): in Go it's
 * called by `StartDatabase` (the caller of `SetupLocalDatabase`) UNCONDITIONALLY,
 * regardless of `NoBackupVolume` (`start.go:184-189`) — unlike everything above,
 * which only runs on a fresh volume. `start.handler.ts` calls it directly, outside
 * the `isFreshVolume` gate that wraps {@link legacyStartSetupLocalDatabase}.
 *
 * This module also duplicates ONE config-load pass: `legacyCheckDbToml` is called
 * internally (not threaded in from the caller) to resolve `[db.vault]`, `[db.seed]`,
 * `db.migrations.enabled`, and the effective `api.auto_expose_new_tables` tri-state —
 * the same accepted duplication `db start`'s own handler (`commands/db/start/
 * start.handler.ts`) already takes independently of the top-level `supabase start`
 * command's own config resolution.
 */

import type { ProjectConfig } from "@supabase/config";
import { Data, Effect, type FileSystem, Option, type Path } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { Output } from "../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { legacyTryCacheMigrationsCatalog } from "../legacy-pgdelta.cache.ts";
import type { LegacyPgDeltaContext } from "../legacy-pgdelta.ts";
import { legacyParseBoolEnv } from "../legacy-diff-engine.ts";
import type { LegacyDbSession } from "../legacy-db-connection.service.ts";
import { LegacyDbConfigLoadError } from "../legacy-db-config.errors.ts";
import { redactLegacyConnectionString } from "../legacy-db-config.parse.ts";
import { legacyApplyProjectEnv, legacyCheckDbToml } from "../legacy-db-config.toml-read.ts";
import { LEGACY_CLI_PROJECT_LABEL, legacyServiceContainerName } from "../legacy-docker-ids.ts";
import { LegacyDockerRun, type LegacyDockerRunOpts } from "../legacy-docker-run.service.ts";
import { LegacyEdgeRuntimeScript } from "../legacy-edge-runtime-script.service.ts";
import { legacyEnsureImagesCached, type LegacyImagePrepullError } from "./image-prepull.ts";
import { legacyMigrateAndSeed } from "../legacy-migrate-and-seed.ts";
import { LegacyMigrationApplyError, legacyExecSqlFile } from "../legacy-migration-apply.ts";
import type { LegacyMigrationSeedError } from "../legacy-seed.ts";
import { LegacyPgDeltaSslProbe } from "../legacy-pgdelta-ssl-probe.service.ts";
import { ramInBytes } from "../legacy-size-units.ts";
import { LegacyMigrationVaultError, legacyUpsertVaultSecrets } from "../legacy-vault.ts";
import { LEGACY_COMPOSE_PROJECT_LABEL } from "./container-lifecycle.ts";
import { LEGACY_REALTIME_TENANT_ID, legacyBuildRealtimeEnv } from "./realtime-env.ts";
import { LEGACY_START_DB_GLOBALS_SQL } from "./templates/db-globals.sql.ts";
import { LEGACY_START_DB_INITIAL_SCHEMA_13_SQL } from "./templates/db-initial-schema-13.sql.ts";
import { LEGACY_START_DB_INITIAL_SCHEMA_14_SQL } from "./templates/db-initial-schema-14.sql.ts";
import {
  legacyStartInternalDbPassword,
  legacyStartInternalDbUrl,
} from "./internal-db-connection.ts";

type Spawner = ChildProcessSpawner["Service"];

/**
 * Go's inline `RevokeDefaultDataApiPrivilegesSql` constant (`start.go:405-412`) —
 * NOT a `//go:embed` file (unlike the three large SQL templates), so transcribed
 * directly here rather than as a sibling `templates/*.sql.ts` module.
 */
const LEGACY_START_REVOKE_API_PRIVILEGES_SQL = `
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke usage, select on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated, service_role;
`;

/**
 * A SQL exec (schema/globals/API-privileges) or one-shot service-migration Docker
 * job failed, or the scratch temp directory/file could not be created. The Docker
 * job branch's message mirrors Go's `DockerRunOnceWithStream` failure shape
 * (`errors.Errorf("error running container: %w", err)`, `apps/cli-go/internal/
 * utils/docker.go:469-487,559-591` — Go discards the container's own stdout/stderr
 * outside `--debug`, so only the exit code is meaningful here too).
 */
export class LegacyStartDbSetupError extends Data.TaggedError("LegacyStartDbSetupError")<{
  readonly message: string;
}> {}

/** Every failure {@link legacyStartSetupLocalDatabase} can produce. */
export type LegacyStartSetupLocalDatabaseError =
  | LegacyDbConfigLoadError
  | LegacyStartDbSetupError
  | LegacyMigrationVaultError
  | LegacyMigrationApplyError
  | LegacyMigrationSeedError
  | LegacyImagePrepullError;

/** Already-resolved Docker images for the three PG15+ one-shot migrate jobs (`initSchema15`'s `initJobs`). */
export interface LegacyStartDbSetupImages {
  /** `utils.Config.Realtime.Image`, resolved by the caller (not part of the decoded `ProjectConfig` schema — `toml:"-"`). */
  readonly realtime: string;
  /** `utils.Config.Storage.Image`, ditto. */
  readonly storage: string;
  /** `utils.Config.Auth.Image`, ditto. */
  readonly auth: string;
}

/** Input to {@link legacyStartSetupLocalDatabase}. */
export interface LegacyStartSetupLocalDatabaseInput {
  /**
   * An already-open session to the local Postgres database, dialed the same way
   * Go's `ConnectLocalPostgres(ctx, pgconn.Config{})` does (`internal/utils/
   * connect.go:144-167`): the HOST-facing address (`legacyGetHostname()` +
   * `db.port`, user `postgres`, `isLocal: true`) — the SAME shape `legacy-db-
   * config.layer.ts`'s own `--local` branch already dials (`legacy-db-config.
   * layer.ts:518-529`). This is deliberately NOT the internal Docker-network `db`
   * container address the PG15+ one-shot jobs below connect through (see
   * `networkId`/`projectId`) — the two addressing schemes are independent, exactly
   * like Go's `conn` (host-facing) vs. `host` parameter (`utils.DbId`) in
   * `SetupDatabase(ctx, conn, utils.DbId, w, fsys)`.
   */
  readonly session: LegacyDbSession;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  /** The Supabase project root (parent of `supabase/`). */
  readonly workdir: string;
  /** The caller's already-resolved, effective config (env overrides already applied). */
  readonly config: ProjectConfig;
  /** `db.major_version` (13-17) — Go's `utils.Config.Db.MajorVersion`, resolved by the caller once, ahead of the `db` container's own image tag selection. */
  readonly majorVersion: number;
  /** Go's `Config.ProjectId`, already sanitized (`legacySanitizeProjectId`) — derives the `db` container's internal Docker name for the PG15+ one-shot jobs (`legacyServiceContainerName("db", projectId)`, Go's `utils.DbId`). */
  readonly projectId: string;
  /**
   * `--experimental`/`SUPABASE_EXPERIMENTAL`, resolved by the caller (Go's
   * `viper.GetBool("EXPERIMENTAL")`) — threaded straight into
   * {@link legacyMigrateAndSeed}'s own `experimental` gate (`internal/migration/apply/
   * apply.go:19`); this module has no other use for it.
   */
  readonly experimental: boolean;
  /** The `start` run's Docker network id (Go's `utils.NetId` or the `--network-id` override) — every PG15+ one-shot job joins it, matching `DockerStart`'s own default (`docker.go:379-383`). */
  readonly networkId: string;
  /** `LegacyLocalConfigValues.dbUrl` — reused (not recomputed) to derive the internal DB password via `legacyStartInternalDbPassword`, matching every other `start/services/*.service.ts` builder. */
  readonly dbUrl: string;
  /** `LegacyLocalConfigValues.jwtSecret`. */
  readonly jwtSecret: string;
  /** `legacyResolveLocalJwks`'s resolved JWKS JSON string (only read when `realtime.enabled`) — already built by the caller, not recomputed here. */
  readonly jwks: string;
  /** `LegacyLocalConfigValues.apiUrl` — the auth job's `API_EXTERNAL_URL` falls back to this, `/auth/v1`-suffixed, only when {@link authExternalUrl} is unset. */
  readonly apiUrl: string;
  /**
   * Raw `auth.external_url` (already `SUPABASE_AUTH_EXTERNAL_URL`-overridden
   * by the caller) — Go's `Config.Auth.ExternalUrl`/`AuthExternalURL()`
   * (`pkg/config/config.go:543-545`, `auth.go:401-405`): an explicit value
   * wins over the `apiUrl`-derived fallback, same as `gotrue.service.ts`'s
   * `LegacyBuildGotrueEnvInput.authExternalUrl` for the long-running
   * container — this one-shot job must resolve to the SAME value so a fresh
   * database's auth migration never disagrees with the container it's
   * migrating for.
   */
  readonly authExternalUrl?: string;
  /**
   * `LegacyLocalConfigValues.authSiteUrl` (already `SUPABASE_AUTH_SITE_URL`-
   * overridden by the caller) — Go's `initAuthJob` reads the same overridden
   * `utils.Config.Auth.SiteUrl` the long-running GoTrue container does
   * (`apps/cli-go/internal/db/start/start.go:327`, `internal/start/
   * start.go:1365`), so this one-shot job must resolve to the SAME value,
   * not the raw `config.auth.site_url` — same rationale as
   * {@link authExternalUrl} above.
   */
  readonly siteUrl: string;
  /** `LegacyLocalConfigValues.anonKey`. */
  readonly anonKey: string;
  /** `LegacyLocalConfigValues.serviceRoleKey`. */
  readonly serviceRoleKey: string;
  /** Go's `utils.Config.Storage.TargetMigration` (`toml:"-"`, resolved from a version-pin file) — the caller passes `""` when absent, matching Go's zero-value default. */
  readonly storageTargetMigration: string;
  readonly images: LegacyStartDbSetupImages;
  /**
   * Project-`.env`-scoped `SUPABASE_INTERNAL_IMAGE_REGISTRY`/mirror overrides — threaded
   * through to each one-shot migrate job's OWN per-image `legacyEnsureImagesCached` resolve
   * (see {@link legacyRunStartMigrateJob}), matching Go's real process-env registry override,
   * which applies uniformly to every `DockerResolveImageIfNotCached` call regardless of which
   * code path triggers it. `LegacyDockerRun.runCapture`'s own ambient-only ChildProcessSpawner-
   * scoped ancestor resolver (used for the long-running containers) does NOT see this — it only
   * reads bare `process.env`.
   */
  readonly projectEnvValues: Readonly<Record<string, string>> | undefined;
  /**
   * `--debug` — threaded to each PG15+ one-shot migrate job (see
   * {@link legacyRunStartMigrateJob}'s own doc comment) so a failed Realtime/Storage/Auth
   * migration job's own stderr is visible, matching Go's `initSchema15` passing
   * `utils.GetDebugLogger()` as the job's stderr writer (`start.go:349-353`).
   */
  readonly debug: boolean;
}

const errMessage = (e: unknown): string =>
  typeof e === "object" && e !== null && "message" in e && typeof e.message === "string"
    ? e.message
    : String(e);

/**
 * Writes `sql` to `<tmpDir>/<filename>` and execs it via `legacyExecSqlFile`
 * (Go's `migration.NewMigrationFromReader(strings.NewReader(sql))` +
 * `file.ExecBatch(ctx, conn)` on an in-memory string — there is no on-disk file in
 * Go at all; this port needs one only because `legacyExecSqlFile` reads from the
 * filesystem like every other `execMigrationBatch` caller).
 */
const legacyExecSqlConstant = Effect.fnUntraced(function* (
  session: LegacyDbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  tmpDir: string,
  filename: string,
  sql: string,
) {
  const filePath = path.join(tmpDir, filename);
  yield* fs.writeFileString(filePath, sql).pipe(
    Effect.mapError(
      (error) =>
        new LegacyStartDbSetupError({
          message: `failed to write ${filename}: ${errMessage(error)}`,
        }),
    ),
  );
  yield* legacyExecSqlFile(
    session,
    fs,
    path,
    filePath,
    (message) => new LegacyStartDbSetupError({ message }),
  );
});

/**
 * Port of Go's `InitSchema14` (`start.go:256-266`): execs
 * {@link LEGACY_START_DB_GLOBALS_SQL} then the major-version-appropriate initial
 * schema. Only reached for `majorVersion <= 14` (the caller, `legacyStartInitSchema`,
 * gates on that).
 */
const legacyStartInitSchemaPre15 = Effect.fnUntraced(function* (
  session: LegacyDbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  tmpDir: string,
  majorVersion: number,
) {
  yield* legacyExecSqlConstant(
    session,
    fs,
    path,
    tmpDir,
    "globals.sql",
    LEGACY_START_DB_GLOBALS_SQL,
  );
  const schemaSql =
    majorVersion === 13
      ? LEGACY_START_DB_INITIAL_SCHEMA_13_SQL
      : LEGACY_START_DB_INITIAL_SCHEMA_14_SQL;
  yield* legacyExecSqlConstant(session, fs, path, tmpDir, "initial-schema.sql", schemaSql);
});

/**
 * Runs one PG15+ one-shot service-migration job to completion (Go's
 * `utils.DockerRunJob` = `DockerRunOnceWithStream`, `docker.go:457-459,469-487`):
 * foreground, same Docker network as `db`, no entrypoint override (Go's plain
 * `Cmd` field), stdout always discarded (Go's own `stdout` writer here is always
 * `io.Discard`, `start.go:352`) and stderr teed to the parent process's own stderr ONLY
 * under `--debug` — Go passes `logger := utils.GetDebugLogger()` as the job's stderr
 * writer (`os.Stderr` under `--debug`, else `io.Discard`, `logger.go:10-15`) — so a
 * fresh-volume Realtime/Storage/Auth migration job's own diagnostics are visible when
 * `db start --debug`/`supabase start --debug` is used, not just its exit code. A
 * non-zero exit fails with the same shape as Go's `error running container: <cause>`.
 *
 * Resolves `opts.image` itself, individually, right here — via `legacyEnsureImagesCached`
 * (NOT `LegacyDockerRun.runStream`'s own ambient-only resolver, which never sees
 * `opts.projectEnvValues`) — immediately before running THIS job, matching Go's
 * `DockerRunJob` -> `DockerStart` -> `DockerResolveImageIfNotCached` (`docker.go:363-365`)
 * resolving each one-shot job's own image individually, sequentially, exactly where it's
 * used: neither caller pre-pulls these three images as a batch ahead of time (see
 * `start-database.ts`'s own doc comment for why), and Go's registry-override env var applies
 * uniformly to every `DockerResolveImageIfNotCached` call, including project-`.env`-scoped
 * values — this call must see the same override the long-running containers' own resolve does.
 *
 * Labels the container with `com.supabase.cli.project`/`com.docker.compose.project`
 * (`opts.projectId`), matching Go's `DockerStart`, which sets both unconditionally for
 * every container it starts, one-shot jobs included (`docker.go:371-376`) — so if the
 * client is interrupted or the daemon disconnects while this job is still running, the
 * orphaned container is still discoverable (and removable) by `supabase stop`/rollback's
 * project-label filter (`legacy-docker-remove-all.ts`), not left invisible to both
 * (review: Codex, PR #6022).
 */
const legacyRunStartMigrateJob = Effect.fnUntraced(function* (
  spawner: Spawner,
  opts: {
    readonly image: string;
    readonly env: Readonly<Record<string, string>>;
    readonly cmd: ReadonlyArray<string>;
    readonly networkId: string;
    readonly projectId: string;
    readonly projectEnvValues: Readonly<Record<string, string>> | undefined;
    /** `--debug` — Go's `utils.GetDebugLogger()`, see this function's own doc comment. */
    readonly debug: boolean;
  },
) {
  const docker = yield* LegacyDockerRun;
  const runtimeInfo = yield* RuntimeInfo;
  const resolvedImages = yield* legacyEnsureImagesCached(
    spawner,
    [opts.image],
    opts.projectEnvValues,
  );
  const resolvedImage = resolvedImages.get(opts.image) ?? opts.image;
  // Go's `DockerStart` unconditionally appends the Linux-only `host.docker.internal:
  // host-gateway` extra host for every container it starts (`docker_linux.go`),
  // including one-shot jobs routed through the same `DockerStart` path.
  const extraHosts = runtimeInfo.platform === "linux" ? ["host.docker.internal:host-gateway"] : [];
  const runOpts: LegacyDockerRunOpts = {
    image: resolvedImage,
    cmd: opts.cmd,
    env: opts.env,
    binds: [],
    workingDir: Option.none(),
    securityOpt: [],
    extraHosts,
    network: { _tag: "named", name: opts.networkId },
    labels: {
      [LEGACY_CLI_PROJECT_LABEL]: opts.projectId,
      [LEGACY_COMPOSE_PROJECT_LABEL]: opts.projectId,
    },
    // Already resolved, immediately above — `LegacyDockerRun.runCapture`'s own ambient-only
    // resolver must not re-resolve it (it doesn't see `opts.projectEnvValues` at all).
    skipImageResolve: true,
  };
  // `runStream` (not `runCapture`) so stdout is actually discarded chunk-by-chunk as it
  // arrives, matching Go's `io.Discard` writer for this job (`start.go:352`, and this
  // function's own doc comment above) at constant memory — `runCapture` would instead
  // buffer the ENTIRE stdout stream into `stdoutChunks` even though nothing here ever
  // reads it, which a large/verbose migration job's output could grow without bound
  // (review: Codex, PR #6022).
  const result = yield* docker
    .runStream(runOpts, { onStdout: () => Effect.void, teeStderr: opts.debug })
    .pipe(Effect.mapError((cause) => new LegacyStartDbSetupError({ message: cause.message })));
  if (result.exitCode !== 0) {
    return yield* Effect.fail(
      new LegacyStartDbSetupError({ message: `error running container: exit ${result.exitCode}` }),
    );
  }
});

/** Go's `initStorageJob` env (`start.go:297-317`) — deliberately distinct from `storage.service.ts`'s full container env, see this module's header. */
function legacyStartStorageMigrateEnv(input: {
  readonly targetMigration: string;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
  readonly jwtSecret: string;
  readonly dbHost: string;
  readonly dbPassword: string;
  readonly fileSizeLimit: ProjectConfig["storage"]["file_size_limit"];
}): Record<string, string> {
  return {
    DB_INSTALL_ROLES: "false",
    DB_MIGRATIONS_FREEZE_AT: input.targetMigration,
    ANON_KEY: input.anonKey,
    SERVICE_KEY: input.serviceRoleKey,
    PGRST_JWT_SECRET: input.jwtSecret,
    DATABASE_URL: legacyStartInternalDbUrl(
      "supabase_storage_admin",
      input.dbHost,
      input.dbPassword,
    ),
    FILE_SIZE_LIMIT: String(ramInBytes(input.fileSizeLimit)),
    STORAGE_BACKEND: "file",
    STORAGE_FILE_BACKEND_PATH: "/mnt",
    TENANT_ID: "stub",
    // TODO (matches Go's own TODO, `start.go:311`): https://github.com/supabase/storage-api/issues/55
    REGION: "stub",
    GLOBAL_S3_BUCKET: "stub",
  };
}

/** Go's `initAuthJob` env (`start.go:319-332`) — deliberately distinct from `gotrue.service.ts`'s full container env, see this module's header. */
function legacyStartAuthMigrateEnv(input: {
  readonly apiUrl: string;
  readonly authExternalUrl: string | undefined;
  readonly siteUrl: ProjectConfig["auth"]["site_url"];
  readonly jwtSecret: string;
  readonly dbHost: string;
  readonly dbPassword: string;
}): Record<string, string> {
  // Go's `AuthExternalURL()` (`pkg/config/config.go:543-545` -> `auth.GetExternalURL`):
  // an explicit `auth.external_url` wins outright; only derive from `apiUrl`
  // when it's unset — matching `gotrue.service.ts`'s identical preference
  // chain for the long-running container.
  const authExternalUrl =
    input.authExternalUrl !== undefined && input.authExternalUrl.length > 0
      ? input.authExternalUrl
      : `${input.apiUrl.replace(/\/+$/, "")}/auth/v1`;
  return {
    API_EXTERNAL_URL: authExternalUrl,
    GOTRUE_LOG_LEVEL: "error",
    GOTRUE_DB_DRIVER: "postgres",
    GOTRUE_DB_DATABASE_URL: legacyStartInternalDbUrl(
      "supabase_auth_admin",
      input.dbHost,
      input.dbPassword,
    ),
    GOTRUE_SITE_URL: input.siteUrl,
    GOTRUE_JWT_SECRET: input.jwtSecret,
  };
}

/**
 * Port of Go's `initSchema15` (`start.go:334-357`): up to three one-shot
 * migrate jobs, each gated on its own service's `enabled` flag, run in Go's
 * fixed order (realtime, storage, auth).
 */
const legacyStartInitSchema15 = Effect.fnUntraced(function* (
  spawner: Spawner,
  input: LegacyStartSetupLocalDatabaseInput,
) {
  const dbHost = legacyServiceContainerName("db", input.projectId);
  const dbPassword = legacyStartInternalDbPassword(input.dbUrl);

  if (input.config.realtime.enabled) {
    yield* legacyRunStartMigrateJob(spawner, {
      image: input.images.realtime,
      networkId: input.networkId,
      projectId: input.projectId,
      projectEnvValues: input.projectEnvValues,
      debug: input.debug,
      env: legacyBuildRealtimeEnv({
        ipVersion: input.config.realtime.ip_version,
        maxHeaderLength: input.config.realtime.max_header_length,
        dbHost,
        dbPassword,
        jwtSecret: input.jwtSecret,
        jwks: input.jwks,
      }),
      cmd: [
        "/app/bin/realtime",
        "eval",
        `{:ok, _} = Application.ensure_all_started(:realtime)\n{:ok, _} = Realtime.Tenants.health_check("${LEGACY_REALTIME_TENANT_ID}")`,
      ],
    });
  }
  if (input.config.storage.enabled) {
    // `legacyStartStorageMigrateEnv` parses `storage.file_size_limit` via
    // `ramInBytes`, which throws on a malformed value — a plain synchronous
    // throw here would become an uncaught Effect defect (`Effect.tapError`'s
    // rollback trigger below only fires on typed `Fail` causes, never `Die`
    // ones), leaking Postgres's already-created container/network/volume.
    // Go fails this same malformed value at TOML-decode time, before any
    // Docker work (`sizeInBytes.UnmarshalText`, `pkg/config/config.go:41-47`)
    // — this can't be replicated literally here since Postgres is already up
    // by this step, but surfacing it as a typed `LegacyStartDbSetupError` so
    // rollback actually runs is the achievable equivalent, matching the same
    // fix already applied to `resolveDbHealthTimeoutSeconds` and the
    // long-running Storage container's own file-size-limit parsing
    // (`start.handler.ts`).
    const storageEnv = yield* Effect.try({
      try: () =>
        legacyStartStorageMigrateEnv({
          targetMigration: input.storageTargetMigration,
          anonKey: input.anonKey,
          serviceRoleKey: input.serviceRoleKey,
          jwtSecret: input.jwtSecret,
          dbHost,
          dbPassword,
          fileSizeLimit: input.config.storage.file_size_limit,
        }),
      catch: (cause) =>
        new LegacyStartDbSetupError({
          message: `invalid config for storage: ${errMessage(cause)}`,
        }),
    });
    yield* legacyRunStartMigrateJob(spawner, {
      image: input.images.storage,
      networkId: input.networkId,
      projectId: input.projectId,
      projectEnvValues: input.projectEnvValues,
      debug: input.debug,
      env: storageEnv,
      cmd: ["node", "dist/scripts/migrate-call.js"],
    });
  }
  if (input.config.auth.enabled) {
    yield* legacyRunStartMigrateJob(spawner, {
      image: input.images.auth,
      networkId: input.networkId,
      projectId: input.projectId,
      projectEnvValues: input.projectEnvValues,
      debug: input.debug,
      env: legacyStartAuthMigrateEnv({
        apiUrl: input.apiUrl,
        authExternalUrl: input.authExternalUrl,
        siteUrl: input.siteUrl,
        jwtSecret: input.jwtSecret,
        dbHost,
        dbPassword,
      }),
      cmd: ["gotrue", "migrate"],
    });
  }
});

/**
 * Port of Go's `initSchema` (`start.go:243-254`): prints the banner line once,
 * then branches on PG major version — unconditionally, for BOTH branches, exactly
 * matching Go's `fmt.Fprintln(w, "Initialising schema...")` running before the
 * `if utils.Config.Db.MajorVersion <= 14` check.
 */
const legacyStartInitSchema = Effect.fnUntraced(function* (
  spawner: Spawner,
  input: LegacyStartSetupLocalDatabaseInput,
  tmpDir: string,
) {
  const output = yield* Output;
  yield* output.raw("Initialising schema...\n", "stderr");
  if (input.majorVersion <= 14) {
    yield* legacyStartInitSchemaPre15(
      input.session,
      input.fs,
      input.path,
      tmpDir,
      input.majorVersion,
    );
    return;
  }
  yield* legacyStartInitSchema15(spawner, input);
});

/**
 * Port of Go's `ApplyApiPrivileges` (`start.go:414-435`): tri-state on
 * `api.auto_expose_new_tables` — `true` keeps the bundled initial-schema grants
 * (no-op); unset/`false` execs {@link LEGACY_START_REVOKE_API_PRIVILEGES_SQL}. Runs
 * regardless of PG major version (unlike `initSchema`, this always execs SQL over
 * `session` directly — it is never part of the PG15+ one-shot Docker jobs).
 */
const legacyStartApplyApiPrivileges = Effect.fnUntraced(function* (
  input: LegacyStartSetupLocalDatabaseInput,
  tmpDir: string,
  autoExposeNewTables: Option.Option<boolean>,
) {
  if (Option.isSome(autoExposeNewTables) && autoExposeNewTables.value) return;
  yield* legacyExecSqlConstant(
    input.session,
    input.fs,
    input.path,
    tmpDir,
    "revoke-api-privileges.sql",
    LEGACY_START_REVOKE_API_PRIVILEGES_SQL,
  );
});

/**
 * Port of Go's `initCurrentBranch` (`start.go:233-241`): writes
 * `supabase/.branches/_current_branch` = `"main"` (Go's `CurrBranchPath`,
 * `apps/cli-go/internal/utils/misc.go:99` = `filepath.Join(SupabaseDirPath,
 * ".branches", "_current_branch")`) only if it doesn't already exist. No existing
 * TS constant for this path — `legacy/commands/db/branch/*` are Management-API
 * cloud-branch commands, unrelated to this local file — so it's inlined here,
 * the only current consumer (per "Hoist Before You Duplicate"). Exported (rather
 * than folded into {@link legacyStartSetupLocalDatabase}) because Go calls it
 * unconditionally, not just on a fresh volume — see this module's header.
 */
export const legacyStartInitCurrentBranch = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
) {
  const currentBranchPath = path.join(workdir, "supabase", ".branches", "_current_branch");
  const exists = yield* fs.exists(currentBranchPath).pipe(
    Effect.mapError(
      (error) =>
        new LegacyStartDbSetupError({
          message: `failed init current branch: ${errMessage(error)}`,
        }),
    ),
  );
  if (exists) return;
  yield* fs.makeDirectory(path.dirname(currentBranchPath), { recursive: true }).pipe(
    Effect.mapError(
      (error) =>
        new LegacyStartDbSetupError({
          message: `failed init current branch: ${errMessage(error)}`,
        }),
    ),
  );
  // Go's `utils.WriteFile` writes through `afero.WriteFile(fsys, path, contents, 0644)`
  // (`internal/utils/misc.go:280-286`) — an explicit mode, not the platform default. Effect's
  // `writeFileString` falls back to Node's default file mode (`0666` before the umask) when no
  // `mode` is given, so under a permissive/group-writable umask (`000`/`002`) this file could be
  // created `0666`/`0664` instead of Go's `0644`, making project branch metadata writable by
  // additional local users.
  yield* fs.writeFileString(currentBranchPath, "main", { mode: 0o644 }).pipe(
    Effect.mapError(
      (error) =>
        new LegacyStartDbSetupError({
          message: `failed init current branch: ${errMessage(error)}`,
        }),
    ),
  );
});

/**
 * Runs the full `SetupLocalDatabase`-equivalent sequence — see this module's
 * header for the exact Go call chain and line-range citations. Call once, right
 * after the `db` container's healthcheck passes on a fresh volume (Go's
 * `NoBackupVolume` gate); the caller decides that gating, this function performs
 * no health/readiness checks of its own.
 */
export const legacyStartSetupLocalDatabase = (
  spawner: Spawner,
  input: LegacyStartSetupLocalDatabaseInput,
): Effect.Effect<
  void,
  LegacyStartSetupLocalDatabaseError,
  | Output
  | LegacyDockerRun
  | RuntimeInfo
  | LegacyEdgeRuntimeScript
  | LegacyPgDeltaSslProbe
  // `legacyTryCacheMigrationsCatalog`'s own pg-delta export call resolves
  // `FileSystem.FileSystem`/`Path.Path` from the effect context itself (not from
  // the `fs`/`path` values this function already threads through as plain data —
  // see `legacy-pgdelta.ts`'s `legacyExportCatalogPgDelta`), so both must be
  // ambient here too; every real caller already gets them from `BunServices.layer`
  // at the CLI root runtime, same as `db push`'s own composition.
  | FileSystem.FileSystem
  | Path.Path
> =>
  Effect.gen(function* () {
    const { session, fs, path, workdir } = input;

    // `warnOnUnresolvedEnv: false` — both `start.handler.ts` and `db/start/
    // start.handler.ts` already ran an earlier, same-invocation `legacyCheckDbToml`
    // purely for its Go-parity validation side effect (their own callers discard the
    // result) before ever reaching this fresh-volume setup, so that earlier call
    // already printed Go's single `assertEnvLoaded` OrioleDB S3 WARN, if any. Without
    // this, this module's own accepted duplicate config-load pass (see this module's
    // header) would print the SAME warning a second time — a real, observable stderr
    // divergence from Go's exactly-once `flags.LoadConfig`, unlike the harmless
    // resolved-value duplication the header describes.
    const toml = yield* legacyCheckDbToml(fs, path, workdir, undefined, {
      warnOnUnresolvedEnv: false,
    });

    // SetupDatabase: initSchema -> ApplyApiPrivileges (start.go:383-389).
    yield* Effect.scoped(
      Effect.gen(function* () {
        const tmpDir = yield* fs
          .makeTempDirectoryScoped({ prefix: "supabase-start-db-setup-" })
          .pipe(
            Effect.mapError(
              (error) =>
                new LegacyStartDbSetupError({
                  message: `failed to create temp directory: ${errMessage(error)}`,
                }),
            ),
          );
        yield* legacyStartInitSchema(spawner, input, tmpDir);
        yield* legacyStartApplyApiPrivileges(input, tmpDir, toml.baseline.apiAutoExposeNewTables);
      }),
    );

    // "Create vault secrets first so roles.sql can reference them" (start.go:390).
    yield* legacyUpsertVaultSecrets(session, toml.vault);

    // Custom-roles seed (start.go:394-398, pkg/migration/seed.go:84-97): Go's
    // `SeedGlobals` prints "Seeding globals from roles.sql..." BEFORE attempting
    // to read the file, then tolerates a missing file (`errors.Is(err,
    // os.ErrNotExist)`); any other read/exec error propagates. Reproduced here as
    // an unconditional print followed by an existence check ahead of the read
    // (via `legacyExecSqlFile`, not `legacySeedGlobals` — reusing `legacySeedGlobals`
    // would need the missing-file case to unwind through `execMigrationBatch`'s
    // shared, flattened error-mapping contract in `legacy-migration-apply.ts`,
    // which every other caller of that file also relies on and which is out of
    // scope to change here) rather than a caught not-found error, since there is
    // no meaningful TOCTOU concern in this CLI context.
    const customRolesPath = path.join(workdir, "supabase", "roles.sql");
    const output = yield* Output;
    yield* output.raw(`Seeding globals from ${path.basename(customRolesPath)}...\n`, "stderr");
    const rolesExist = yield* fs.exists(customRolesPath).pipe(
      Effect.mapError(
        (error) =>
          new LegacyStartDbSetupError({
            message: `failed to check roles.sql: ${errMessage(error)}`,
          }),
      ),
    );
    if (rolesExist) {
      yield* legacyExecSqlFile(
        session,
        fs,
        path,
        customRolesPath,
        (message) => new LegacyStartDbSetupError({ message }),
      );
    }

    // apply.MigrateAndSeed(ctx, "", conn, fsys) — empty version = every pending
    // migration, matching `SetupLocalDatabase`'s own call in the `start` context
    // (start.go:368). `experimental`/`pgDeltaEnabled`/`schemaPaths` gate
    // `legacyMigrateAndSeed`'s own declarative-schema-files branch (apply.go:19) — see its
    // doc comment; `toml.pgDelta.enabled` and `toml.schemaPaths` are this module's own
    // already-loaded config (the latter already resolved + `SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS`
    // env-overridden by `legacyCheckDbToml`, `legacy-db-config.toml-read.ts`), not re-read from
    // the caller's raw, unresolved `ProjectConfig`.
    yield* legacyMigrateAndSeed(session, fs, path, workdir, "", {
      migrationsEnabled: toml.migrationsEnabled,
      seed: toml.seed,
      experimental: input.experimental,
      pgDeltaEnabled: toml.pgDelta.enabled,
      schemaPaths: toml.schemaPaths,
    });

    // pgcache.TryCacheMigrationsCatalog(ctx, pgconn.Config{Host: Config.Hostname,
    // Port: Config.Db.Port, User: "postgres", Password: Config.Db.Password, Database:
    // "postgres"}, "local", version, fsys, ...) (start.go:371-379): best-effort, run
    // immediately after MigrateAndSeed above, on every call — this function's
    // `version` is always `""` (the line above), matching the `len(version) == 0`
    // half of Go's `ShouldCacheMigrationsCatalog()` gate unconditionally. `cacheEnabled`
    // reproduces the OTHER half of that gate (`pgcache/cache.go:93-95`) exactly — the
    // same `toml.pgDelta.enabled || SUPABASE_EXPERIMENTAL_PG_DELTA` formula
    // `legacy-db-push-core.ts` already uses for its own call. `input.dbUrl` is already
    // the HOST-facing `postgresql://postgres:<password>@<hostname>:<port>/postgres`
    // address (see its own doc comment) — the exact same shape Go's `utils.
    // ToPostgresURL(config)` builds from that literal `pgconn.Config` here, so it's
    // reused directly as `targetUrl` rather than re-derived. `conn`'s fields are only
    // ever read by `legacyCatalogPrefixFromConfig` on a non-local prefix fallback,
    // unreachable here since `isLocal` is always `true`.
    const cacheEnabled =
      toml.pgDelta.enabled || legacyParseBoolEnv(toml.envLookup("SUPABASE_EXPERIMENTAL_PG_DELTA"));
    const pgDeltaCtx: LegacyPgDeltaContext = {
      projectId: input.projectId,
      cwd: workdir,
      npmVersion: Option.getOrUndefined(toml.pgDelta.npmVersion),
      denoVersion: toml.denoVersion,
    };
    const hostDbUrl = new URL(input.dbUrl);
    // Scope the `PGDELTA_NPM_REGISTRY`-from-project-`.env` apply to just this call:
    // `legacyExportCatalogPgDelta` reads it off bare `process.env`
    // (`legacyPgDeltaNpmRegistryOption`), same as `db push`/`db pull`/`db dump`/
    // `bootstrap`'s own calls into pg-delta — Go's `loadNestedEnv` already made it
    // process-wide by this point (`config.go:788`), but this module otherwise threads
    // every override through `projectEnvValues` explicitly rather than mutating
    // `process.env`, so this one shared-code call needs the same opt-in helper those
    // other commands use. `legacyApplyProjectEnv` registers a finalizer that reverts it.
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* legacyApplyProjectEnv(input.projectEnvValues ?? {});
        yield* legacyTryCacheMigrationsCatalog(fs, path, pgDeltaCtx, {
          enabled: cacheEnabled,
          targetUrl: input.dbUrl,
          conn: {
            host: hostDbUrl.hostname,
            port: Number(hostDbUrl.port),
            user: "postgres",
            database: "postgres",
          },
          isLocal: true,
          migrationsDir: path.join(workdir, "supabase", "migrations"),
        }).pipe(
          // Best-effort: Go's own `TryCacheMigrationsCatalog` failure only ever warns
          // (`fmt.Fprintln(os.Stderr, "Warning: failed to cache migrations catalog:", err)`,
          // start.go:378) and never fails `SetupLocalDatabase` — same shape
          // `legacy-db-push-core.ts` already established for this exact call.
          Effect.catch((error) =>
            output.raw(
              `Warning: failed to cache migrations catalog: ${redactLegacyConnectionString(error.message)}\n`,
              "stderr",
            ),
          ),
        );
      }),
    );

    // `initCurrentBranch` (start.go:233-241) is NOT called here — see this
    // module's header for why it moved to the caller instead.
  });
