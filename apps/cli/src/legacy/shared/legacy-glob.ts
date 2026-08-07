import { Effect, type FileSystem, type Path } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { legacyPathMatch } from "./legacy-path-match.ts";

/**
 * Hoisted `Config.Glob` filesystem-matching primitives — Go's `io/fs.Glob` (per-pattern
 * matching) plus the workdir-relative-vs-absolute resolution `pkg/config/config.go`'s
 * loader applies to every glob-shaped config field. Originally private to
 * `legacy-seed.ts` (the first caller, `[db.seed] sql_paths`); hoisted here once
 * `legacy-migrate-and-seed.ts`'s declarative-schema-files branch (`[db.migrations]
 * schema_paths`, Go's `Glob.SQLFiles`) became a second caller — see `apps/cli/CLAUDE.md`'s
 * "Hoist Before You Duplicate".
 */

// Go's `io/fs.hasMeta` (`glob.go`): the magic-character set is `*`, `?`, `[`, and `\`
// (escape) — `\` counts so a pattern whose only glob syntax is a backslash escape (e.g.
// `foo\.sql`) is globbed via `legacyPathMatch` (which handles the escape) instead of being
// treated as a literal filename and missing the real file. Go applies `filepath.ToSlash`
// before globbing, so a `\` here is always a glob escape, never a path separator.
const legacyHasGlobMeta = (pattern: string): boolean => /[*?[\\]/u.test(pattern);

// Go's split (`path.Split` + `cleanGlobPath`, `io/fs/glob.go`) reduces a Windows drive-root
// pattern like `C:/*.sql` (post `filepath.ToSlash`) to a bare `C:` directory component — one
// level up from `legacyGlobPattern`'s own slash-split below — which is still part of the SAME
// already-absolute pattern's root, never something to join under the workdir, even though
// `path.isAbsolute("C:")` is `false` (Node's win32 rules require the trailing separator,
// `C:\`/`C:/`, to call a path absolute; a bare `C:` alone is technically "drive-relative").
// Recognize that exact shape so it reaches `fs.readDirectory`/`fs.exists` verbatim, mirroring
// Go passing it straight through to `ReadDir`/`Stat` on the same real, unrooted `afero.NewOsFs`.
const legacyIsWindowsDriveRoot = (p: string): boolean => /^[A-Za-z]:$/.test(p);

// Go globs/reads glob-config paths through an OS-root-rooted `afero.NewOsFs`, where the
// CLI's "workdir" is just `os.Chdir(workdir)` (`internal/utils/misc.go`) — which only
// affects RELATIVE paths. An absolute glob-config entry, preserved verbatim by the config
// loader (`pkg/config/config.go`, gated on `!filepath.IsAbs`), therefore resolves at the OS
// root, never under the workdir. Mirror that: only join under the workdir when the path is
// relative (`path.join` would otherwise collapse `/repo` + `/tmp/seed.sql` to
// `/repo/tmp/seed.sql`).
export const legacyResolveUnderWorkdir = (path: Path.Path, workdir: string, p: string): string =>
  path.isAbsolute(p) || legacyIsWindowsDriveRoot(p) ? p : path.join(workdir, p);

/**
 * Resolves a single glob pattern against the workdir, returning the matched paths RELATIVE
 * to the workdir (so callers stay Go-compatible, e.g. `seed_files.path`). Mirrors Go's
 * `fs.Glob`: a literal pattern (no glob metacharacter anywhere) returns itself iff it
 * exists; a pattern with metacharacters lists each parent directory and matches per segment
 * via `legacyPathMatch` (Go's `path.Match`). The caller validates the whole pattern up
 * front (`legacyPathMatch(pattern, "").badPattern`), so a malformed class never reaches
 * here.
 */
export const legacyGlobPattern = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  pattern: string,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    // Go's `Glob.files` calls `fs.Glob(fsys, filepath.ToSlash(pattern))` (`config.go:143-145`,
    // comment: "Glob expects / as path separator on windows") — a no-op on POSIX, where
    // `path.sep` is already `/`, but on Windows it replaces every `\` with `/` BEFORE any
    // meta-detection or directory-splitting happens. Without this, a Windows entry with
    // backslashes — an absolute one is preserved verbatim by `legacyResolveSeedSqlPath`, but
    // even a relative one can carry them — never matches the `/`-only split below and
    // `legacyHasGlobMeta` misreads a plain backslash as glob syntax, so a literal path like
    // `schemas\foo.sql` or a real pattern like `schemas\*.sql` would silently resolve to
    // nothing instead of the configured file.
    const normalized = path.sep === "/" ? pattern : pattern.replaceAll("\\", "/");
    if (!legacyHasGlobMeta(normalized)) {
      const exists = yield* fs
        .exists(legacyResolveUnderWorkdir(path, workdir, normalized))
        .pipe(Effect.orElseSucceed(() => false));
      return exists ? [normalized] : [];
    }
    const slash = normalized.lastIndexOf("/");
    // Go's `path.Split`/`cleanGlobPath` (`io/fs/glob.go`) keep a root-only directory distinct
    // from "no directory at all": splitting a POSIX-root pattern like `/*.sql` yields a bare
    // `/`, which Go still globs as the fsys root — NOT the workdir `afero.NewOsFs()` happens to
    // have `chdir`-ed into — and every match it returns stays `/`-prefixed. Collapsing that to
    // `""` here (indistinguishable from the truly relative no-slash case below, where `""`
    // correctly means "resolve under workdir") would silently glob the workdir instead of the
    // real root for a pattern whose ONLY slash is the leading one. Confirmed empirically
    // against the real, unrooted `afero.NewOsFs()` Go itself globs through: `Glob{"/*"}.
    // Files(fsys)` lists the actual filesystem root's entries, each still `/`-prefixed, not
    // Go's cwd.
    const dirPattern = slash === -1 ? "" : slash === 0 ? "/" : normalized.slice(0, slash);
    const filePattern = slash === -1 ? normalized : normalized.slice(slash + 1);
    const dirs = legacyHasGlobMeta(dirPattern)
      ? yield* legacyGlobPattern(fs, path, workdir, dirPattern)
      : [dirPattern];
    const result: Array<string> = [];
    for (const dir of dirs) {
      const absDir = dir.length === 0 ? workdir : legacyResolveUnderWorkdir(path, workdir, dir);
      const names = yield* fs.readDirectory(absDir).pipe(Effect.orElseSucceed(() => []));
      for (const name of names) {
        if (legacyPathMatch(filePattern, name).matched) {
          // `dir` is already `/` for the bare-root case above — appending `/${name}` the same
          // way every other (non-root) `dir` value does below would double the separator.
          result.push(
            dir.length === 0 ? name : dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`,
          );
        }
      }
    }
    return result;
  });

/**
 * Port of Go's `walkMatchedDir` (`pkg/config/config.go:194-207`, called by `Glob.SQLFiles` on
 * every directory match): a manual, non-recursing-through-`{recursive: true}` walk, because
 * Go's `fs.WalkDir` never follows a symlinked `DirEntry` — its `IsDir()` is false for a
 * symlink regardless of target, so `WalkDir` neither descends into a symlinked subdirectory
 * nor lets `entry.Type().IsRegular()` (the `.sql`-file inclusion check) pass a symlinked file.
 * The `FileSystem` service exposes no non-following `lstat`; `fs.readLink` succeeding on a
 * path IS Effect's only non-following "is this a symlink" primitive, so it stands in for that
 * check at each level, both for recursion (a symlinked directory is skipped, not walked) and
 * for file inclusion (a symlinked `.sql` file is skipped, not applied) — using `fs.stat`
 * (which follows) here instead would silently include a symlink's target, unlike Go. Returns
 * paths relative to `dir`; the caller does the single final sort over the whole aggregate,
 * matching Go's one `sort.Strings(files)` after the complete walk rather than per-directory.
 *
 * Hoisted here (from `legacy-migrate-and-seed.ts`, the first caller, for `db.migrations.
 * schema_paths`) once `legacy-seed.ts`'s `db.seed.sql_paths` resolution became a second
 * caller — Go's `Glob.SQLFiles` (`pkg/config/config.go:122-128`) is the SAME method both
 * config fields resolve through (`GetPendingSeeds` calls `locals.SQLFiles(fsys)` exactly like
 * `applySchemaFiles`'s `SchemaPaths.SQLFiles(fsys)`), so a matched seed directory must expand
 * to its sorted regular `.sql` files exactly like a matched schema-path directory does.
 */
export const legacyWalkSqlFiles = (
  fs: FileSystem.FileSystem,
  dir: string,
  relativePrefix: string,
): Effect.Effect<ReadonlyArray<string>, PlatformError> =>
  Effect.gen(function* () {
    const names = yield* fs.readDirectory(dir);
    const files: Array<string> = [];
    for (const name of names) {
      const absChild = `${dir}/${name}`;
      const relChild = relativePrefix.length === 0 ? name : `${relativePrefix}/${name}`;
      const isSymlink = yield* fs.readLink(absChild).pipe(
        Effect.map(() => true),
        Effect.orElseSucceed(() => false),
      );
      if (isSymlink) continue;
      // Unlike the `readLink` probe above (where failure legitimately just means "not a
      // symlink"), a `stat` failure here means something actually went wrong reading an entry
      // `readDirectory` just listed (removed mid-walk, permission denied, I/O error) — Go's
      // `fs.WalkDir` (`walkMatchedDir`, `pkg/config/config.go:194-207`) propagates that exact
      // error from its walk callback, aborting `Glob.SQLFiles`/`Config.Load` entirely rather than
      // silently treating the entry as absent. Swallowing it here would let a declared
      // `db.migrations.schema_paths`/`db.seed.sql_paths` directory silently apply an incomplete
      // set of files instead of failing the command (review: PRRT_kwDOErm0O86WXFqr).
      const info = yield* fs.stat(absChild);
      if (info.type === "Directory") {
        files.push(...(yield* legacyWalkSqlFiles(fs, absChild, relChild)));
      } else if (info.type === "File" && relChild.endsWith(".sql")) {
        files.push(relChild);
      }
    }
    return files;
  });
