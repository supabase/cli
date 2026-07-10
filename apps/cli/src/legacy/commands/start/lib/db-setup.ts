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
 *        `../services/realtime.service.ts`'s `legacyBuildRealtimeEnv`, which builds
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
 *
 * Go's `initCurrentBranch` (`start.go:233-241`, writes `supabase/.branches/
 * _current_branch` = `"main"` if absent) is NOT part of this pipeline, even though
 * it's exported from this module ({@link legacyStartInitCurrentBranch}): in Go it's
 * called by `StartDatabase` (the caller of `SetupLocalDatabase`) UNCONDITIONALLY,
 * regardless of `NoBackupVolume` (`start.go:184-189`) — unlike everything above,
 * which only runs on a fresh volume. `start.handler.ts` calls it directly, outside
 * the `isFreshVolume` gate that wraps {@link legacyStartSetupLocalDatabase}.
 *
 * Go's best-effort `pgcache.TryCacheMigrationsCatalog` warning (`start.go:371-379`)
 * is intentionally NOT ported — same accepted, documented divergence as
 * `db/reset/reset.handler.ts`'s identical comment (no output impact either way).
 *
 * This module also duplicates ONE config-load pass: `legacyCheckDbToml` is called
 * internally (not threaded in from the caller) to resolve `[db.vault]`, `[db.seed]`,
 * `db.migrations.enabled`, and the effective `api.auto_expose_new_tables` tri-state —
 * the same accepted duplication `db start`'s own handler already takes
 * independently of the top-level `start` command's own config resolution (see
 * `commands/db/start/start.handler.ts:40`).
 */

import type { ProjectConfig } from "@supabase/config";
import { Data, Effect, type FileSystem, Option, type Path } from "effect";

import { Output } from "../../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import type { LegacyDbSession } from "../../../shared/legacy-db-connection.service.ts";
import { LegacyDbConfigLoadError } from "../../../shared/legacy-db-config.errors.ts";
import { legacyCheckDbToml } from "../../../shared/legacy-db-config.toml-read.ts";
import { legacyServiceContainerName } from "../../../shared/legacy-docker-ids.ts";
import {
  LegacyDockerRun,
  type LegacyDockerRunOpts,
} from "../../../shared/legacy-docker-run.service.ts";
import { legacyMigrateAndSeed } from "../../../shared/legacy-migrate-and-seed.ts";
import {
  LegacyMigrationApplyError,
  legacyExecSqlFile,
} from "../../../shared/legacy-migration-apply.ts";
import type { LegacyMigrationSeedError } from "../../../shared/legacy-seed.ts";
import { ramInBytes } from "../../../shared/legacy-size-units.ts";
import {
  LegacyMigrationVaultError,
  legacyUpsertVaultSecrets,
} from "../../../shared/legacy-vault.ts";
import { LEGACY_REALTIME_TENANT_ID, legacyBuildRealtimeEnv } from "../services/realtime.service.ts";
import { LEGACY_START_DB_GLOBALS_SQL } from "../templates/db-globals.sql.ts";
import { LEGACY_START_DB_INITIAL_SCHEMA_13_SQL } from "../templates/db-initial-schema-13.sql.ts";
import { LEGACY_START_DB_INITIAL_SCHEMA_14_SQL } from "../templates/db-initial-schema-14.sql.ts";
import {
  legacyStartInternalDbPassword,
  legacyStartInternalDbUrl,
} from "./internal-db-connection.ts";

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
  | LegacyMigrationSeedError;

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
  /** `LegacyLocalConfigValues.anonKey`. */
  readonly anonKey: string;
  /** `LegacyLocalConfigValues.serviceRoleKey`. */
  readonly serviceRoleKey: string;
  /** Go's `utils.Config.Storage.TargetMigration` (`toml:"-"`, resolved from a version-pin file) — the caller passes `""` when absent, matching Go's zero-value default. */
  readonly storageTargetMigration: string;
  readonly images: LegacyStartDbSetupImages;
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
 * `Cmd` field), stdout discarded and stderr not teed (Go discards both outside
 * `--debug` — `utils.GetDebugLogger()`, `logger.go:10-15`). A non-zero exit fails
 * with the same shape as Go's `error running container: <cause>`.
 */
const legacyRunStartMigrateJob = Effect.fnUntraced(function* (opts: {
  readonly image: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cmd: ReadonlyArray<string>;
  readonly networkId: string;
}) {
  const docker = yield* LegacyDockerRun;
  const runtimeInfo = yield* RuntimeInfo;
  // Go's `DockerStart` unconditionally appends the Linux-only `host.docker.internal:
  // host-gateway` extra host for every container it starts (`docker_linux.go`),
  // including one-shot jobs routed through the same `DockerStart` path.
  const extraHosts = runtimeInfo.platform === "linux" ? ["host.docker.internal:host-gateway"] : [];
  const runOpts: LegacyDockerRunOpts = {
    image: opts.image,
    cmd: opts.cmd,
    env: opts.env,
    binds: [],
    workingDir: Option.none(),
    securityOpt: [],
    extraHosts,
    network: { _tag: "named", name: opts.networkId },
  };
  const result = yield* docker
    .runCapture(runOpts)
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
  input: LegacyStartSetupLocalDatabaseInput,
) {
  const dbHost = legacyServiceContainerName("db", input.projectId);
  const dbPassword = legacyStartInternalDbPassword(input.dbUrl);

  if (input.config.realtime.enabled) {
    yield* legacyRunStartMigrateJob({
      image: input.images.realtime,
      networkId: input.networkId,
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
    yield* legacyRunStartMigrateJob({
      image: input.images.storage,
      networkId: input.networkId,
      env: legacyStartStorageMigrateEnv({
        targetMigration: input.storageTargetMigration,
        anonKey: input.anonKey,
        serviceRoleKey: input.serviceRoleKey,
        jwtSecret: input.jwtSecret,
        dbHost,
        dbPassword,
        fileSizeLimit: input.config.storage.file_size_limit,
      }),
      cmd: ["node", "dist/scripts/migrate-call.js"],
    });
  }
  if (input.config.auth.enabled) {
    yield* legacyRunStartMigrateJob({
      image: input.images.auth,
      networkId: input.networkId,
      env: legacyStartAuthMigrateEnv({
        apiUrl: input.apiUrl,
        authExternalUrl: input.authExternalUrl,
        siteUrl: input.config.auth.site_url,
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
  yield* legacyStartInitSchema15(input);
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
  yield* fs.writeFileString(currentBranchPath, "main").pipe(
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
  input: LegacyStartSetupLocalDatabaseInput,
): Effect.Effect<
  void,
  LegacyStartSetupLocalDatabaseError,
  Output | LegacyDockerRun | RuntimeInfo
> =>
  Effect.gen(function* () {
    const { session, fs, path, workdir } = input;

    const toml = yield* legacyCheckDbToml(fs, path, workdir);

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
        yield* legacyStartInitSchema(input, tmpDir);
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
    // (start.go:368).
    yield* legacyMigrateAndSeed(session, fs, path, workdir, "", {
      migrationsEnabled: toml.migrationsEnabled,
      seed: toml.seed,
    });

    // Go's best-effort pgcache catalog warning (`pgcache.TryCacheMigrationsCatalog`,
    // start.go:371-379) is not ported (no output impact) — same accepted, documented
    // divergence as `db/reset/reset.handler.ts`.
    //
    // `initCurrentBranch` (start.go:233-241) is NOT called here — see this
    // module's header for why it moved to the caller instead.
  });
