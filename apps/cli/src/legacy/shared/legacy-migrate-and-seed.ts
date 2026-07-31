import { Effect, type FileSystem, type Path, Result } from "effect";

import { Output } from "../../shared/output/output.service.ts";
import type { LegacyDbSession } from "./legacy-db-connection.service.ts";
import { legacyGlobPattern, legacyResolveUnderWorkdir } from "./legacy-glob.ts";
import {
  LegacyMigrationApplyError,
  legacyApplyMigrationFile,
  legacyExecSqlFile,
} from "./legacy-migration-apply.ts";
import { legacyLoadPartialMigrations } from "./legacy-migration-history.ts";
import { LEGACY_BAD_PATTERN_MESSAGE, legacyPathMatch } from "./legacy-path-match.ts";
import { legacyApplySeedFiles, type LegacySeedConfig } from "./legacy-seed.ts";

/** Config consumed by `legacyMigrateAndSeed`. */
export interface LegacyMigrateAndSeedConfig {
  readonly migrationsEnabled: boolean;
  readonly seed: LegacySeedConfig;
  /**
   * `--experimental`/`SUPABASE_EXPERIMENTAL` (Go's `viper.GetBool("EXPERIMENTAL")`,
   * `internal/migration/apply/apply.go:19`) — together with an empty `version` and
   * `pgDeltaEnabled === false`, switches the branch below from applying migration files to
   * applying `schemaPaths`'s declarative schema files instead. `migration down` (the other
   * caller of this function) always passes a concrete `version`, so Go's `len(version) == 0`
   * half of the same condition is already false there regardless of this field — see that
   * call site's own comment for why a static value is safe.
   */
  readonly experimental: boolean;
  /** `[experimental.pgdelta] enabled` — Go's `utils.IsPgDeltaEnabled()`. See `experimental` above. */
  readonly pgDeltaEnabled: boolean;
  /** `db.migrations.schema_paths` — Go's `Config.Db.Migrations.SchemaPaths`. Only read by the declarative branch above. */
  readonly schemaPaths: ReadonlyArray<string>;
}

/**
 * Port of Go's `Glob.SQLFiles` (`pkg/config/config.go:122-128` → `files`/`walkMatchedDir`),
 * called with zero `GlobOption`s exactly like `applySchemaFiles`'s own call
 * (`internal/migration/apply/apply.go:52`): each `schemaPaths` pattern is glob-matched, in
 * declared order, via {@link legacyGlobPattern} — the same `fs.Glob` port `[db.seed]
 * sql_paths` already uses. Patterns arrive already resolved to Go's config-load form
 * (supabase-prefixed and `path.Clean`-ed when relative) — `legacyCheckDbToml`
 * (`legacy-db-config.toml-read.ts`) does that once, at config-load time, the same place
 * `db.seed.sql_paths` is resolved, so this function (unlike an earlier version of this
 * comment) does no path-shape work of its own. A matched directory is expanded to its
 * `.sql` regular files, recursively, sorted; a matched plain file is kept as-is — even a
 * non-`.sql` one, since Go's `expandDir` callback only ever runs on `IsDir()` matches,
 * never on an explicitly-matched file. Results are deduplicated across ALL patterns
 * (first occurrence wins), preserving pattern declaration order.
 *
 * A pattern matching nothing, a stat failure, or a directory-walk failure is an error,
 * but — mirroring `applySchemaFiles`'s `if len(declared) == 0 { return err }` (the error
 * `Glob.SQLFiles` returns alongside a non-empty `declared` is joined from every
 * problem, including `walkMatchedDir`'s) — every such problem is discarded outright
 * whenever the combined result ends up non-empty regardless; they only surface when NO
 * pattern matched anything at all.
 */
const legacyResolveSchemaPathFiles = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  patterns: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, LegacyMigrationApplyError> =>
  Effect.gen(function* () {
    const seen = new Set<string>();
    const result: Array<string> = [];
    const problems: Array<string> = [];

    for (const pattern of patterns) {
      if (legacyPathMatch(pattern, "").badPattern) {
        problems.push(`failed to glob files: ${LEGACY_BAD_PATTERN_MESSAGE}`);
        continue;
      }
      const matches = [...(yield* legacyGlobPattern(fs, path, workdir, pattern))].sort();
      if (matches.length === 0) {
        problems.push(`no files matched pattern: ${pattern}`);
        continue;
      }
      for (const match of matches) {
        const absMatch = legacyResolveUnderWorkdir(path, workdir, match);
        const statResult = yield* fs.stat(absMatch).pipe(Effect.result);
        if (Result.isFailure(statResult)) {
          problems.push(`failed to stat matched file: ${match}`);
          continue;
        }
        if (statResult.success.type !== "Directory") {
          if (!seen.has(match)) {
            seen.add(match);
            result.push(match);
          }
          continue;
        }
        // Go's `walkMatchedDir`: recursively list the matched directory, keep only regular
        // `.sql` files, sorted (a global sort over the full relative-to-fsys-root path, not
        // per-directory — matches `sort.Strings(files)` running once after the whole walk).
        // A read/walk failure is Go's `failed to walk matched directory: %w` — recorded as a
        // problem (not silently treated as an empty directory) so it surfaces exactly like
        // Go's joined error does whenever nothing else matched anything either.
        const namesResult = yield* fs
          .readDirectory(absMatch, { recursive: true })
          .pipe(Effect.result);
        if (Result.isFailure(namesResult)) {
          problems.push(`failed to walk matched directory: ${match}`);
          continue;
        }
        const sqlRelative = namesResult.success
          .map((name) => name.replaceAll("\\", "/"))
          .filter((name) => name.endsWith(".sql"))
          .sort();
        for (const relative of sqlRelative) {
          const relativeToWorkdir = `${match}/${relative}`;
          const absEntry = legacyResolveUnderWorkdir(path, workdir, relativeToWorkdir);
          const entryStat = yield* fs.stat(absEntry).pipe(Effect.orElseSucceed(() => undefined));
          if (entryStat?.type !== "File") continue;
          if (!seen.has(relativeToWorkdir)) {
            seen.add(relativeToWorkdir);
            result.push(relativeToWorkdir);
          }
        }
      }
    }

    if (result.length === 0 && problems.length > 0) {
      return yield* Effect.fail(new LegacyMigrationApplyError({ message: problems.join("\n") }));
    }
    return result;
  });

/**
 * Port of Go's `applySchemaFiles` (`internal/migration/apply/apply.go:50-61`): applies
 * every file resolved by {@link legacyResolveSchemaPathFiles} directly, in order, WITHOUT
 * inserting a migration-history row (Go sets `schema.Version = ""` before `ExecBatch`) and
 * WITHOUT creating the history table or resetting connection state first (`applySchemaFiles`
 * calls `ExecBatch` directly on each file, unlike `applyMigrationFiles`'s
 * `migration.ApplyMigrations`) — `legacyExecSqlFile` already has exactly this shape.
 */
const legacyApplySchemaFiles = (
  session: LegacyDbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  schemaPaths: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const declared = yield* legacyResolveSchemaPathFiles(fs, path, workdir, schemaPaths);
    for (const relativePath of declared) {
      const absPath = legacyResolveUnderWorkdir(path, workdir, relativePath);
      yield* legacyExecSqlFile(
        session,
        fs,
        path,
        absPath,
        (message) => new LegacyMigrationApplyError({ message }),
      );
    }
  });

/**
 * Reapplies local migrations up to `version`, then runs seed files. Port of Go's
 * `apply.MigrateAndSeed` (`internal/migration/apply/apply.go:16-26`): when `experimental` is
 * set, `version` is empty, and `pgDeltaEnabled` is false, the declarative `schemaPaths`
 * files are applied INSTEAD of migration files (bypassing `migrationsEnabled` entirely — Go's
 * `applySchemaFiles` has no such gate, only `applyMigrationFiles` does); otherwise migration
 * apply is gated on `db.migrations.enabled` as before. Seeding (`db.seed.enabled`, inside the
 * seed helper) always runs, on either branch.
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
      yield* legacyApplySchemaFiles(session, fs, path, workdir, config.schemaPaths);
    } else if (config.migrationsEnabled) {
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
