/**
 * Local database setup pipeline run once the `db` container's healthcheck passes on a fresh
 * volume (see `volumeExists` in `./container-lifecycle.ts`). {@link startSetupLocalDatabase} runs
 * schema init, webhooks activation, API-privilege revocation, vault upsert, the roles.sql seed,
 * then migrate-and-seed, in that order — vault runs before the seed so `roles.sql` can reference
 * the upserted secrets.
 *
 * {@link startInitCurrentBranch}, also exported here, is not part of this pipeline: callers
 * invoke it unconditionally, outside the fresh-volume gate.
 */

import type { CliConfig } from "@supabase/config";
import { Data, Effect, type FileSystem, Option, type Path, Schedule } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import type { LocalServiceVersionOverrides } from "../../shared/services/services.shared.ts";
import { Output } from "../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";
import { DbConnection, type DbSession } from "../db-connection.service.ts";
import type { DbConnectError } from "../db-connection.errors.ts";
import { DbConfigLoadError } from "../db-config.errors.ts";
import { checkDbToml, resolveSeedSqlPath } from "../db-config.toml-read.ts";
import { CLI_PROJECT_LABEL, localDbContainerId } from "../docker-ids.ts";
import { DockerRun, type DockerRunOpts } from "../docker-run.service.ts";
import { migrateAndSeed } from "../migrate-and-seed.ts";
import { MigrationApplyError, execSqlFile } from "../migration-apply.ts";
import { readMigrationTable } from "../migration-history.ts";
import { statementInstallsPgNet } from "../pg-net-guidance.ts";
import type { MigrationSeedError, SeedConfig } from "../seed.ts";
import { ramInBytes } from "../size-units.ts";
import { MigrationVaultError, type VaultSecret, upsertVaultSecrets } from "../vault.ts";
import { ensureImagesCached, type ImagePrepullError } from "./image-prepull.ts";
import { resolvePinnedImage } from "./pinned-image.ts";
import { COMPOSE_PROJECT_LABEL } from "./container-lifecycle.ts";
import { REALTIME_TENANT_ID, buildRealtimeEnv } from "./realtime-env.ts";
import { START_DB_GLOBALS_SQL } from "./templates/db-globals.sql.ts";
import { START_DB_INITIAL_SCHEMA_13_SQL } from "./templates/db-initial-schema-13.sql.ts";
import { START_DB_INITIAL_SCHEMA_14_SQL } from "./templates/db-initial-schema-14.sql.ts";
import { startInternalDbPassword, startInternalDbUrl } from "./internal-db-connection.ts";

type Spawner = ChildProcessSpawner["Service"];

/** Exported so the shadow baseline cache (`shadow-cache.ts`) can key its digest on this text. */
export const START_REVOKE_API_PRIVILEGES_SQL = `
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke usage, select on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated, service_role;
`;

/**
 * Exported so the shadow baseline cache (`shadow-cache.ts`) can key its digest on this text, same
 * as {@link START_REVOKE_API_PRIVILEGES_SQL}.
 */
export const START_ENABLE_DATABASE_WEBHOOKS_SQL =
  "create extension if not exists pg_net schema extensions;";

// The PG14 dump installs pg_net for its later grant statements; remove it after the dump so the
// baseline still follows the user's webhooks setting. Enabled projects recreate it afterward.
const START_REMOVE_DATABASE_WEBHOOKS_SQL = "drop extension if exists pg_net;";

/**
 * A SQL exec, one-shot service-migration Docker job, or scratch temp file/directory creation
 * failed. The Docker job's own stdout/stderr are discarded outside `--debug`, so only its exit
 * code is surfaced here.
 */
export class DbSetupError extends Data.TaggedError("DbSetupError")<{
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

function dbSetupDockerReason(
  reason: "spawn" | "inspect" | "pull",
  daemonDown: boolean,
): DbSetupError["reason"] {
  if (reason === "spawn" || daemonDown) return "docker_daemon";
  if (reason === "pull") return "registry_pull";
  return "image_inspect";
}

/** Every failure {@link startSetupLocalDatabase} can produce. */
export type StartSetupLocalDatabaseError =
  | DbConfigLoadError
  | DbSetupError
  | MigrationVaultError
  | MigrationApplyError
  | MigrationSeedError
  | ImagePrepullError;

/** Already-resolved Docker images for the three PG15+ one-shot migrate jobs. */
export interface StartDbSetupImages {
  /** Resolved by the caller; not part of the decoded `CliConfig` schema. */
  readonly realtime: string;
  readonly storage: string;
  readonly auth: string;
}

/**
 * Computes the three PG15+ one-shot setup jobs' pinned image names via {@link resolvePinnedImage},
 * so a linked project's version pins apply here too.
 *
 * Does not resolve these against the registry as a batch: {@link runStartMigrateJob} resolves
 * each job's image lazily, right before that job runs, so one unreachable image can't fail the
 * whole setup before an earlier job gets to run.
 */
function resolveDbSetupImages(
  serviceVersionOverrides: LocalServiceVersionOverrides,
): StartDbSetupImages {
  return {
    realtime: resolvePinnedImage("realtime", "realtime", serviceVersionOverrides),
    storage: resolvePinnedImage("storage", "storage", serviceVersionOverrides),
    auth: resolvePinnedImage("gotrue", "auth", serviceVersionOverrides),
  };
}

/**
 * Prints the setup banner, then lazily resolves JWKS (only when `majorVersion >= 15` and
 * `realtimeEnabledForSetup`) and the PG15+ one-shot job images — the shared prelude both
 * {@link runFreshDbSetup} and the shadow-database setup path need before calling
 * {@link setupDatabase}. Structurally typed against just the fields it needs so both
 * {@link FreshDbSetupInput} and `shadow-database.ts`'s derived `ShadowDbSetupInput` satisfy this
 * signature without a cast.
 *
 * The banner prints before `jwks` resolves, so a JWKS failure (an unreachable `third_party`
 * provider) surfaces after the banner instead of before it. The `majorVersion >= 15` gate means
 * JWKS's potential live HTTP request never runs at all on PG13/14, even with realtime enabled.
 */
export const resolveDbSetupPrelude = <E>(setup: {
  readonly majorVersion: number;
  readonly realtimeEnabledForSetup: boolean;
  readonly serviceVersionOverrides: LocalServiceVersionOverrides;
  readonly jwks: Effect.Effect<string, E>;
}): Effect.Effect<{ readonly jwks: string; readonly images: StartDbSetupImages }, E, Output> =>
  Effect.gen(function* () {
    const output = yield* Output;
    yield* output.raw("Initialising schema...\n", "stderr");
    const jwks = setup.majorVersion >= 15 && setup.realtimeEnabledForSetup ? yield* setup.jwks : "";
    const images = resolveDbSetupImages(setup.serviceVersionOverrides);
    return { jwks, images };
  });

/**
 * Input to {@link setupDatabase}: schema init, API-privilege revocation, vault upsert, and the
 * roles.sql seed — without migrate-and-seed (see {@link StartSetupLocalDatabaseInput}, which adds
 * that step). Its own exported shape so shadow-database provisioning can reach the same
 * platform-baseline pipeline without replaying migrations or reaching the
 * declarative-schema-files branch.
 */
export interface SetupDatabaseInput {
  /**
   * An already-open session to the local Postgres database, dialed via the host-facing address —
   * not the internal Docker-network address the PG15+ one-shot jobs below connect through (see
   * `networkId`/`dbHost`).
   */
  readonly session: DbSession;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  /** The Supabase project root (parent of `supabase/`). */
  readonly workdir: string;
  /** The caller's already-resolved, effective config (env overrides already applied). */
  readonly config: CliConfig;
  /** Effective `[experimental.webhooks].enabled`, including supported environment overrides. */
  readonly webhooksEnabled: boolean;
  /** `db.major_version` (13-17), resolved by the caller once, ahead of the `db` container's own image tag selection. */
  readonly majorVersion: number;
  /**
   * The internal Docker-network address the PG15+ one-shot jobs connect through. The real local
   * `db` container's caller passes its service container name; the shadow-database variant
   * passes the shadow container's own short id instead, which resolves via Docker's embedded DNS
   * even though that container has no name or alias.
   */
  readonly dbHost: string;
  /**
   * Labels the PG15+ one-shot job containers. Independent of {@link dbHost}: this labels the
   * job containers themselves, not the (possibly different) container `dbHost` addresses.
   */
  readonly projectId: string;
  /** The `start` run's Docker network id; every PG15+ one-shot job joins it. */
  readonly networkId: string;
  /** Reused (not recomputed) to derive the internal DB password via `startInternalDbPassword`. */
  readonly dbUrl: string;
  /** `LocalConfigValues.jwtSecret`. */
  readonly jwtSecret: string;
  /** Resolved JWKS JSON string (only read when `realtime.enabled`); already built by the caller. */
  readonly jwks: string;
  /** The auth job's `API_EXTERNAL_URL` falls back to this, `/auth/v1`-suffixed, when {@link authExternalUrl} is unset. */
  readonly apiUrl: string;
  /**
   * An explicit value wins over the {@link apiUrl}-derived fallback. This one-shot job must
   * resolve to the same value the long-running auth container uses, so a fresh database's auth
   * migration never disagrees with the container it's migrating for.
   */
  readonly authExternalUrl?: string;
  /** Must resolve to the same value the long-running auth container uses; see {@link authExternalUrl}. */
  readonly siteUrl: string;
  /** `LocalConfigValues.anonKey`. */
  readonly anonKey: string;
  /** `LocalConfigValues.serviceRoleKey`. */
  readonly serviceRoleKey: string;
  /** Resolved from a version-pin file; the caller passes `""` when absent. */
  readonly storageTargetMigration: string;
  readonly images: StartDbSetupImages;
  /**
   * Project-`.env`-scoped registry/mirror overrides, threaded to each one-shot job's own
   * per-image resolve (see {@link runStartMigrateJob}). The long-running containers' own
   * ambient-only resolver does not see this; it only reads `process.env`.
   */
  readonly projectEnvValues: Readonly<Record<string, string>> | undefined;
  /** Threaded to each one-shot job so a failed migration job's own stderr is visible under `--debug`. */
  readonly debug: boolean;
  /** The `api.auto_expose_new_tables` tri-state, threaded straight into {@link applyApiPrivileges}. */
  readonly apiAutoExposeNewTables: Option.Option<boolean>;
  /** Threaded straight into {@link upsertVaultSecrets}. */
  readonly vault: ReadonlyArray<VaultSecret>;
}

/** Controls the extension side effects of {@link setupDatabase}. */
export interface SetupDatabaseOptions {
  readonly webhooks?: "config" | "enabled" | "disabled";
}

/** `"enabled"` always installs `pg_net`, `"disabled"` always removes it, `"config"` follows the project flag. */
export function resolveSetupWebhooksEnabled(
  policy: SetupDatabaseOptions["webhooks"],
  webhooksEnabled: boolean,
): boolean {
  const webhooks = policy ?? "config";
  return webhooks === "enabled" || (webhooks === "config" && webhooksEnabled);
}

/** Input to {@link startSetupLocalDatabase}. */
export interface StartSetupLocalDatabaseInput extends Omit<
  SetupDatabaseInput,
  "apiAutoExposeNewTables" | "vault" | "webhooksEnabled"
> {
  /**
   * Threaded straight into {@link migrateAndSeed}'s own `experimental` gate; {@link setupDatabase}
   * has no use for it.
   */
  readonly experimental: boolean;
  /**
   * The migration version to reapply. `db start` always passes `""` (every pending migration);
   * `db reset`'s PG15 recreate passes its own resolved reset version instead.
   */
  readonly version: string;
  /**
   * `db reset`'s `--no-seed`/`--sql-paths` overrides. `db start` has neither flag, so its caller
   * passes `{ noSeed: false, sqlPaths: [] }`, which {@link resolveResetSeedConfig} reduces to the
   * loaded `[db.seed]` config unchanged.
   */
  readonly seedFlags: { readonly noSeed: boolean; readonly sqlPaths: ReadonlyArray<string> };
}

/**
 * Applies `db reset`'s `--no-seed`/`--sql-paths` overrides to an already-resolved `[db.seed]`
 * config: `--no-seed` disables seeding outright; otherwise a non-empty `--sql-paths` force-enables
 * seeding and overrides `sqlPaths` (each pattern resolved against `supabase/`); an empty
 * `--sql-paths` is a no-op. The two flags are mutually exclusive, validated by the caller before
 * this runs.
 */
export function resolveResetSeedConfig(
  seed: SeedConfig,
  override: { readonly noSeed: boolean; readonly sqlPaths: ReadonlyArray<string> },
  path: Path.Path,
): SeedConfig {
  if (override.noSeed) return { ...seed, enabled: false };
  if (override.sqlPaths.length === 0) return seed;
  return {
    enabled: true,
    sqlPaths: override.sqlPaths.map((pattern) => resolveSeedSqlPath(path, pattern)),
  };
}

const errMessage = (e: unknown): string =>
  typeof e === "object" && e !== null && "message" in e && typeof e.message === "string"
    ? e.message
    : String(e);

/**
 * Writes `sql` to `<tmpDir>/<filename>` and execs it via `execSqlFile`, which only reads SQL from
 * the filesystem.
 */
const execSqlConstant = Effect.fnUntraced(function* (
  session: DbSession,
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
        new DbSetupError({
          message: `failed to write ${filename}: ${errMessage(error)}`,
          reason: "filesystem",
        }),
    ),
  );
  yield* execSqlFile(
    session,
    fs,
    path,
    filePath,
    (message) => new DbSetupError({ message, reason: "database" }),
  );
});

/**
 * Execs only the major-version-appropriate initial-schema SQL, without
 * {@link START_DB_GLOBALS_SQL}. {@link startInitSchemaPre15} execs globals.sql itself before
 * calling this; `db reset`'s PG14 path calls this directly instead, skipping globals.sql.
 * Exported so `recreate-local-database.ts` can reproduce that same asymmetry.
 */
export const initSchema14 = Effect.fnUntraced(function* (
  session: DbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  tmpDir: string,
  majorVersion: number,
) {
  const schemaSql =
    majorVersion === 13 ? START_DB_INITIAL_SCHEMA_13_SQL : START_DB_INITIAL_SCHEMA_14_SQL;
  yield* execSqlConstant(session, fs, path, tmpDir, "initial-schema.sql", schemaSql);
});

/**
 * Execs {@link START_DB_GLOBALS_SQL} then {@link initSchema14}, for `majorVersion <= 14`. Used
 * by `db start`'s fresh-volume setup only; `db reset`'s PG14 path calls {@link initSchema14}
 * directly instead.
 */
const startInitSchemaPre15 = Effect.fnUntraced(function* (
  session: DbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  tmpDir: string,
  majorVersion: number,
) {
  yield* execSqlConstant(session, fs, path, tmpDir, "globals.sql", START_DB_GLOBALS_SQL);
  yield* initSchema14(session, fs, path, tmpDir, majorVersion);
});

/**
 * Runs one PG15+ one-shot service-migration job to completion: foreground, on the same Docker
 * network as `db`, labeled with `opts.projectId` so an interrupted run's orphaned container stays
 * discoverable by `supabase stop`. Stdout is discarded; stderr is teed to the parent's own stderr
 * only under `--debug`.
 *
 * Resolves `opts.image` itself via `ensureImagesCached` immediately before running this job — the
 * long-running containers' own ambient-only resolver never sees `opts.projectEnvValues`, and
 * neither caller pre-pulls these three images as a batch.
 */
const runStartMigrateJob = Effect.fnUntraced(function* (
  spawner: Spawner,
  opts: {
    readonly image: string;
    readonly env: Readonly<Record<string, string>>;
    readonly cmd: ReadonlyArray<string>;
    readonly networkId: string;
    readonly projectId: string;
    readonly projectEnvValues: Readonly<Record<string, string>> | undefined;
    /** Tees the job's stderr to the parent's own stderr when true. */
    readonly debug: boolean;
  },
) {
  const docker = yield* DockerRun;
  const runtimeInfo = yield* RuntimeInfo;
  const resolvedImages = yield* ensureImagesCached(spawner, [opts.image], opts.projectEnvValues);
  const resolvedImage = resolvedImages.get(opts.image) ?? opts.image;
  // Every container gets this extra host on Linux; Docker Desktop platforms resolve it natively.
  const extraHosts = runtimeInfo.platform === "linux" ? ["host.docker.internal:host-gateway"] : [];
  const runOpts: DockerRunOpts = {
    image: resolvedImage,
    cmd: opts.cmd,
    env: opts.env,
    binds: [],
    workingDir: Option.none(),
    securityOpt: [],
    extraHosts,
    network: { _tag: "named", name: opts.networkId },
    labels: {
      [CLI_PROJECT_LABEL]: opts.projectId,
      [COMPOSE_PROJECT_LABEL]: opts.projectId,
    },
    // Already resolved above; the ambient-only resolver doesn't see `opts.projectEnvValues`.
    skipImageResolve: true,
  };
  // `runStream`, not `runCapture`: this discards stdout chunk-by-chunk at constant memory.
  // `runCapture` would buffer the entire stream into memory even though nothing here reads it.
  const result = yield* docker
    .runStream(runOpts, { onStdout: () => Effect.void, teeStderr: opts.debug })
    .pipe(
      Effect.mapError(
        (cause) =>
          new DbSetupError({
            message: cause.message,
            reason: dbSetupDockerReason(cause.reason, cause.daemonDown),
          }),
      ),
    );
  if (result.exitCode !== 0) {
    return yield* Effect.fail(
      new DbSetupError({
        message: `error running container: exit ${result.exitCode}`,
        reason: "database",
      }),
    );
  }
});

/** A smaller, differently-keyed env than the long-running Storage container's own builder. */
function startStorageMigrateEnv(input: {
  readonly targetMigration: string;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
  readonly jwtSecret: string;
  readonly dbHost: string;
  readonly dbPassword: string;
  readonly fileSizeLimit: CliConfig["storage"]["file_size_limit"];
}): Record<string, string> {
  return {
    DB_INSTALL_ROLES: "false",
    DB_MIGRATIONS_FREEZE_AT: input.targetMigration,
    ANON_KEY: input.anonKey,
    SERVICE_KEY: input.serviceRoleKey,
    PGRST_JWT_SECRET: input.jwtSecret,
    DATABASE_URL: startInternalDbUrl("supabase_storage_admin", input.dbHost, input.dbPassword),
    FILE_SIZE_LIMIT: String(ramInBytes(input.fileSizeLimit)),
    STORAGE_BACKEND: "file",
    STORAGE_FILE_BACKEND_PATH: "/mnt",
    TENANT_ID: "stub",
    // TODO: https://github.com/supabase/storage-api/issues/55
    REGION: "stub",
    GLOBAL_S3_BUCKET: "stub",
  };
}

/** A minimal env distinct from `gotrue.service.ts`'s full container builder. */
function startAuthMigrateEnv(input: {
  readonly apiUrl: string;
  readonly authExternalUrl: string | undefined;
  readonly siteUrl: CliConfig["auth"]["site_url"];
  readonly jwtSecret: string;
  readonly dbHost: string;
  readonly dbPassword: string;
}): Record<string, string> {
  // Matches `gotrue.service.ts`'s identical preference chain for the long-running container.
  const authExternalUrl =
    input.authExternalUrl !== undefined && input.authExternalUrl.length > 0
      ? input.authExternalUrl
      : `${input.apiUrl.replace(/\/+$/, "")}/auth/v1`;
  return {
    API_EXTERNAL_URL: authExternalUrl,
    GOTRUE_LOG_LEVEL: "error",
    GOTRUE_DB_DRIVER: "postgres",
    GOTRUE_DB_DATABASE_URL: startInternalDbUrl(
      "supabase_auth_admin",
      input.dbHost,
      input.dbPassword,
    ),
    GOTRUE_SITE_URL: input.siteUrl,
    GOTRUE_JWT_SECRET: input.jwtSecret,
  };
}

/**
 * Runs up to three one-shot migrate jobs, each gated on its own service's `enabled` flag, in
 * order: realtime, storage, auth.
 */
const startInitSchema15 = Effect.fnUntraced(function* (
  spawner: Spawner,
  input: SetupDatabaseInput,
) {
  const dbHost = input.dbHost;
  const dbPassword = startInternalDbPassword(input.dbUrl);

  if (input.config.realtime.enabled) {
    // Realtime's own entrypoint handles migrate + seed before `exec`; passing only `cmd` (no
    // entrypoint override) runs that one-shot job ahead of user migrations.
    yield* runStartMigrateJob(spawner, {
      image: input.images.realtime,
      networkId: input.networkId,
      projectId: input.projectId,
      projectEnvValues: input.projectEnvValues,
      debug: input.debug,
      env: buildRealtimeEnv({
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
        `{:ok, _} = Application.ensure_all_started(:realtime)\n{:ok, _} = Realtime.Tenants.health_check("${REALTIME_TENANT_ID}")`,
      ],
    });
  }
  if (input.config.storage.enabled) {
    // `ramInBytes` throws on a malformed value; wrapped so that surfaces as a typed
    // `DbSetupError` instead of an untyped defect, which would skip the rollback below (its
    // `Effect.tapError` only fires on typed failures) and leak the already-created resources.
    const storageEnv = yield* Effect.try({
      try: () =>
        startStorageMigrateEnv({
          targetMigration: input.storageTargetMigration,
          anonKey: input.anonKey,
          serviceRoleKey: input.serviceRoleKey,
          jwtSecret: input.jwtSecret,
          dbHost,
          dbPassword,
          fileSizeLimit: input.config.storage.file_size_limit,
        }),
      catch: (cause) =>
        new DbSetupError({
          message: `invalid config for storage: ${errMessage(cause)}`,
          reason: "invalid_config",
        }),
    });
    yield* runStartMigrateJob(spawner, {
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
    yield* runStartMigrateJob(spawner, {
      image: input.images.auth,
      networkId: input.networkId,
      projectId: input.projectId,
      projectEnvValues: input.projectEnvValues,
      debug: input.debug,
      env: startAuthMigrateEnv({
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
 * Branches on `majorVersion`. The setup banner prints from {@link resolveDbSetupPrelude}, the
 * caller-side step that runs immediately before this one, not from here.
 */
const startInitSchema = Effect.fnUntraced(function* (
  spawner: Spawner,
  input: SetupDatabaseInput,
  tmpDir: string,
) {
  if (input.majorVersion <= 14) {
    yield* startInitSchemaPre15(input.session, input.fs, input.path, tmpDir, input.majorVersion);
    return;
  }
  yield* startInitSchema15(spawner, input);
});

/**
 * Applies the `api.auto_expose_new_tables` tri-state: unset and `true` are both a no-op (keeps
 * the bundled initial-schema grants); an explicit `false` execs
 * {@link START_REVOKE_API_PRIVILEGES_SQL}. Always execs over `session` directly, regardless of PG
 * major version — never part of the PG15+ one-shot Docker jobs.
 *
 * Takes `session`/`fs`/`path` directly rather than the whole {@link StartSetupLocalDatabaseInput}
 * because `db reset`'s PG14 path calls it too, without any of `setupDatabase`'s other steps.
 */
export const applyApiPrivileges = Effect.fnUntraced(function* (
  session: DbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  tmpDir: string,
  autoExposeNewTables: Option.Option<boolean>,
) {
  if (Option.getOrElse(autoExposeNewTables, () => true)) return;
  yield* execSqlConstant(
    session,
    fs,
    path,
    tmpDir,
    "revoke-api-privileges.sql",
    START_REVOKE_API_PRIVILEGES_SQL,
  );
});

/** Installs pg_net for the local Database Webhooks feature when enabled. */
export const applyDatabaseWebhooks = Effect.fnUntraced(function* (
  session: DbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  tmpDir: string,
  enabled: boolean,
) {
  if (!enabled) return;
  yield* execSqlConstant(
    session,
    fs,
    path,
    tmpDir,
    "enable-database-webhooks.sql",
    START_ENABLE_DATABASE_WEBHOOKS_SQL,
  );
});

/**
 * Drops pg_net; shared by the fresh-setup PG14 dump cleanup, `db reset`'s PG14 path, and the
 * existing-volume webhooks convergence, so all three run the identical statement.
 */
export const removeDatabaseWebhooks = Effect.fnUntraced(function* (
  session: DbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  tmpDir: string,
) {
  yield* execSqlConstant(
    session,
    fs,
    path,
    tmpDir,
    "remove-database-webhooks.sql",
    START_REMOVE_DATABASE_WEBHOOKS_SQL,
  );
});

/**
 * Writes `supabase/.branches/_current_branch` = `"main"` if it doesn't already exist. Exported
 * separately from {@link startSetupLocalDatabase} because callers invoke it unconditionally, not
 * just on a fresh volume.
 */
export const startInitCurrentBranch = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
) {
  const currentBranchPath = path.join(workdir, "supabase", ".branches", "_current_branch");
  const exists = yield* fs.exists(currentBranchPath).pipe(
    Effect.mapError(
      (error) =>
        new DbSetupError({
          message: `failed init current branch: ${errMessage(error)}`,
          reason: "filesystem",
        }),
    ),
  );
  if (exists) return;
  yield* fs.makeDirectory(path.dirname(currentBranchPath), { recursive: true }).pipe(
    Effect.mapError(
      (error) =>
        new DbSetupError({
          message: `failed init current branch: ${errMessage(error)}`,
          reason: "filesystem",
        }),
    ),
  );
  // Explicit mode: without it, `writeFileString` falls back to Node's default (`0666` before the
  // umask), which under a permissive umask could leave this file group/world-writable.
  yield* fs.writeFileString(currentBranchPath, "main", { mode: 0o644 }).pipe(
    Effect.mapError(
      (error) =>
        new DbSetupError({
          message: `failed init current branch: ${errMessage(error)}`,
          reason: "filesystem",
        }),
    ),
  );
});

/**
 * Runs schema init through the custom-roles seed; see {@link SetupDatabaseInput} for exactly
 * what's in and out of scope. Extracted from {@link startSetupLocalDatabase} so shadow-database
 * provisioning can reuse this exact sequence without also reaching migrate-and-seed.
 */
export const setupDatabase = (
  spawner: Spawner,
  input: SetupDatabaseInput,
  options: SetupDatabaseOptions = {},
): Effect.Effect<
  void,
  | DbSetupError
  | MigrationVaultError
  | ImagePrepullError
  // A pooled-connection acquire failure surfaces the driver's own connect error verbatim, never
  // relabeled as a setup failure.
  | DbConnectError,
  Output | DockerRun | RuntimeInfo
> =>
  Effect.gen(function* () {
    const { session, fs, path, workdir } = input;

    yield* Effect.scoped(
      Effect.gen(function* () {
        const tmpDir = yield* fs
          .makeTempDirectoryScoped({ prefix: "supabase-start-db-setup-" })
          .pipe(
            Effect.mapError(
              (error) =>
                new DbSetupError({
                  message: `failed to create temp directory: ${errMessage(error)}`,
                  reason: "filesystem",
                }),
            ),
          );
        const requiresPg14WebhooksCleanup = input.majorVersion === 14;
        yield* startInitSchema(spawner, input, tmpDir);
        if (requiresPg14WebhooksCleanup) {
          yield* removeDatabaseWebhooks(session, fs, path, tmpDir);
        }
        yield* applyDatabaseWebhooks(
          session,
          fs,
          path,
          tmpDir,
          resolveSetupWebhooksEnabled(options.webhooks, input.webhooksEnabled),
        );
        yield* applyApiPrivileges(session, fs, path, tmpDir, input.apiAutoExposeNewTables);
      }),
    );

    // Runs before the roles seed so `roles.sql` can reference these secrets.
    yield* upsertVaultSecrets(session, input.vault);

    // Prints unconditionally, before checking whether the file exists. A missing file is
    // tolerated; any other read/exec error propagates. Checked via an existence check ahead of
    // the read rather than a caught not-found error — no meaningful TOCTOU concern here.
    const customRolesPath = path.join(workdir, "supabase", "roles.sql");
    const output = yield* Output;
    yield* output.raw(`Seeding globals from ${path.basename(customRolesPath)}...\n`, "stderr");
    const rolesExist = yield* fs.exists(customRolesPath).pipe(
      Effect.mapError(
        (error) =>
          new DbSetupError({
            message: `failed to check roles.sql: ${errMessage(error)}`,
            reason: "filesystem",
          }),
      ),
    );
    if (rolesExist) {
      yield* execSqlFile(
        session,
        fs,
        path,
        customRolesPath,
        (message) => new DbSetupError({ message, reason: "database" }),
      );
    }
  });

/**
 * Runs the full setup sequence described in this module's header. Call once, right after the
 * `db` container's healthcheck passes on a fresh volume; the caller decides that gating — this
 * function performs no health/readiness checks of its own.
 */
export const startSetupLocalDatabase = (
  spawner: Spawner,
  input: StartSetupLocalDatabaseInput,
): Effect.Effect<
  void,
  // Rides alongside the alias because a pooled-connection acquire failure surfaces the driver's
  // connect error verbatim, suggestion included.
  StartSetupLocalDatabaseError | DbConnectError,
  Output | DockerRun | RuntimeInfo | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const { session, fs, path, workdir } = input;

    // `warnOnUnresolvedEnv: false`: the caller's own handler already ran an earlier `checkDbToml`
    // pass before reaching this fresh-volume setup, which already printed any unresolved-env
    // warning. Without this, this module's own duplicate config-load pass would print it twice.
    const toml = yield* checkDbToml(fs, path, workdir, undefined, {
      warnOnUnresolvedEnv: false,
    });

    yield* setupDatabase(spawner, {
      ...input,
      webhooksEnabled: toml.webhooksEnabled,
      apiAutoExposeNewTables: toml.baseline.apiAutoExposeNewTables,
      vault: toml.vault,
    });

    // `toml.pgDelta.enabled`/`toml.schemaPaths` are this module's own already-loaded,
    // env-overridden config, not re-read from the caller's raw `CliConfig`.
    yield* migrateAndSeed(session, fs, path, workdir, input.version, {
      migrationsEnabled: toml.migrationsEnabled,
      seed: resolveResetSeedConfig(toml.seed, input.seedFlags, path),
      experimental: input.experimental,
      pgDeltaEnabled: toml.pgDelta.enabled,
      schemaPaths: toml.schemaPaths,
      localDatabaseWebhooksEnabled: toml.webhooksEnabled,
    });
  });

/**
 * The `setup` shape shared by `db start`'s fresh-volume branch and `db reset`'s PG15 recreate:
 * everything {@link startSetupLocalDatabase} needs, minus what {@link runFreshDbSetup} itself
 * already resolves and threads through (`session`, `images`).
 */
export interface FreshDbSetupInput<E> {
  readonly majorVersion: number;
  /** Already spliced with the caller's own service-enabled/override values; see `bootstrap-config.ts`'s `DbBootstrapConfig`. */
  readonly config: StartSetupLocalDatabaseInput["config"];
  /** Threaded straight through to {@link StartSetupLocalDatabaseInput.experimental}. */
  readonly experimental: boolean;
  readonly dbUrl: string;
  readonly jwtSecret: string;
  /** Lazy; evaluated only when `majorVersion >= 15` and `realtimeEnabledForSetup` (see {@link resolveDbSetupPrelude}). Caller-supplied rather than resolved here unconditionally. */
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
  /** Threaded straight through to {@link StartSetupLocalDatabaseInput.debug}. */
  readonly debug: boolean;
}

const connectLocalPostgres = (input: {
  readonly hostname: string;
  readonly dbPort: number;
  readonly password: string;
}) =>
  Effect.gen(function* () {
    const dbConnection = yield* DbConnection;
    return yield* dbConnection
      .connect(
        {
          host: input.hostname,
          port: input.dbPort,
          user: "postgres",
          password: input.password,
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
  });

/** Converges pg_net while preserving extensions installed by user migrations. */
export const runDatabaseWebhooksSetup = (input: {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly hostname: string;
  readonly dbPort: number;
  readonly dbUrl: string;
  readonly enabled: boolean;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* connectLocalPostgres({
        hostname: input.hostname,
        dbPort: input.dbPort,
        password: startInternalDbPassword(input.dbUrl),
      });
      if (!input.enabled) {
        const pgNetOwnedByMigrations = yield* readMigrationTable(session).pipe(
          Effect.map((migrations) =>
            migrations.some(
              (migration) =>
                // A `[]` here could mean incomplete history evidence, not a confirmed absence of
                // pg_net — treat it as installed, to be safe.
                migration.statements.length === 0 ||
                migration.statements.some(statementInstallsPgNet),
            ),
          ),
          Effect.orElseSucceed(() => true),
        );
        if (pgNetOwnedByMigrations) return;
      }
      const tmpDir = yield* input.fs
        .makeTempDirectoryScoped({ prefix: "supabase-start-db-webhooks-" })
        .pipe(
          Effect.mapError(
            (error) =>
              new DbSetupError({
                message: `failed to create temp directory: ${errMessage(error)}`,
                reason: "filesystem",
              }),
          ),
        );
      if (!input.enabled) {
        yield* removeDatabaseWebhooks(session, input.fs, input.path, tmpDir);
        return;
      }
      yield* applyDatabaseWebhooks(session, input.fs, input.path, tmpDir, input.enabled);
    }),
  );

/**
 * Runs {@link startSetupLocalDatabase} against a freshly-provisioned local Postgres: dials the
 * host-facing session, resolves the {@link resolveDbSetupPrelude} prelude, then runs the setup
 * pipeline. `version`/`seedFlags` are the one difference between callers — `db start` always
 * passes `""`/a no-op override, `db reset` passes its own resolved reset version and flags.
 */
export const runFreshDbSetup = <E>(
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
    readonly setup: FreshDbSetupInput<E>;
  },
): Effect.Effect<
  void,
  StartSetupLocalDatabaseError | DbConnectError | ImagePrepullError | E,
  Output | DbConnection | DockerRun | RuntimeInfo | FileSystem.FileSystem | Path.Path
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const { setup } = input;
      const dbPassword = startInternalDbPassword(setup.dbUrl);
      // Retries dial-level failures: the container's internal health check says nothing about
      // the host side, where Docker Desktop (Windows/WSL2) can publish the port a few seconds
      // late.
      const session = yield* connectLocalPostgres({
        hostname: input.hostname,
        dbPort: input.dbPort,
        password: dbPassword,
      });

      const { jwks, images: dbSetupImages } = yield* resolveDbSetupPrelude(setup);

      yield* startSetupLocalDatabase(spawner, {
        session,
        fs: input.fs,
        path: input.path,
        workdir: input.workdir,
        config: setup.config,
        experimental: setup.experimental,
        majorVersion: setup.majorVersion,
        dbHost: localDbContainerId(input.projectId),
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
