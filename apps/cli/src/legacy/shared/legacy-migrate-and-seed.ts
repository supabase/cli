import { Effect, type FileSystem, type Path } from "effect";

import { Output } from "../../shared/output/output.service.ts";
import type { LegacyDbSession } from "./legacy-db-connection.service.ts";
import type { LegacyDbExecError } from "./legacy-db-connection.errors.ts";
import {
  LegacyMigrationApplyError,
  legacyApplyMigrationFile,
  legacyApplySchemaFiles,
} from "./legacy-migration-apply.ts";
import { legacyLoadPartialMigrations } from "./legacy-migration-history.ts";
import {
  LEGACY_ENABLE_LOCAL_WEBHOOKS_SUGGESTION,
  legacyIsPgNetUnavailableError,
} from "./legacy-pg-net-guidance.ts";
import { legacyApplySeedFiles, type LegacySeedConfig } from "./legacy-seed.ts";

/** Config consumed by `legacyMigrateAndSeed`. */
export interface LegacyMigrateAndSeedConfig {
  /** Fully resolved environment for scanner/config overrides; never read from process globals. */
  readonly projectEnv: Readonly<Record<string, string>>;
  readonly migrationsEnabled: boolean;
  readonly seed: LegacySeedConfig;
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
  dbError: LegacyDbExecError | undefined,
  localDatabaseWebhooksEnabled: boolean | undefined,
): LegacyMigrationApplyError => {
  const pgNetUnavailable =
    localDatabaseWebhooksEnabled === false &&
    dbError !== undefined &&
    legacyIsPgNetUnavailableError(dbError);
  return new LegacyMigrationApplyError({
    message,
    suggestion: pgNetUnavailable ? LEGACY_ENABLE_LOCAL_WEBHOOKS_SUGGESTION : undefined,
    reason: pgNetUnavailable ? "local_pg_net_unavailable" : undefined,
  });
};

/**
 * Reapplies local migrations up to `version`, then runs seed files. Port of Go's
 * `apply.MigrateAndSeed`: when `experimental` is
 * set, `version` is empty, and `pgDeltaEnabled` is false, the declarative `schemaPaths`
 * files are applied INSTEAD of migration files via the shared {@link legacyApplySchemaFiles}
 * (`legacy-migration-apply.ts` — also used by `db reset`'s own `--experimental` remote path,
 * so both callers share one Go-quirk-preserving implementation instead of two), bypassing
 * `migrationsEnabled` entirely — `applySchemaFiles` has no such gate, only
 * `applyMigrationFiles` does; otherwise migration apply is gated on `db.migrations.enabled` as
 * before. Seeding (`db.seed.enabled`, inside the seed helper) always runs, on either branch.
 */
export const legacyMigrateAndSeed = (
  session: LegacyDbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  version: string,
  config: LegacyMigrateAndSeedConfig,
) =>
  Effect.gen(function* () {
    const output = yield* Output;
    if (config.experimental && version.length === 0 && !config.pgDeltaEnabled) {
      yield* legacyApplySchemaFiles(
        session,
        fs,
        path,
        workdir,
        config.schemaPaths,
        (message, suggestion) => new LegacyMigrationApplyError({ message, suggestion }),
      );
    } else if (config.migrationsEnabled) {
      const migrationsDir = path.join(workdir, "supabase", "migrations");
      const pending = yield* legacyLoadPartialMigrations(fs, path, migrationsDir, version).pipe(
        Effect.mapError((cause) => new LegacyMigrationApplyError({ message: cause.message })),
      );
      for (const migrationPath of pending) {
        yield* output.raw(`Applying migration ${path.basename(migrationPath)}...\n`, "stderr");
        yield* legacyApplyMigrationFile(session, fs, path, migrationPath, (message, dbError) =>
          migrationApplyError(message, dbError, config.localDatabaseWebhooksEnabled),
        );
      }
    }
    yield* legacyApplySeedFiles(session, fs, path, workdir, config.seed, config.projectEnv);
  });
