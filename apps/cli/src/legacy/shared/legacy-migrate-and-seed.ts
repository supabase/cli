import { Effect, type FileSystem, type Path } from "effect";

import { Output } from "../../shared/output/output.service.ts";
import type { LegacyDbSession } from "./legacy-db-connection.service.ts";
import { LegacyMigrationApplyError, legacyApplyMigrationFile } from "./legacy-migration-apply.ts";
import { legacyLoadPartialMigrations } from "./legacy-migration-history.ts";
import { legacyApplySeedFiles, type LegacySeedConfig } from "./legacy-seed.ts";

/** Config consumed by `legacyMigrateAndSeed`. */
export interface LegacyMigrateAndSeedConfig {
  readonly migrationsEnabled: boolean;
  readonly seed: LegacySeedConfig;
}

/**
 * Reapplies local migrations up to `version`, then runs seed files. Port of Go's
 * `apply.MigrateAndSeed` (`internal/migration/apply/apply.go:16`) for the
 * `version`-set path (the EXPERIMENTAL declarative `applySchemaFiles` branch is
 * unreachable from `migration down`, which always passes a concrete version, so
 * it is intentionally not ported). Migration apply is gated on
 * `db.migrations.enabled`; seeding on `db.seed.enabled` (inside the seed helper).
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
    if (config.migrationsEnabled) {
      const migrationsDir = path.join(workdir, "supabase", "migrations");
      const pending = yield* legacyLoadPartialMigrations(fs, path, migrationsDir, version).pipe(
        Effect.mapError((cause) => new LegacyMigrationApplyError({ message: cause.message })),
      );
      for (const migrationPath of pending) {
        yield* output.raw(`Applying migration ${path.basename(migrationPath)}...\n`, "stderr");
        yield* legacyApplyMigrationFile(
          session,
          fs,
          path,
          migrationPath,
          (message) => new LegacyMigrationApplyError({ message }),
        );
      }
    }
    yield* legacyApplySeedFiles(session, fs, path, workdir, config.seed);
  });
