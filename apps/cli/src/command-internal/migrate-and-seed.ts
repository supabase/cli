import { Effect, type FileSystem, type Path } from "effect";

import { Output } from "../shared/output/output.service.ts";
import type { DbSession } from "./db-connection.service.ts";
import type { DbExecError } from "./db-connection.errors.ts";
import { MigrationApplyError, applyMigrationFile, applySchemaFiles } from "./migration-apply.ts";
import { loadPartialMigrations } from "./migration-history.ts";
import { ENABLE_LOCAL_WEBHOOKS_SUGGESTION, isPgNetUnavailableError } from "./pg-net-guidance.ts";
import { applySeedFiles, type SeedConfig } from "./seed.ts";

/** Config consumed by `migrateAndSeed`. */
export interface MigrateAndSeedConfig {
  readonly migrationsEnabled: boolean;
  readonly seed: SeedConfig;
  /**
   * `--experimental`/`SUPABASE_EXPERIMENTAL` — together with an empty `version` and
   * `pgDeltaEnabled === false`, switches the branch below from applying migration files to
   * applying `schemaPaths`'s declarative schema files instead. `migration down` (the other
   * caller of this function) always passes a concrete `version`, so `len(version) == 0`
   * half of the same condition is already false there regardless of this field — see that
   * call site's own comment for why a static value is safe.
   */
  readonly experimental: boolean;
  /** `[experimental.pgdelta] enabled` — `utils.IsPgDeltaEnabled()`. See `experimental` above. */
  readonly pgDeltaEnabled: boolean;
  /** `db.migrations.schema_paths` — `Config.Db.Migrations.SchemaPaths`. Only read by the declarative branch above. */
  readonly schemaPaths: ReadonlyArray<string>;
  /**
   * Effective local `[experimental.webhooks].enabled` value. `undefined` means
   * this is not a local start/reset replay and disables local-only remediation.
   */
  readonly localDatabaseWebhooksEnabled?: boolean;
}

const migrationApplyError = (
  message: string,
  dbError: DbExecError | undefined,
  localDatabaseWebhooksEnabled: boolean | undefined,
): MigrationApplyError => {
  const pgNetUnavailable =
    localDatabaseWebhooksEnabled === false &&
    dbError !== undefined &&
    isPgNetUnavailableError(dbError);
  return new MigrationApplyError({
    message,
    suggestion: pgNetUnavailable ? ENABLE_LOCAL_WEBHOOKS_SUGGESTION : undefined,
    reason: pgNetUnavailable ? "local_pg_net_unavailable" : undefined,
  });
};

/**
 * Reapplies local migrations up to `version`, then runs seed files. Port of Go's
 * `apply.MigrateAndSeed`: when `experimental` is
 * set, `version` is empty, and `pgDeltaEnabled` is false, the declarative `schemaPaths`
 * files are applied INSTEAD of migration files via the shared {@link applySchemaFiles}
 * (`migration-apply.ts` — also used by `db reset`'s own `--experimental` remote path,
 * so both callers share one Go-quirk-preserving implementation instead of two), bypassing
 * `migrationsEnabled` entirely — `applySchemaFiles` has no such gate, only
 * `applyMigrationFiles` does; otherwise migration apply is gated on `db.migrations.enabled` as
 * before. Seeding (`db.seed.enabled`, inside the seed helper) always runs, on either branch.
 */
export const migrateAndSeed = (
  session: DbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  version: string,
  config: MigrateAndSeedConfig,
) =>
  Effect.gen(function* () {
    const output = yield* Output;
    if (config.experimental && version.length === 0 && !config.pgDeltaEnabled) {
      yield* applySchemaFiles(
        session,
        fs,
        path,
        workdir,
        config.schemaPaths,
        (message, suggestion) => new MigrationApplyError({ message, suggestion }),
      );
    } else if (config.migrationsEnabled) {
      const migrationsDir = path.join(workdir, "supabase", "migrations");
      const pending = yield* loadPartialMigrations(fs, path, migrationsDir, version).pipe(
        Effect.mapError((cause) => new MigrationApplyError({ message: cause.message })),
      );
      for (const migrationPath of pending) {
        yield* output.raw(`Applying migration ${path.basename(migrationPath)}...\n`, "stderr");
        yield* applyMigrationFile(session, fs, path, migrationPath, (message, dbError) =>
          migrationApplyError(message, dbError, config.localDatabaseWebhooksEnabled),
        );
      }
    }
    yield* applySeedFiles(session, fs, path, workdir, config.seed);
  });
