import { Effect, type FileSystem, Option, type Path, Ref } from "effect";

import { Output } from "../shared/output/output.service.ts";
import type { DbSession } from "./db-connection.service.ts";
import type { DbExecError } from "./db-connection.errors.ts";
import type { DbTomlValues } from "./db-config.toml-read.ts";
import { MigrationApplyError, applyMigrationFile, applySchemaFiles } from "./migration-apply.ts";
import {
  MigrationChecksDeferral,
  MigrationChecksSkipped,
  migrationChecksRun,
  startMigrationChecks,
} from "./migration-checks.ts";
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
  /**
   * `[db.migrations.checks]` and `[api].schemas` for a local replay's end-state check. Omitted,
   * the replay runs no checks; `--skip-checks` arrives through {@link MigrationChecksSkipped}.
   */
  readonly checks?: Pick<DbTomlValues, "migrationChecks" | "apiSchemas">;
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

/** Warns a versionless `--experimental` rebuild that `schema_paths` is ignored while pg-delta is on. */
export const experimentalSchemaPathsIgnoredWarning =
  "WARNING: [db.migrations].schema_paths is not applied while pg-delta is enabled (the default). Set [experimental.pgdelta] enabled = false to apply schema_paths files.\n";

/** Whether {@link experimentalSchemaPathsIgnoredWarning} applies to this rebuild. */
export const ignoresExperimentalSchemaPaths = (inputs: {
  readonly experimental: boolean;
  readonly version: string;
  readonly pgDeltaEnabled: boolean;
  readonly schemaPaths: ReadonlyArray<string>;
}): boolean =>
  inputs.experimental &&
  inputs.version.length === 0 &&
  inputs.pgDeltaEnabled &&
  inputs.schemaPaths.length > 0;

/**
 * Reapplies local migrations up to `version`, then runs seed files.
 *
 * When `experimental` is set, `version` is empty, and `pgDeltaEnabled` is false, the declarative
 * `schemaPaths` files are applied instead of migration files, via the shared
 * {@link applySchemaFiles} — bypassing `migrationsEnabled` entirely, since only
 * `applyMigrationFiles` is gated on it. Otherwise migration apply is gated on
 * `db.migrations.enabled` as usual. Seeding always runs, on either branch.
 *
 * With `config.checks`, one security check reads the end state after the last migration and
 * before seeding; an error-level finding fails the replay, unless the caller supplies
 * {@link MigrationChecksDeferral}, which collects it instead.
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
    if (ignoresExperimentalSchemaPaths({ ...config, version })) {
      yield* output.raw(experimentalSchemaPathsIgnoredWarning, "stderr");
    }
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
      const skip = yield* MigrationChecksSkipped;
      const tracker =
        config.checks === undefined || pending.length === 0
          ? undefined
          : yield* startMigrationChecks(session, migrationChecksRun(config.checks, skip));
      for (const migrationPath of pending) {
        yield* output.raw(`Applying migration ${path.basename(migrationPath)}...\n`, "stderr");
        yield* applyMigrationFile(session, fs, path, migrationPath, (message, dbError) =>
          migrationApplyError(message, dbError, config.localDatabaseWebhooksEnabled),
        );
      }
      if (tracker !== undefined) {
        const deferral = yield* MigrationChecksDeferral;
        yield* tracker.endState.pipe(
          Effect.asVoid,
          deferral === undefined
            ? (effect) => effect
            : Effect.catchTag("MigrationChecksBlockedError", (error) =>
                Ref.set(deferral, Option.some(error)),
              ),
        );
      }
    }
    yield* applySeedFiles(session, fs, path, workdir, config.seed);
  });
