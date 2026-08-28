import { Effect, Option, type FileSystem, type Path } from "effect";

import { Output } from "../../shared/output/output.service.ts";
import { legacyCompareUtf8Bytes } from "./legacy-glob.ts";
import { LegacyMigrationsReadError } from "./legacy-migration.errors.ts";

// `pkg/migration/list.go` — `<14-digit>_init.sql` first migrations (pre-2021-12-09) are skipped.
const INIT_SCHEMA_PATTERN = /([0-9]{14})_init\.sql/;
const INIT_SCHEMA_CUTOFF = 20211209000000;
// `pkg/migration/file.go` — valid migration filenames.
const MIGRATE_FILE_PATTERN = /^([0-9]+)_(.*)\.sql$/;

/**
 * Lists local migration file paths under `migrationsDir`. Mirrors Go's
 * `migration.ListLocalMigrations` (`pkg/migration/list.go:33`): entries are sorted by name — Go's
 * `fs.ReadDir` byte-wise UTF-8 order, via {@link legacyCompareUtf8Bytes}, not JS's default
 * UTF-16-code-unit `Array.prototype.sort()` — directories skipped, a deprecated
 * `<14-digit>_init.sql` first migration (pre-2021-12-09) is skipped, and names must match
 * `<digits>_*.sql`.
 *
 * Each skipped file emits a byte-exact stderr warning matching Go's
 * `fmt.Fprintf(os.Stderr, …)` (`list.go:45-53`) — same wording for both the
 * deprecated-init and misnamed-file cases. Because this is the shared lister,
 * the warning fires for the `db diff/pull/schema declarative` and pgcache paths
 * too, not only the `migration` commands, exactly as in Go.
 */
export const legacyListLocalMigrations = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationsDir: string,
) {
  const output = yield* Output;
  // Mirror Go's single `fs.ReadDir` (`pkg/migration/list.go:34-37`): only a
  // not-exist directory is "no migrations"; every other read error (the path is a
  // file → `ENOTDIR`, permission denied, …) aborts rather than silently letting
  // smart generate/sync believe there are no local migrations. Effect surfaces
  // "not found" as a `PlatformError` with a `SystemError` reason tagged `"NotFound"`.
  const names = yield* fs.readDirectory(migrationsDir).pipe(
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed([] as ReadonlyArray<string>)
        : Effect.fail(
            new LegacyMigrationsReadError({
              message: `failed to read directory: ${error.message}`,
            }),
          ),
    ),
  );
  if (names.length === 0) return [] as ReadonlyArray<string>;
  // Go's `fs.ReadDir` (`pkg/migration/list.go:34`) returns entries sorted byte-wise over each
  // name's UTF-8 encoding — NOT JS's default `Array.prototype.sort()`, which compares UTF-16 code
  // units and disagrees with byte/codepoint order for a supplementary-plane filename character
  // alongside a BMP private-use one (see {@link legacyCompareUtf8Bytes}'s own doc comment,
  // verified empirically there against both Go's `sort.Strings` and `os.ReadDir`). Left
  // uncorrected, such a migrations directory would replay in a different order than Go, and a
  // dependent migration could fail or produce a different shadow schema (review:
  // PRRT_kwDOErm0O86W3OyD).
  const sorted = [...names].sort(legacyCompareUtf8Bytes);
  const result: Array<string> = [];
  for (let index = 0; index < sorted.length; index++) {
    const name = sorted[index]!;
    const entryPath = path.join(migrationsDir, name);
    // Go's `os.ReadDir`/`DirEntry.IsDir()` (`pkg/migration/list.go:34-43`) classifies a
    // directory entry from its own type without following symlinks (verified empirically:
    // `DirEntry.IsDir()` reports `false` for a `.sql` symlink whose target is a directory) —
    // so a symlinked migration is never skipped as a directory in Go, only later, when
    // `ApplyMigrations` fails to read it as a regular file. `fs.stat` below follows
    // symlinks, so it would misclassify a symlink-to-directory as a plain directory and
    // silently skip it here instead. Check `readLink` (which only succeeds for a symlink)
    // first and skip the directory check entirely for symlinks, matching Go's `IsDir()`.
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
  return result as ReadonlyArray<string>;
});
