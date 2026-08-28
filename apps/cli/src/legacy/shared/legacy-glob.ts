import { Effect, type FileSystem, type Path } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { legacyPathMatch } from "./legacy-path-match.ts";

/**
 * Hoisted `Config.Glob` filesystem-matching primitives — `io/fs.Glob` (per-pattern
 * matching) plus the workdir-relative-vs-absolute resolution the config
 * loader applies to every glob-shaped config field. Originally private to
 * `legacy-seed.ts` (the first caller, `[db.seed] sql_paths`); hoisted here once
 * `legacy-migrate-and-seed.ts`'s declarative-schema-files branch (`[db.migrations]
 * schema_paths`, `Glob.SQLFiles`) became a second caller — see `apps/cli/CLAUDE.md`'s
 * "Hoist Before You Duplicate".
 */

// `io/fs.hasMeta` (`glob.go`): the magic-character set is `*`, `?`, `[`, and `\`
// (escape) — `\` counts so a pattern whose only glob syntax is a backslash escape (e.g.
// `foo\.sql`) is globbed via `legacyPathMatch` (which handles the escape) instead of being
// treated as a literal filename and missing the real file. `filepath.ToSlash` applies
// before globbing, so a `\` here is always a glob escape, never a path separator.
const legacyHasGlobMeta = (pattern: string): boolean => /[*?[\\]/u.test(pattern);

// `path.Split` + `cleanGlobPath` (`io/fs/glob.go`) reduces a Windows drive-root
// pattern like `C:/*.sql` (post `filepath.ToSlash`) to a bare `C:` directory component — one
// level up from `legacyGlobPattern`'s own slash-split below — which is still part of the SAME
// already-absolute pattern's root, never something to join under the workdir, even though
// `path.isAbsolute("C:")` is `false` (Node's win32 rules require the trailing separator,
// `C:\`/`C:/`, to call a path absolute; a bare `C:` alone is technically "drive-relative").
// Recognize that exact shape so it reaches `fs.readDirectory`/`fs.exists` verbatim, mirroring
// it passing straight through to `ReadDir`/`Stat` on the same real, unrooted `afero.NewOsFs`.
const legacyIsWindowsDriveRoot = (p: string): boolean => /^[A-Za-z]:$/.test(p);

// Glob-config paths resolve through an OS-root-rooted `afero.NewOsFs`, where the
// CLI's "workdir" is just `os.Chdir(workdir)` — which only
// affects RELATIVE paths. An absolute glob-config entry, preserved verbatim by the config
// loader (gated on `!filepath.IsAbs`), therefore resolves at the OS
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
    // `Glob.files` calls `fs.Glob(fsys, filepath.ToSlash(pattern))`
    // (comment: "Glob expects / as path separator on windows") — a no-op on POSIX, where
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
    // `path.Split`/`cleanGlobPath` (`io/fs/glob.go`) keep a root-only directory distinct
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
 * `sort.Strings` compares byte-wise over each string's UTF-8 encoding; JS's default
 * `Array.prototype.sort()` instead compares UTF-16 CODE UNITS, which diverges from byte/codepoint
 * order for a supplementary-plane character (encoded as a surrogate pair, code units
 * `0xD800`-`0xDBFF` + `0xDC00`-`0xDFFF`) alongside a BMP private-use character (`0xE000`-
 * `0xFFFF`): JS ranks the surrogate pair BEFORE the private-use character (`0xD800 < 0xE000`),
 * while Go's UTF-8 byte order — which preserves Unicode codepoint order — ranks the
 * supplementary-plane codepoint (`>= U+10000 > U+FFFF`) AFTER it. Verified empirically:
 * `["a\u{1F600}.sql","a.sql"].sort()` (default) disagrees with `Buffer.compare` on the
 * same two strings' UTF-8 bytes. Used for every `sort.Strings` this module (and its callers
 * across `legacy-shadow-source.ts`/`legacy-migration-list.ts`) ports, so a directory with such
 * filenames applies/lists in the same order Go would.
 */
export function legacyCompareUtf8Bytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Port of `walkMatchedDir` (called by `Glob.SQLFiles` on
 * every directory match) AND `afero.Walk` (`commands/db/shared/legacy-shadow-source.ts`'s
 * declared-schema walkers' own counterpart) — both are `Lstat`-based and therefore never
 * descend into a symlinked directory:
 * `io/fs.WalkDir`'s doc comment: "WalkDir does not follow symbolic links found in directories,
 * but if root itself is a symbolic link, its target will be walked"; `afero.walk` confirms the
 * same via its own `lstatIfPossible` call, which reports a
 * symlinked subdirectory's `IsDir()` as false so the recursive `walk` call returns without
 * descending. The `FileSystem` service exposes no non-following `lstat`; `fs.readLink`
 * succeeding on a path IS Effect's only non-following "is this a symlink" primitive, so it
 * stands in for that check at each level, both for recursion (a symlinked directory is skipped,
 * not walked) and for file inclusion (a symlinked `.sql` file is skipped, not applied) — using
 * `fs.stat` (which follows) here instead would silently include a symlink's target.
 * Deliberately never checks its OWN root (`dir`) for being a symlink — only entries it reads
 * FROM that root — so each caller layers on whichever of the two root-symlink behaviors its
 * own counterpart needs (`fs.WalkDir` follows a symlinked root; `afero.Walk` does not) on
 * top of this shared walk.
 *
 * Both walkers byte-sort every directory level (`os.ReadDir`/`io/fs.ReadDir`'s
 * `bytealg.CompareString`/`sort.Strings`, not just the final flattened result), so the
 * traversal order itself (which determines which
 * entry's read/stat error surfaces first when a walk aborts early) uses
 * {@link legacyCompareUtf8Bytes} too, not JS's default UTF-16-code-unit comparator (review:
 * PRRT_kwDOErm0O86XAlIo). They also both finish with a plain `sort.Strings` over the complete
 * set of collected paths — a full
 * lexicographic sort over full relative paths, NOT merely a per-directory-level sort (a
 * directory's own files can byte-sort AFTER a sibling's full path even though the directory
 * NAME sorts first, e.g. `"foo.sql" < "foo/bar.sql"` since `.` (`0x2E`) sorts before `/`
 * (`0x2F`)) — so the final sort below is required even though entries are already read in
 * sorted order at each level. Returns paths relative to `dir`.
 *
 * Hoisted here (from `legacy-migrate-and-seed.ts`, the first caller, for `db.migrations.
 * schema_paths`) once `legacy-seed.ts`'s `db.seed.sql_paths` resolution became a second
 * caller, and `legacy-shadow-source.ts`'s declared-schema walkers (a matched `schema_paths`
 * directory, or the `supabase/schemas`/pg-delta-declarative-dir fallbacks) became a third —
 * `Glob.SQLFiles` and `afero.Walk` are the SAME shape
 * (byte-sorted, no-follow, regular-`.sql`-file-filtered) every one of these config fields
 * resolves through, so a matched directory must expand to its sorted regular `.sql` files
 * identically regardless of which config field it came from.
 */
export const legacyWalkSqlFiles = (
  fs: FileSystem.FileSystem,
  dir: string,
  relativePrefix: string,
): Effect.Effect<ReadonlyArray<string>, PlatformError> =>
  Effect.gen(function* () {
    const names = [...(yield* fs.readDirectory(dir))].sort(legacyCompareUtf8Bytes);
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
      // `readDirectory` just listed (removed mid-walk, permission denied, I/O error) —
      // `fs.WalkDir` (`walkMatchedDir`) propagates that exact
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
    return files.sort(legacyCompareUtf8Bytes);
  });
