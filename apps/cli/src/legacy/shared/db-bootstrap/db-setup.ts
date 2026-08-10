/**
 * Post-Postgres-health local database setup pipeline — a strict 1:1 port of Go's
 * `SetupLocalDatabase` (`apps/cli-go/internal/db/start/start.go:359-381`), run once
 * the `db` container's healthcheck passes on a FRESH volume (Go's `NoBackupVolume`
 * gate, `start.go:184` — the caller decides whether to invoke this at all; see
 * `legacyVolumeExists` in `./container-lifecycle.ts`). The single exported
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
 *    `legacyMigrateAndSeed`) with the caller-supplied {@link
 *    LegacyStartSetupLocalDatabaseInput.version} — `""` (every pending migration) for
 *    `db start`'s own call, matching `SetupLocalDatabase`'s call in the `start`
 *    context; `db reset`'s PG15 recreate (the function's OTHER real Go caller,
 *    `resetDatabase15`, `reset.go:169`) passes its own resolved reset version instead.
 *    {@link LegacyStartSetupLocalDatabaseInput.seedFlags} applies `db reset`'s
 *    `--no-seed`/`--sql-paths` overrides on top of the loaded `[db.seed]` config first
 *    (a no-op for `db start`, which has neither flag) — see
 *    {@link legacyResolveResetSeedConfig}.
 * 6. **`pgcache.TryCacheMigrationsCatalog`** (`start.go:371-379`) — a best-effort
 *    warmup of the `catalog-local-migrations-*` snapshot subsequent pg-delta
 *    workflows (`db diff`/`db push`) consume, via the already-ported
 *    `legacyTryCacheMigrationsCatalog` ({@link legacy-pgdelta.cache.ts}, the exact
 *    same function `db push` already calls after its own migration apply). Gated
 *    identically to Go's `ShouldCacheMigrationsCatalog()` (`pgcache/cache.go:93-95`):
 *    `input.version.length === 0` AND (`toml.pgDelta.enabled` OR
 *    `SUPABASE_EXPERIMENTAL_PG_DELTA`) — reached by BOTH real Go callers of this
 *    shared function, `db start` (always `version: ""`) and `db reset`'s PG15
 *    recreate (its own resolved reset version, usually also `""`). A failure prints
 *    Go's exact warning (`Warning: failed to cache migrations catalog: <err>`,
 *    `start.go:378`) to stderr and is otherwise swallowed, reusing the identical
 *    best-effort catch/warn shape `legacy-db-push-core.ts` already established for
 *    its own call — this step never fails {@link legacyStartSetupLocalDatabase} or
 *    the caller's `start`/`db start`/`db reset` run. Requires
 *    `LegacyEdgeRuntimeScript`/`LegacyPgDeltaSslProbe` in this function's own effect
 *    environment (widened accordingly below), so `start.command.ts`,
 *    `db/start/start.layers.ts`, AND `db/reset/reset.layers.ts` all compose
 *    `legacyEdgeRuntimeScriptLayer`/`legacyPgDeltaSslProbeLayer`, matching `db
 *    push`'s own layer composition (`push.layers.ts`). The underlying
 *    `legacyExportCatalogPgDelta` reads `PGDELTA_NPM_REGISTRY` straight off bare
 *    `process.env` ({@link legacy-pgdelta.ts}'s `legacyPgDeltaNpmRegistryOption`) —
 *    Go's `Config.Load` already `os.Setenv`'d the project `.env` into the process
 *    before `start`/`db start`/`db reset` ever reaches this call (`loadNestedEnv`,
 *    `config.go:788`), so a registry override set only in `supabase/.env` (not the
 *    shell) must be visible here too. This module never mutates `process.env`
 *    globally the way `start`/`db start`'s own config resolution does — every other
 *    Go env override is threaded explicitly via `projectEnvValues` — so this ONE
 *    call is scoped with `legacyApplyProjectEnv` (the same opt-in helper `db
 *    push`/`db pull`/`db dump`/`bootstrap` already use around their own pg-delta/
 *    image work) for just its own duration, then reverted.
 *
 * Go's `initCurrentBranch` (`start.go:233-241`, writes `supabase/.branches/
 * _current_branch` = `"main"` if absent) is NOT part of this pipeline, even though
 * it's exported from this module ({@link legacyStartInitCurrentBranch}): in Go it's
 * called by `StartDatabase` (the caller of `SetupLocalDatabase`) UNCONDITIONALLY,
 * regardless of `NoBackupVolume` (`start.go:184-189`) — unlike everything above,
 * which only runs on a fresh volume. `start.handler.ts` calls it directly, outside
 * the `isFreshVolume` gate that wraps {@link legacyStartSetupLocalDatabase}; `db
 * reset` never calls it at all (Go's own `resetDatabase`/`resetDatabase15` never
 * call `initCurrentBranch` either).
 *
 * This module also duplicates ONE config-load pass: `legacyCheckDbToml` is called
 * internally (not threaded in from the caller) to resolve `[db.vault]`, `[db.seed]`,
 * `db.migrations.enabled`, and the effective `api.auto_expose_new_tables` tri-state —
 * the same accepted duplication `db start`'s own handler (`commands/db/start/
 * start.handler.ts`) already takes independently of the top-level `supabase start`
 * command's own config resolution; `db reset`'s own caller duplicates it again for the
 * same reason.
 */

import type { ProjectConfig } from "@supabase/config";
import { Clock, Data, Effect, type FileSystem, Option, type Path, Schedule } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import type { LocalServiceVersionOverrides } from "../../../shared/services/services.shared.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";
import { LegacyDbConnection, type LegacyDbSession } from "../legacy-db-connection.service.ts";
import type { LegacyDbConnectError } from "../legacy-db-connection.errors.ts";
import { LegacyDbConfigLoadError } from "../legacy-db-config.errors.ts";
import { redactLegacyConnectionString } from "../legacy-db-config.parse.ts";
import {
  legacyApplyProjectEnv,
  legacyCheckDbToml,
  legacyResolveSeedSqlPath,
} from "../legacy-db-config.toml-read.ts";
import { legacyParseBoolEnv } from "../legacy-diff-engine.ts";
import { LEGACY_CLI_PROJECT_LABEL, legacyServiceContainerName } from "../legacy-docker-ids.ts";
import { LegacyDockerRun, type LegacyDockerRunOpts } from "../legacy-docker-run.service.ts";
import { LegacyEdgeRuntimeScript } from "../legacy-edge-runtime-script.service.ts";
import { legacyMigrateAndSeed } from "../legacy-migrate-and-seed.ts";
import { LegacyMigrationApplyError, legacyExecSqlFile } from "../legacy-migration-apply.ts";
import { legacyTryCacheMigrationsCatalog } from "../legacy-pgdelta.cache.ts";
import type { LegacyPgDeltaContext } from "../legacy-pgdelta.ts";
import { LegacyPgDeltaSslProbe } from "../legacy-pgdelta-ssl-probe.service.ts";
import type { LegacyMigrationSeedError, LegacySeedConfig } from "../legacy-seed.ts";
import { ramInBytes } from "../legacy-size-units.ts";
import { LegacyMigrationVaultError, legacyUpsertVaultSecrets } from "../legacy-vault.ts";
import { legacyEnsureImagesCached, type LegacyImagePrepullError } from "./image-prepull.ts";
import { legacyResolvePinnedImage } from "./pinned-image.ts";
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
export class LegacyDbSetupError extends Data.TaggedError("LegacyDbSetupError")<{
  readonly message: string;
  readonly reason:
    | "database"
    | "filesystem"
    | "invalid_config"
    | "docker_daemon"
    | "registry_pull"
    | "image_inspect";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "database":
        return { ...actionability.dbFinding, fingerprint_suffix: "database" };
      case "filesystem":
        return { ...actionability.permission, fingerprint_suffix: "filesystem" };
      case "docker_daemon":
        return { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" };
      case "registry_pull":
        return { ...actionability.externalNetwork, fingerprint_suffix: "registry_pull" };
      case "image_inspect":
        return { ...actionability.invalidConfig, fingerprint_suffix: "image_inspect" };
      default:
        return { ...actionability.invalidConfig, fingerprint_suffix: "invalid_config" };
    }
  }
}

function legacyDbSetupDockerReason(
  reason: "spawn" | "inspect" | "pull",
  daemonDown: boolean,
): LegacyDbSetupError["reason"] {
  if (reason === "spawn" || daemonDown) return "docker_daemon";
  if (reason === "pull") return "registry_pull";
  return "image_inspect";
}

/** Every failure {@link legacyStartSetupLocalDatabase} can produce. */
export type LegacyStartSetupLocalDatabaseError =
  | LegacyDbConfigLoadError
  | LegacyDbSetupError
  | LegacyMigrationVaultError
  | LegacyMigrationApplyError
  | LegacyMigrationSeedError
  | LegacyImagePrepullError;

/** Already-resolved Docker images for the three PG15+ one-shot migrate jobs (`initSchema15`'s `initJobs`). */
interface LegacyStartDbSetupImages {
  /** `utils.Config.Realtime.Image`, resolved by the caller (not part of the decoded `ProjectConfig` schema — `toml:"-"`). */
  readonly realtime: string;
  /** `utils.Config.Storage.Image`, ditto. */
  readonly storage: string;
  /** `utils.Config.Auth.Image`, ditto. */
  readonly auth: string;
}

/**
 * Computes the three PG15+ one-shot setup jobs' PINNED image names (`initSchema15`'s
 * `initRealtimeJob`/`initStorageJob`/`initAuthJob`) for {@link legacyRunFreshDbSetup} — the
 * ONE place both real Go callers (`db start`'s fresh-volume branch and `db reset`'s PG15
 * recreate) reach this from. Mirrors Go's `initSchema15`, which uses the SAME
 * already-pin-rewritten `utils.Config.{Realtime,Storage,Auth}.Image` fields the
 * long-running containers would use, regardless of `--exclude` — resolved via
 * `legacyResolvePinnedImage`, not the raw Dockerfile default, so a linked project's
 * version pins apply here too. Deliberately does NOT resolve these against the registry
 * (`legacyEnsureImagesCached`) as a batch: Go resolves (and pulls) each one-shot job's
 * own image individually, sequentially, right before THAT job runs (`DockerRunJob` ->
 * `DockerStart` -> `DockerResolveImageIfNotCached`, `start.go:334-355`,
 * `docker.go:363-365`) — {@link legacyRunStartMigrateJob} does that lazily itself, right
 * before running each job (see its own doc comment): a batch resolve here would let one
 * unreachable image fail the WHOLE setup before an earlier job Go would already have run
 * to completion ever gets to run.
 */
function legacyResolveDbSetupImages(
  serviceVersionOverrides: LocalServiceVersionOverrides,
): LegacyStartDbSetupImages {
  return {
    realtime: legacyResolvePinnedImage("realtime", "realtime", serviceVersionOverrides),
    storage: legacyResolvePinnedImage("storage", "storage", serviceVersionOverrides),
    auth: legacyResolvePinnedImage("gotrue", "auth", serviceVersionOverrides),
  };
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
  /**
   * The migration version to reapply (Go's `apply.MigrateAndSeed(ctx, version, ...)`).
   * `db start`'s own caller always passes `""` (Go's `SetupLocalDatabase(ctx, "", ...)`,
   * `start.go:185` — every pending migration). `db reset`'s PG15 recreate
   * (`resetDatabase15`, `reset.go:169`) passes its own RESOLVED reset version instead —
   * the one genuine difference between the two Go callers of this shared function.
   */
  readonly version: string;
  /**
   * `db reset`'s `--no-seed`/`--sql-paths` overrides (Go's `applyDbResetSeedFlags`,
   * `cmd/db.go:567-583`, mutating the global `utils.Config.Db.Seed` BEFORE `reset.Run`
   * — read by this same `MigrateAndSeed` call on the PG15 recreate path). `db start`
   * has neither flag, so its caller passes `{ noSeed: false, sqlPaths: [] }`, which
   * {@link legacyResolveResetSeedConfig} reduces to the loaded `[db.seed]` config
   * unchanged.
   */
  readonly seedFlags: { readonly noSeed: boolean; readonly sqlPaths: ReadonlyArray<string> };
}

/**
 * Applies `db reset`'s `--no-seed`/`--sql-paths` overrides to an already-resolved
 * `[db.seed]` config, mirroring Go's `applyDbResetSeedFlags` (`cmd/db.go:567-583`):
 * `--no-seed` disables seeding outright; otherwise a non-empty `--sql-paths`
 * force-enables seeding and overrides `sqlPaths` (each pattern resolved against
 * `supabase/` the same way Go's own `resolveSeedSqlPaths` does); an empty
 * `--sql-paths` is a no-op. The two flags are mutually exclusive (validated by the
 * caller — `db/reset/reset.handler.ts`'s `validateDbResetSeedFlags` port — before
 * this ever runs), matching Go's own `if noSeed { ...; return } ...` early return.
 */
export function legacyResolveResetSeedConfig(
  seed: LegacySeedConfig,
  override: { readonly noSeed: boolean; readonly sqlPaths: ReadonlyArray<string> },
  path: Path.Path,
): LegacySeedConfig {
  if (override.noSeed) return { ...seed, enabled: false };
  if (override.sqlPaths.length === 0) return seed;
  return {
    enabled: true,
    sqlPaths: override.sqlPaths.map((pattern) => legacyResolveSeedSqlPath(path, pattern)),
  };
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
        new LegacyDbSetupError({
          message: `failed to write ${filename}: ${errMessage(error)}`,
          reason: "filesystem",
        }),
    ),
  );
  yield* legacyExecSqlFile(
    session,
    fs,
    path,
    filePath,
    (message) => new LegacyDbSetupError({ message, reason: "database" }),
  );
});

/**
 * Port of Go's EXPORTED `InitSchema14` (`start.go:256-266`) — execs ONLY the
 * major-version-appropriate initial-schema SQL, deliberately WITHOUT
 * {@link LEGACY_START_DB_GLOBALS_SQL}. Go's own `initSchema` wrapper (the PG<=14
 * branch below, `legacyStartInitSchemaPre15`) execs globals.sql itself, immediately
 * before calling `InitSchema14` — but `db reset`'s PG14 path (`reset.go:176-186`
 * `initDatabase`) calls `start.InitSchema14` DIRECTLY, skipping globals.sql
 * entirely. Exported so `legacy/shared/db-bootstrap/recreate-local-database.ts`
 * can reproduce that exact (if surprising) Go asymmetry instead of reusing
 * {@link legacyStartInitSchemaPre15}, which would run globals.sql an extra time Go
 * never does on the reset path.
 */
export const legacyInitSchema14 = Effect.fnUntraced(function* (
  session: LegacyDbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  tmpDir: string,
  majorVersion: number,
) {
  const schemaSql =
    majorVersion === 13
      ? LEGACY_START_DB_INITIAL_SCHEMA_13_SQL
      : LEGACY_START_DB_INITIAL_SCHEMA_14_SQL;
  yield* legacyExecSqlConstant(session, fs, path, tmpDir, "initial-schema.sql", schemaSql);
});

/**
 * Port of Go's `initSchema`'s PG<=14 branch (`start.go:245-251`): execs
 * {@link LEGACY_START_DB_GLOBALS_SQL} then {@link legacyInitSchema14}. Only
 * reached for `majorVersion <= 14` (the caller, `legacyStartInitSchema`, gates on
 * that) — used by `db start`'s fresh-volume setup ONLY; `db reset`'s PG14 path
 * calls {@link legacyInitSchema14} directly instead (see its own doc comment).
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
  yield* legacyInitSchema14(session, fs, path, tmpDir, majorVersion);
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
    .pipe(
      Effect.mapError(
        (cause) =>
          new LegacyDbSetupError({
            message: cause.message,
            reason: legacyDbSetupDockerReason(cause.reason, cause.daemonDown),
          }),
      ),
    );
  if (result.exitCode !== 0) {
    return yield* Effect.fail(
      new LegacyDbSetupError({
        message: `error running container: exit ${result.exitCode}`,
        reason: "database",
      }),
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
    // by this step, but surfacing it as a typed `LegacyDbSetupError` so
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
        new LegacyDbSetupError({
          message: `invalid config for storage: ${errMessage(cause)}`,
          reason: "invalid_config",
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
 * `session` directly — it is never part of the PG15+ one-shot Docker jobs). Exported
 * (and taking `session`/`fs`/`path` directly, not the whole
 * {@link LegacyStartSetupLocalDatabaseInput}) because Go's `ApplyApiPrivileges` is
 * the SAME exported function `db reset`'s PG14 `initDatabase` calls
 * (`reset.go:176-186`), after its own `InitSchema14` call and with none of
 * `SetupDatabase`'s other steps (vault/roles.sql/MigrateAndSeed) — see
 * `legacy/shared/db-bootstrap/recreate-local-database.ts`.
 */
export const legacyApplyApiPrivileges = Effect.fnUntraced(function* (
  session: LegacyDbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  tmpDir: string,
  autoExposeNewTables: Option.Option<boolean>,
) {
  if (Option.isSome(autoExposeNewTables) && autoExposeNewTables.value) return;
  yield* legacyExecSqlConstant(
    session,
    fs,
    path,
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
        new LegacyDbSetupError({
          message: `failed init current branch: ${errMessage(error)}`,
          reason: "filesystem",
        }),
    ),
  );
  if (exists) return;
  yield* fs.makeDirectory(path.dirname(currentBranchPath), { recursive: true }).pipe(
    Effect.mapError(
      (error) =>
        new LegacyDbSetupError({
          message: `failed init current branch: ${errMessage(error)}`,
          reason: "filesystem",
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
        new LegacyDbSetupError({
          message: `failed init current branch: ${errMessage(error)}`,
          reason: "filesystem",
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
                new LegacyDbSetupError({
                  message: `failed to create temp directory: ${errMessage(error)}`,
                  reason: "filesystem",
                }),
            ),
          );
        yield* legacyStartInitSchema(spawner, input, tmpDir);
        yield* legacyApplyApiPrivileges(
          session,
          fs,
          path,
          tmpDir,
          toml.baseline.apiAutoExposeNewTables,
        );
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
          new LegacyDbSetupError({
            message: `failed to check roles.sql: ${errMessage(error)}`,
            reason: "filesystem",
          }),
      ),
    );
    if (rolesExist) {
      yield* legacyExecSqlFile(
        session,
        fs,
        path,
        customRolesPath,
        (message) => new LegacyDbSetupError({ message, reason: "database" }),
      );
    }

    // apply.MigrateAndSeed(ctx, version, conn, fsys) — `db start`'s own caller always
    // passes `version: ""` (every pending migration, matching `SetupLocalDatabase`'s
    // own call in the `start` context, `start.go:185,368`); `db reset`'s PG15 recreate
    // passes its own resolved reset version instead (`resetDatabase15`, `reset.go:169`)
    // — see `input.version`'s own doc comment. `experimental`/`pgDeltaEnabled`/
    // `schemaPaths` gate `legacyMigrateAndSeed`'s own declarative-schema-files branch
    // (apply.go:19) — see its doc comment; `toml.pgDelta.enabled` and `toml.schemaPaths`
    // are this module's own already-loaded config (the latter already resolved +
    // `SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS` env-overridden by `legacyCheckDbToml`,
    // `legacy-db-config.toml-read.ts`), not re-read from the caller's raw, unresolved
    // `ProjectConfig`. `input.seedFlags` applies `db reset`'s own `--no-seed`/
    // `--sql-paths` overrides on top of the loaded `[db.seed]` config — a no-op for
    // `db start`, which has neither flag.
    yield* legacyMigrateAndSeed(session, fs, path, workdir, input.version, {
      migrationsEnabled: toml.migrationsEnabled,
      seed: legacyResolveResetSeedConfig(toml.seed, input.seedFlags, path),
      experimental: input.experimental,
      pgDeltaEnabled: toml.pgDelta.enabled,
      schemaPaths: toml.schemaPaths,
    });

    // pgcache.TryCacheMigrationsCatalog(ctx, pgconn.Config{Host: Config.Hostname,
    // Port: Config.Db.Port, User: "postgres", Password: Config.Db.Password, Database:
    // "postgres"}, "local", version, fsys, ...) (start.go:371-379): best-effort, run
    // immediately after MigrateAndSeed above, for BOTH real Go callers of this shared
    // function — `db start` (always `version: ""`) and `db reset`'s PG15 recreate
    // (its own resolved reset `input.version`, usually also `""`). `cacheEnabled`
    // reproduces Go's `ShouldCacheMigrationsCatalog()` gate exactly
    // (`pgcache/cache.go:93-95`): `len(version) == 0` AND (`toml.pgDelta.enabled` OR
    // `SUPABASE_EXPERIMENTAL_PG_DELTA`) — the same formula `legacy-db-push-core.ts`
    // already uses for its own call. `input.dbUrl` is already the HOST-facing
    // `postgresql://postgres:<password>@<hostname>:<port>/postgres` address (see its
    // own doc comment) — the exact same shape Go's `utils.ToPostgresURL(config)` builds
    // from that literal `pgconn.Config` here, so it's reused directly as `targetUrl`
    // rather than re-derived. `conn`'s fields are only ever read by
    // `legacyCatalogPrefixFromConfig` on a non-local prefix fallback, unreachable here
    // since `isLocal` is always `true`.
    const cacheEnabled =
      input.version.length === 0 &&
      (toml.pgDelta.enabled ||
        legacyParseBoolEnv(toml.envLookup("SUPABASE_EXPERIMENTAL_PG_DELTA")));
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
          nowMillis: yield* Clock.currentTimeMillis,
        }).pipe(
          // Best-effort: Go's own `TryCacheMigrationsCatalog` failure only ever warns
          // (`fmt.Fprintln(os.Stderr, "Warning: failed to cache migrations catalog:", err)`,
          // start.go:378) and never fails `legacyStartSetupLocalDatabase` — same shape
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

/**
 * The `setup` shape shared by BOTH real Go callers of {@link
 * legacyStartSetupLocalDatabase} — `db start`'s own fresh-volume branch
 * (`start-database.ts`'s `legacyStartDatabase`) and `db reset`'s PG15 recreate
 * composition (`recreate-local-database.ts`'s `legacyRecreateLocalDatabase15`) —
 * everything {@link legacyStartSetupLocalDatabase} needs, minus what {@link
 * legacyRunFreshDbSetup} itself already resolves/threads through (`session`,
 * `images`). The two callers used to each declare an identical copy of this
 * interface; hoisted here alongside {@link legacyRunFreshDbSetup} itself
 * (CLI-1955 review follow-up).
 */
export interface LegacyFreshDbSetupInput<E> {
  readonly majorVersion: number;
  /** Already spliced with the caller's own realtime/storage/auth enabled-for-setup + ip_version/max_header_length/file_size_limit overrides — see `bootstrap-config.ts`'s `LegacyDbBootstrapConfig`. */
  readonly config: LegacyStartSetupLocalDatabaseInput["config"];
  /** Threaded straight through to {@link LegacyStartSetupLocalDatabaseInput.experimental} — see its own doc comment. */
  readonly experimental: boolean;
  readonly dbUrl: string;
  readonly jwtSecret: string;
  /** Lazy — evaluated only when reached AND `realtimeEnabledForSetup`. See `start-database.ts`'s header for why this is caller-supplied rather than resolved here unconditionally. */
  readonly jwks: Effect.Effect<string, E>;
  readonly apiUrl: string;
  readonly authExternalUrl: string | undefined;
  readonly siteUrl: string;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
  readonly storageTargetMigration: string;
  readonly realtimeEnabledForSetup: boolean;
  readonly storageEnabledForSetup: boolean;
  readonly authEnabledForSetup: boolean;
  readonly serviceVersionOverrides: LocalServiceVersionOverrides;
  readonly projectEnvValues: Readonly<Record<string, string>> | undefined;
  /**
   * `--debug` — threaded straight through to {@link
   * LegacyStartSetupLocalDatabaseInput.debug}; see its own doc comment.
   */
  readonly debug: boolean;
}

/**
 * Runs {@link legacyStartSetupLocalDatabase} against a freshly-provisioned local
 * Postgres — the exact sequence BOTH real Go callers run once Postgres's own
 * healthcheck passes on a fresh database (`db start`'s fresh-volume branch and
 * `db reset`'s PG15 recreate, see {@link LegacyFreshDbSetupInput}'s own doc
 * comment): dial the host-facing session (Go's `ConnectLocalPostgres`), resolve
 * JWKS lazily (only when `majorVersion >= 15` AND `realtimeEnabledForSetup` — Go's
 * `initSchema`, `start.go:243-254`, only ever reaches `initSchema15`'s
 * `ResolveJWKS` call on PG15+; the PG13/14 branch, `InitSchema14`, never touches
 * JWKS at all), compute the three PG15+ one-shot job images' PINNED names via
 * {@link legacyResolveDbSetupImages}, then run {@link legacyStartSetupLocalDatabase}
 * itself. `version`/`seedFlags` are the one genuine difference between the two
 * callers (`db start` always passes `""`/`{noSeed:false, sqlPaths:[]}`; `db
 * reset` passes its own resolved reset version/flags) — threaded straight
 * through by the caller, matching each one's own `LegacyStartSetupLocalDatabaseInput`
 * field of the same name.
 */
export const legacyRunFreshDbSetup = <E>(
  spawner: Spawner,
  input: {
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly workdir: string;
    readonly projectId: string;
    readonly networkId: string;
    readonly hostname: string;
    readonly dbPort: number;
    readonly version: string;
    readonly seedFlags: { readonly noSeed: boolean; readonly sqlPaths: ReadonlyArray<string> };
    readonly setup: LegacyFreshDbSetupInput<E>;
  },
): Effect.Effect<
  void,
  LegacyStartSetupLocalDatabaseError | LegacyDbConnectError | LegacyImagePrepullError | E,
  | Output
  | LegacyDbConnection
  | LegacyDockerRun
  | RuntimeInfo
  | LegacyEdgeRuntimeScript
  | LegacyPgDeltaSslProbe
  | FileSystem.FileSystem
  | Path.Path
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const dbConnection = yield* LegacyDbConnection;
      const { setup } = input;
      const dbPassword = legacyStartInternalDbPassword(setup.dbUrl);
      // Go's `SetupLocalDatabase` dials this first host-facing connect exactly
      // once (`start.go:360-363`); we deliberately diverge and retry dial-level
      // failures: the container's internal health check says nothing about the
      // HOST side, where Docker Desktop (Windows/WSL2) can publish the port a
      // few seconds late (#6136).
      const session = yield* dbConnection
        .connect(
          {
            host: input.hostname,
            port: input.dbPort,
            user: "postgres",
            password: dbPassword,
            database: "postgres",
          },
          { isLocal: true, dnsResolver: "native" },
        )
        .pipe(
          Effect.retry({
            schedule: Schedule.max([Schedule.spaced("1 seconds"), Schedule.recurs(10)]),
            while: (error) => error.retryable === true,
          }),
        );

      // Go's `initSchema` (`start.go:243-254`) branches to `initSchema15` — the ONLY place
      // `ResolveJWKS` is ever called — solely on `majorVersion >= 15`; the PG13/14 branch
      // (`InitSchema14`) never touches JWKS, so a PG13/14 database with realtime enabled
      // must not pay for (or fail on) an external JWKS fetch it will never use.
      const jwks =
        setup.majorVersion >= 15 && setup.realtimeEnabledForSetup ? yield* setup.jwks : "";

      const dbSetupImages = legacyResolveDbSetupImages(setup.serviceVersionOverrides);

      yield* legacyStartSetupLocalDatabase(spawner, {
        session,
        fs: input.fs,
        path: input.path,
        workdir: input.workdir,
        config: setup.config,
        experimental: setup.experimental,
        majorVersion: setup.majorVersion,
        projectId: input.projectId,
        networkId: input.networkId,
        dbUrl: setup.dbUrl,
        jwtSecret: setup.jwtSecret,
        jwks,
        apiUrl: setup.apiUrl,
        authExternalUrl: setup.authExternalUrl,
        siteUrl: setup.siteUrl,
        anonKey: setup.anonKey,
        serviceRoleKey: setup.serviceRoleKey,
        storageTargetMigration: setup.storageTargetMigration,
        images: dbSetupImages,
        projectEnvValues: setup.projectEnvValues,
        debug: setup.debug,
        version: input.version,
        seedFlags: input.seedFlags,
      });
    }),
  );
