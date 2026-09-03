import { Effect, Option, Predicate, type FileSystem, type Path } from "effect";

import { Output } from "../../shared/output/output.service.ts";
import { legacyCompareUtf8Bytes } from "./legacy-glob.ts";
import { LegacyMigrationsReadError } from "./legacy-migration.errors.ts";

// A first migration named `<14-digit>_init.sql` with a timestamp before 2021-12-09 is a
// deprecated init schema and is skipped.
const INIT_SCHEMA_PATTERN = /([0-9]{14})_init\.sql/;
const INIT_SCHEMA_CUTOFF = 20211209000000;
// Valid migration filenames: `<digits>_<name>.sql`.
const MIGRATE_FILE_PATTERN = /^([0-9]+)_(.*)\.sql$/;

const NO_MIGRATIONS: ReadonlyArray<string> = [];

/**
 * Lists local migration file paths under `migrationsDir`. Entries are sorted byte-wise over each
 * name's UTF-8 encoding, via {@link legacyCompareUtf8Bytes} — not JS's default
 * UTF-16-code-unit `Array.prototype.sort()`. Directories are skipped, a deprecated
 * `<14-digit>_init.sql` first migration (pre-2021-12-09) is skipped, and names must match
 * `<digits>_*.sql`.
 *
 * Each skipped file emits the established stderr warning — same wording for both the
 * deprecated-init and misnamed-file cases. Because this is the shared lister, the warning
 * fires for the `db diff/pull/schema declarative` paths too, not only the `migration`
 * commands.
 */
export const legacyListLocalMigrations = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationsDir: string,
) {
  const output = yield* Output;
  // Only a not-exist directory means "no migrations"; every other read error (the path
  // is a file → `ENOTDIR`, permission denied, …) aborts rather than silently letting
  // smart generate/sync believe there are no local migrations. Effect surfaces
  // "not found" as a `PlatformError` with a `SystemError` reason tagged `"NotFound"`.
  const names = yield* fs.readDirectory(migrationsDir).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Predicate.isTagged(error.reason, "NotFound")
        ? Effect.succeed(NO_MIGRATIONS)
        : Effect.fail(
            new LegacyMigrationsReadError({
              message: `failed to read directory: ${error.message}`,
            }),
          ),
    ),
  );
  if (names.length === 0) return NO_MIGRATIONS;
  // Entries must sort byte-wise over each name's UTF-8 encoding — NOT JS's default
  // `Array.prototype.sort()`, which compares UTF-16 code units and disagrees with byte/codepoint
  // order for a supplementary-plane filename character alongside a BMP private-use one (see
  // {@link legacyCompareUtf8Bytes}'s own doc comment). Left uncorrected, such a migrations
  // directory would replay in a different order than previous releases, and a dependent
  // migration could fail or produce a different shadow schema.
  const sorted = [...names].sort(legacyCompareUtf8Bytes);
  const result: Array<string> = [];
  for (let index = 0; index < sorted.length; index++) {
    const name = sorted[index]!;
    const entryPath = path.join(migrationsDir, name);
    // Directory entries are classified from their own type without following symlinks: a
    // `.sql` symlink whose target is a directory is never skipped as a directory here — it
    // only fails later, when the migration is read as a regular file. `fs.stat` below follows
    // symlinks, so it would misclassify a symlink-to-directory as a plain directory and
    // silently skip it. Check `readLink` (which only succeeds for a symlink) first and skip
    // the directory check entirely for symlinks.
    const isSymlink = Option.isSome(yield* fs.readLink(entryPath).pipe(Effect.option));
    if (!isSymlink) {
      const stat = yield* fs.stat(entryPath).pipe(Effect.option);
      if (Option.isSome(stat) && stat.value.type === "Directory") continue;
    }
    if (index === 0) {
      const init = INIT_SCHEMA_PATTERN.exec(name);
      if (init !== null && Number(init[1]) < INIT_SCHEMA_CUTOFF) {
        yield* output.raw(
          `Skipping migration ${name}... (replace "init" with a different file name to apply this migration)\n`,
          "stderr",
        );
        continue;
      }
    }
    if (!MIGRATE_FILE_PATTERN.test(name)) {
      yield* output.raw(
        `Skipping migration ${name}... (file name must match pattern "<timestamp>_name.sql")\n`,
        "stderr",
      );
      continue;
    }
    result.push(entryPath);
  }
  return result;
});
