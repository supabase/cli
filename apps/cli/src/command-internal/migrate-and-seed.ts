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
   * `--experimental`/`SUPABASE_EXPERIMENTAL` — combined with an empty `version` and
   * `pgDeltaEnabled === false`, switches from applying migration files to applying
   * `schemaPaths`'s declarative schema files instead.
   */
  readonly experimental: boolean;
  /** `[experimental.pgdelta] enabled`. See `experimental` above. */
  readonly pgDeltaEnabled: boolean;
  /** `db.migrations.schema_paths`; only read by the declarative branch above. */
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
 * Reapplies local migrations up to `version`, then runs seed files.
 *
 * When `experimental` is set, `version` is empty, and `pgDeltaEnabled` is false, the declarative
 * `schemaPaths` files are applied instead of migration files, via the shared
 * {@link applySchemaFiles} — bypassing `migrationsEnabled` entirely, since only
 * `applyMigrationFiles` is gated on it. Otherwise migration apply is gated on
 * `db.migrations.enabled` as usual. Seeding always runs, on either branch.
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
