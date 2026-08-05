import { Effect, type FileSystem, type Path, Result } from "effect";

import { legacyErrorMessage, legacyRelativizeErrorMessage } from "./legacy-error-message.ts";
import { LEGACY_BAD_PATTERN_MESSAGE, legacyPathMatch } from "./legacy-path-match.ts";

const META_CHARS = /[*?[\\]/u;

// Go's `config.hasGlobMeta` (`apps/cli-go/pkg/config/config.go:211-213`) — a DIFFERENT,
// narrower set than `META_CHARS` above (which mirrors `io/fs.hasMeta`'s `path.Match`
// escape handling and includes `\`). Only used to gate `WithSkipEmptyGlobs()` below.
const GLOB_META_CHARS = /[*?[]/u;

// Go's `filepath.ToSlash` replaces `os.PathSeparator` with `/` — a no-op on the
// non-Windows platforms this shell mostly runs on, since their separator already IS
// `/`. Gating on `win32` (rather than converting unconditionally) matters: on
// non-Windows a `\` in a pattern is never a path separator, only a `path.Match`
// escape (`foo\.sql`, `seed\*.sql`), and unconditionally slashing it would corrupt
// that escape — see `legacyPathMatch`'s escape handling below.
const toSlash = (p: string): string => (process.platform === "win32" ? p.replaceAll("\\", "/") : p);

// Go's `sort.Strings` (used by both `Glob.SQLFiles`, `config.go:155`, and
// `walkMatchedDir`, `config.go:207`) orders strings by their raw UTF-8 BYTES —
// Go strings are just byte slices, so `strings.Compare` never decodes runes. JS's
// default `Array.prototype.sort()` instead compares UTF-16 CODE UNITS, which
// disagrees with UTF-8 byte order for any character outside the Basic Multilingual
// Plane: a supplementary-plane code point (`U+10000`+, a UTF-16 surrogate PAIR
// starting `0xD800`-`0xDBFF`) always UTF-8-encodes to 4 bytes leading `0xF0`-`0xF4`,
// while every 3-byte-encoded BMP character (`U+0800`-`U+FFFF`, UTF-8 lead byte
// `0xE0`-`0xEF`) is numerically SMALLER as a lead byte but can have a LARGER lone
// UTF-16 code unit than the surrogate pair's lead unit — so the two orderings can
// disagree. Verified empirically: sorting a 4-byte emoji filename against a
// 3-byte fullwidth-exclamation filename, Go's `sort.Strings` places the fullwidth
// exclamation FIRST, while JS's default `.sort()` places the emoji first.
const UTF8_ENCODER = new TextEncoder();
const utf8Compare = (a: string, b: string): number => {
  const bytesA = UTF8_ENCODER.encode(a);
  const bytesB = UTF8_ENCODER.encode(b);
  const len = Math.min(bytesA.length, bytesB.length);
  for (let i = 0; i < len; i++) {
    const diff = bytesA[i]! - bytesB[i]!;
    if (diff !== 0) return diff;
  }
  return bytesA.length - bytesB.length;
};

// Joins a matched directory (or glob-split directory prefix) with a child/entry name,
// delegating to the injected `Path.Path` service for Go's `path.Join`-equivalent
// cleaning. Two Go call sites build a path exactly this way, and both need the same
// cleaning:
//
//   - Direct glob-match construction (`globOne`, below): the real runtime glob path —
//     `config.Glob.SQLFiles`'s `fs.Glob(fsys, pattern)` call (`apps/cli-go/pkg/config/
//     config.go:145`) resolves to `afero.IOFS.Glob` (it implements `fs.GlobFS`), which
//     delegates to `afero.Glob` (`github.com/spf13/afero@v1.15.0/iofs.go:56-65`). Its
//     `glob()` helper appends each match as `filepath.Join(dir, n)`
//     (`match.go:99`), so a glob whose directory portion has a cleanable segment
//     (`/tmp/./schemas/*.sql`, `/tmp/x/../schemas/*.sql`, a doubled `/tmp/schemas//*.sql`)
//     still records the CLEANED path, not a raw concatenation. Verified empirically: a
//     scratch `afero.Glob` probe against all three shapes above returns
//     `.../tmp/schemas/a.sql` in every case.
//   - Walked-child construction (`legacyWalkSqlFiles`, below): Go's `fs.WalkDir` builds
//     each child path via `path.Join(dirname, name)` (`io/fs/walk.go`).
//
// `path.Join`/`filepath.Join` both run Clean on the joined result — collapsing doubled
// slashes, dropping a bare `.` root, and lexically resolving `.`/`..` segments anywhere
// else in the path. Node's `path.join` (via this module's injected `Path.Path` service,
// backed by `node:path`) runs the same POSIX lexical-cleaning algorithm and was verified
// empirically to match byte-for-byte across every case either call site can hit —
// dot-root, trailing slash, embedded `.`/`..`, and doubled slashes:
//
//   Go:   path.Join(".", "foo.sql")                    = "foo.sql"
//         filepath.Join("/tmp/schemas/", "a.sql")       = "/tmp/schemas/a.sql"
//         filepath.Join("/tmp/./schemas", "a.sql")      = "/tmp/schemas/a.sql"
//         filepath.Join("/tmp/x/../schemas", "a.sql")   = "/tmp/schemas/a.sql"
//         path.Join("..", "foo.sql")                    = "../foo.sql"
//   Node: path.join(".", "foo.sql")                     = "foo.sql"
//         path.join("/tmp/schemas/", "a.sql")           = "/tmp/schemas/a.sql"
//         path.join("/tmp/./schemas", "a.sql")          = "/tmp/schemas/a.sql"
//         path.join("/tmp/x/../schemas", "a.sql")       = "/tmp/schemas/a.sql"
//         path.join("..", "foo.sql")                    = "../foo.sql"
//
// For seeds, the resulting path becomes the `supabase_migrations.seed_files.path` hash
// key, so any of these cleaning differences would make a TS-resolved path fail to match
// an already-recorded Go-CLI key and re-run/re-record the seed; for schema files it
// changes what path is suggested on an apply failure.
const joinRelChild = (path: Path.Path, rel: string, name: string): string => path.join(rel, name);

/**
 * Splits a forward-slashed path into its directory prefix and final element.
 *
 * A bare root prefix is kept as `"/"`, never chopped to `""`. This mirrors
 * the real runtime glob path — `config.Glob.SQLFiles`'s `fs.Glob` call
 * resolves to `afero.IOFS.Glob` (it implements `fs.GlobFS`), which delegates
 * to `afero.Glob`/`match.go`'s `filepath.Split` followed by a switch on
 * `dir` that leaves a bare `filepath.Separator` alone — every OTHER trailing
 * separator is chopped, but the root one is deliberately preserved. Verified
 * empirically against `apps/cli-go`: with cwd elsewhere, a pattern rooted at
 * `/`, with a metacharacter in the FIRST component after the root slash
 * (e.g. `tmp` + wildcard + `probe-dir` + wildcard + `.sql`), still resolves
 * that first component against the filesystem ROOT, not cwd. Collapsing this
 * to `dir: ""` would make `globOne` below treat such an absolute root-level
 * pattern as relative to the workdir instead of the filesystem root.
 *
 * On Windows, a bare drive-root prefix (`"C:/"`) needs the exact same
 * preservation, for the same reason but a different mechanism: Go's
 * `filepath.Split` treats `"C:"` as the volume name (`volumeNameLen`,
 * `internal/filepathlite/path_windows.go`) and always keeps the following
 * separator attached to `dir` — verified against that source directly, since
 * there is no Windows machine available to run the compiled stdlib on:
 * `Split("C:/*.sql")` returns `dir: "C:/"`, not `dir: "C:"`. Chopping the
 * separator here would matter downstream: Node's `path.isAbsolute("C:")` is
 * `false` (a bare drive letter is a *drive-relative* path in Windows
 * semantics, not absolute), so `globOne`'s `resolve()` would wrongly `join`
 * it under the workdir instead of resolving the real drive root, while
 * `path.isAbsolute("C:/")` is `true`.
 */
const splitPath = (p: string): { readonly dir: string; readonly file: string } => {
  const slash = p.lastIndexOf("/");
  if (slash === -1) return { dir: "", file: p };
  if (slash === 0) return { dir: "/", file: p.slice(1) };
  if (process.platform === "win32" && slash === 2 && p.charAt(1) === ":") {
    return { dir: p.slice(0, 3), file: p.slice(3) };
  }
  return { dir: p.slice(0, slash), file: p.slice(slash + 1) };
};

/** Faithful port of Go's `fs.Glob` for one pattern, rooted at `workdir`. */
const globOne = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  pattern: string,
): Effect.Effect<ReadonlyArray<string>, never> =>
  Effect.gen(function* () {
    // Go's `fs.Glob`/`afero.Glob` resolve a literal (no-metacharacter) pattern via
    // `Lstat`, which errors on an empty path — so `""` always yields no matches. An
    // unguarded `path.join(workdir, "")` resolves to `workdir` itself, which would
    // wrongly report the workdir as a match for an empty `schema_paths`/`sql_paths`
    // entry (e.g. `schema_paths = [""]`).
    if (pattern.length === 0) {
      return [];
    }
    // Absolute patterns resolve against the filesystem root; relative ones are
    // rooted at the workdir.
    const resolve = (p: string): string => (path.isAbsolute(p) ? p : path.join(workdir, p));
    // No metacharacters: Go's `fs.Glob`/`afero.Glob` fast path (`match.go:34-40`) probes
    // via `Lstat` (`OsFs.LstatIfPossible` → `os.Lstat`, verified empirically against
    // `afero@v1.15.0`), which does NOT follow a symlink — so a literal pattern naming a
    // BROKEN symlink still Lstat-succeeds (the link itself exists) and is reported as a
    // match; the follow-up `fs.Stat(fsys, fp)` in `legacySqlFilesGlob` below (which DOES
    // follow it) is what fails, with `failed to stat matched file: ...`. `fs.exists` here
    // is Effect's `access`-based check (Node's `fs.access`), which follows the symlink
    // like a normal `Stat` and would wrongly report "no files matched pattern" instead —
    // verified empirically: `fs.access` on a broken symlink resolves ENOENT while
    // `fs.lstat` on the same path succeeds. Probe for the entry itself the same
    // no-follow way `legacyWalkSqlFiles` below already does for a walked child: `readLink`
    // succeeds only for a symlink (broken or not), so treat that as an Lstat success
    // before falling back to the normal existence check for everything else.
    if (!META_CHARS.test(pattern)) {
      const resolved = resolve(pattern);
      const isSymlink = yield* fs.readLink(resolved).pipe(
        Effect.map(() => true),
        Effect.orElseSucceed(() => false),
      );
      const exists =
        isSymlink || (yield* fs.exists(resolved).pipe(Effect.orElseSucceed(() => false)));
      return exists ? [pattern] : [];
    }
    const { dir, file } = splitPath(pattern);
    // Resolve the directory level first (recursively if it, too, is a glob).
    const dirs =
      dir === "" || !META_CHARS.test(dir) ? [dir] : yield* globOne(fs, path, workdir, dir);
    const result: Array<string> = [];
    for (const d of dirs) {
      const absDir = d === "" ? workdir : resolve(d);
      const names = yield* fs
        .readDirectory(absDir)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const name of names) {
        if (legacyPathMatch(file, name).matched) {
          // `joinRelChild` (above) is the same Path-service clean-join the walked-child
          // path below uses — see its comment for why a raw `${d}/${name}` concatenation
          // isn't enough here (Go's `afero.Glob` cleans via `filepath.Join(dir, n)`, so
          // `d === "/"`, `d === ""`, and a `dir` containing `.`/`..`/doubled-slash
          // segments must all clean the same way as the walked-child case does).
          //
          // Deliberately NOT `toSlash`'d here, on Windows: Go's `config.Glob.SQLFiles`
          // sorts the RAW backslash-joined matches from `fs.Glob`/`afero.Glob` (built via
          // `filepath.Join`, `config.go:145-155`) and only converts each surviving match
          // to forward slash AFTER that sort (`fp := filepath.ToSlash(item)`,
          // `config.go:156`). This function's own caller (`legacySqlFilesGlob`) already
          // sorts the array `globOne` returns and slashes each item only after — slashing
          // here too would sort forward-slash-joined strings instead of the raw
          // backslash-joined ones, which can disagree: comparing `a\x.sql` vs `a0\x.sql`
          // byte-for-byte puts `a0\x.sql` first (`\` is `0x5C`, greater than `0`'s
          // `0x30`), while `a/x.sql` vs `a0/x.sql` puts `a/x.sql` first (`/` is `0x2F`,
          // less than `0x30`) — a different order for the same two matches.
          result.push(joinRelChild(path, d, name));
        }
      }
    }
    return result;
  });

/**
 * Recursively collects the regular `.sql` files under a matched directory, porting
 * Go's `walkMatchedDir` with the `SQLFiles` include filter (`entry.Type().IsRegular() &&
 * filepath.Ext(path) == ".sql"`, `apps/cli-go/pkg/config/config.go:126-131,194-211`).
 * Paths are workdir-relative (matching the glob output), forward-slashed, and sorted
 * for deterministic application.
 *
 * A `ReadDir` failure anywhere in the tree (e.g. a permissions error on a nested
 * directory) fails the WHOLE walk with `failed to walk matched directory: <cause>`,
 * discarding every file collected so far — Go's `fs.WalkDir` callback returns that
 * `err` unchanged, which stops the traversal immediately and makes `walkMatchedDir`
 * return `(nil, err)` rather than the partial list (`config.go:196-208`; verified
 * empirically: an unreadable matched directory makes `Glob.SQLFiles` return a
 * `failed to walk matched directory: ...` error with zero files, not an empty match).
 */
const legacyWalkSqlFiles = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  dir: string,
): Effect.Effect<ReadonlyArray<string>, string> =>
  Effect.gen(function* () {
    const collected: Array<string> = [];
    const walk = (rel: string): Effect.Effect<void, string> =>
      Effect.gen(function* () {
        const absDir = path.isAbsolute(rel) ? rel : path.join(workdir, rel);
        // Go's `fs.WalkDir` runs against `afero.OsFs` with the process cwd already the
        // workdir (`ChangeWorkDir`, `cmd/root.go`), so a `ReadDir` failure — on the
        // matched root `dir` itself, or on any nested directory the walk descends into —
        // embeds the workdir-relative `rel` in its error text, never an absolute path.
        // This module never `process.chdir`s, so the real read needs `absDir`, but the
        // wrapped warning must still report `rel` (same substitution pattern as the
        // matched-file stat failure below and `legacyApplySchemaFiles`'s read errors).
        const names = yield* fs
          .readDirectory(absDir)
          .pipe(
            Effect.mapError(
              (error) =>
                `failed to walk matched directory: ${legacyRelativizeErrorMessage(legacyErrorMessage(error), absDir, rel)}`,
            ),
          );
        for (const name of names) {
          const childRel = joinRelChild(path, rel, name);
          const childAbs = path.isAbsolute(childRel) ? childRel : path.join(workdir, childRel);
          // Go's `fs.WalkDir` types each child from the parent's `ReadDir` entry
          // (`os.ReadDir`'s Lstat-based `DirEntry`) and never re-`Stat`s through it —
          // so a symlinked file or subdirectory found below the matched root is
          // neither included nor recursed into, regardless of what it points to
          // (`io/fs/walk.go:114-115`: only the matched root itself, resolved once by
          // the caller before reaching this walk, may be a symlink). `readLink`
          // succeeds only for symlinks, so use it as the no-follow probe in place of
          // the `Lstat` this FileSystem service doesn't expose.
          const isSymlink = yield* fs.readLink(childAbs).pipe(
            Effect.map(() => true),
            Effect.orElseSucceed(() => false),
          );
          if (isSymlink) {
            continue;
          }
          const statResult = yield* fs.stat(childAbs).pipe(Effect.result);
          if (Result.isFailure(statResult)) {
            // TOCTOU: this child existed a moment ago in `names` (this directory's
            // `readDirectory` snapshot) but is gone by the time we stat it here — e.g. removed
            // by a concurrent process. Go never hits this window for the child's TYPE: `fs.WalkDir`
            // decides file-vs-directory from the SAME `DirEntry` its parent `ReadDir` already
            // returned and never re-`Stat`s a child, so a `.sql` file that disappears here
            // stays in Go's declared file list, and only the later, real file-open fails
            // loudly. Verified empirically: a scratch `filepath.WalkDir` probe that deletes a
            // sibling `.sql` file between `ReadDir` and that file's own visit still reports
            // it `IsRegular` from the cached entry, keeps it in `declared`, and the
            // subsequent `os.Open` on it fails with "no such file or directory" — never a
            // silent drop. Losing the stat here must not silently drop the file and let the
            // walk "succeed" having applied nothing — best-effort include it, matching Go's
            // outcome, and let the real downstream read surface the failure.
            if (childRel.endsWith(".sql")) {
              collected.push(toSlash(childRel));
              continue;
            }
            // TOCTOU, directory variant: the vanished entry could equally have been a
            // SUBDIRECTORY of the matched tree, not a harmless non-`.sql` file — and Go's
            // outcome for those two cases is NOT the same. For a directory `DirEntry`,
            // `fs.WalkDir` unconditionally attempts a second `ReadDir` to recurse into it
            // (`io/fs/walk.go`'s `walkDir`); when the child has since been removed, that
            // second `ReadDir` fails, and `walkMatchedDir`'s callback propagates the error
            // unchanged (`if err != nil { return err }`, `config.go:198-199`) — `fs.WalkDir`
            // returns it, and `walkMatchedDir` wraps it as `failed to walk matched
            // directory: <cause>`, discarding every file already collected
            // (`config.go:205-206`). Verified empirically: a scratch `fs.WalkDir` probe that
            // removes a nested subdirectory between the parent's `ReadDir` and the
            // subdirectory's own `ReadDir` reproduces exactly this — zero files, error
            // `failed to walk matched directory: open .../nested: no such file or
            // directory` — never a silent skip, unlike the vanished-`.sql`-file case above
            // (round 6). This FileSystem service can't recover the lost entry's type after
            // the fact — Go's `DirEntry` type came for free from the same `ReadDir` syscall
            // as the listing, whereas this port's `stat` is a second, separate syscall, so a
            // raced disappearance here always loses the type along with the entry. Treat any
            // non-`.sql` disappearance as a potential directory and fail the whole walk the
            // same way an unreadable still-present directory does (the `readDirectory`
            // failure above) — matching Go's fail-loud design intent (never silently apply a
            // partial schema/seed set) rather than risk silently dropping an entire nested
            // subtree of schema files. This `stat` stands in for the second `ReadDir` Go
            // itself would issue on the vanished directory, so its display path needs the
            // same absolute-to-relative substitution as the `readDirectory` failure above —
            // `childAbs` is what the real (stand-in) syscall needed, `childRel` is what Go's
            // own `ReadDir` error would embed.
            return yield* Effect.fail(
              `failed to walk matched directory: ${legacyRelativizeErrorMessage(legacyErrorMessage(statResult.failure), childAbs, childRel)}`,
            );
          }
          const childType = statResult.success.type;
          if (childType === "Directory") {
            yield* walk(childRel);
          } else if (childType === "File" && childRel.endsWith(".sql")) {
            collected.push(toSlash(childRel));
          }
        }
      });
    yield* walk(dir);
    return collected.sort(utf8Compare);
  });

/** Result of resolving SQL-file glob patterns against the workspace. */
interface LegacySqlFilesGlobResult {
  /** Workdir-relative, forward-slashed matches, deduplicated in first-seen order across patterns. */
  readonly files: ReadonlyArray<string>;
  /**
   * Per-pattern/per-match problems (`no files matched pattern: …` / `failed to glob
   * files: …` / `failed to walk matched directory: …`), in pattern order. Never fatal
   * by itself — callers decide when a warning matters
   * (e.g. the seed path always surfaces it; the schema-files apply path only surfaces
   * it when NO pattern matched anything at all, mirroring Go's `apply.go:53-55`).
   */
  readonly warnings: ReadonlyArray<string>;
}

/**
 * Mirrors Go's `GlobOption`s (`apps/cli-go/pkg/config/config.go:100-117`). Neither
 * caller in this shared module needs them today (`legacyApplySchemaFiles`'s
 * `[db.migrations].schema_paths`, and the two `[db.seed].sql_paths` callers —
 * `legacyGetPendingSeeds` and `legacy-seed.ts`'s `resolveSeedFiles` — all pass none,
 * matching Go's own zero-option call sites, `pkg/migration/seed.go:35` and
 * `internal/migration/apply/apply.go:52`). Added for `db diff`'s declarative path,
 * which calls `Glob.files` `WithSkipEmptyGlobs()` + `WithErrorOnAllSkippedGlobs()`.
 */
export interface LegacySqlFilesGlobOptions {
  /**
   * Go's `WithSkipEmptyGlobs()`: a pattern that contains a glob metacharacter
   * (`config.hasGlobMeta` — `*`, `?`, `[`; NOT `\`, unlike `META_CHARS` above) and
   * matches nothing is silently skipped — no "no files matched pattern" warning —
   * unless `errorOnAllSkipped` retroactively un-skips it (below). A LITERAL pattern
   * (no glob metacharacter) that doesn't exist always warns, regardless of this flag.
   */
  readonly skipEmptyGlobs?: boolean;
  /**
   * Go's `WithErrorOnAllSkippedGlobs()`: only meaningful together with
   * `skipEmptyGlobs`. If the overall result ends up empty AND at least one pattern
   * was silently skipped, every skipped pattern's silence is retroactively turned
   * back into a "no files matched pattern" warning — so a `skipEmptyGlobs` caller
   * can still detect the "nothing matched anything" case.
   */
  readonly errorOnAllSkipped?: boolean;
}

/**
 * Resolves SQL-file glob patterns to existing files, porting Go's `config.Glob.SQLFiles`
 * over `fs.Glob` (`apps/cli-go/pkg/config/config.go:123-211`). Shared by
 * `[db.seed].sql_paths` (via `legacyGetPendingSeeds`, `legacy-seed-ops.ts`, and
 * `legacy-seed.ts`'s `resolveSeedFiles`) and `[db.migrations].schema_paths` (via
 * `legacyApplySchemaFiles`, `legacy-migration-apply.ts`) — all three Go call sites
 * resolve through the exact same `Glob` type and `SQLFiles` method, so the traversal
 * logic lives here once.
 *
 * Each pattern is matched independently: matches are sorted per-pattern (Go's
 * `sort.Strings`, `config.go:155`), but the overall result preserves cross-pattern
 * DECLARATION order (no global re-sort), with first-seen dedup. A directory match is
 * expanded to its regular `.sql` files, recursively, sorted by full path
 * (`walkMatchedDir`); a non-directory match is kept verbatim regardless of extension. A
 * pattern that matches nothing, or is malformed (Go's `path.ErrBadPattern`, e.g. an
 * unterminated `[` class), contributes a warning but does not stop the loop — mirroring
 * `fs.Glob`'s up-front `Match(pattern, "")` validation (`io/fs/glob.go`).
 *
 * Patterns are assumed already resolved to Go's config-load form (a relative entry
 * `supabase/`-joined, an absolute entry verbatim) — callers resolve that once at
 * config-read time (`legacyResolveSeedSqlPath`), matching Go's `config.resolve` step,
 * which runs once at config load, before any glob.
 */
export const legacySqlFilesGlob = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  patterns: ReadonlyArray<string>,
  workdir: string,
  options?: LegacySqlFilesGlobOptions,
) {
  const skipEmptyGlobs = options?.skipEmptyGlobs ?? false;
  const errorOnAllSkipped = options?.errorOnAllSkipped ?? false;
  const seen = new Set<string>();
  const files: Array<string> = [];
  const warnings: Array<string> = [];
  const skipped: Array<string> = [];

  for (const rawPattern of patterns) {
    // Go's `filepath.ToSlash(pattern)` (`config.go:145`) is passed only as an ARGUMENT
    // to `fs.Glob` — the loop's own `pattern` variable (Go's range variable) is never
    // reassigned, so every later reference to it in THIS iteration (`hasGlobMeta`, the
    // skipped-pattern list, and the "no files matched pattern" warning, all below)
    // still reports the ORIGINAL, un-slashed pattern. On Windows, an absolute pattern
    // with backslashes (`C:\schemas\*.sql`) must therefore warn with that raw backslash
    // form, even though matching itself runs against the slashed form.
    const pattern = toSlash(rawPattern);
    // Go's `fs.Glob` validates the whole pattern up front (`Match(pattern, "")`); a
    // malformed glob is reported as `failed to glob files: <ErrBadPattern>` and
    // contributes no matches, rather than the misleading "no files matched" below.
    if (legacyPathMatch(pattern, "").badPattern) {
      warnings.push(`failed to glob files: ${LEGACY_BAD_PATTERN_MESSAGE}`);
      continue;
    }
    const matches = yield* globOne(fs, path, workdir, pattern);
    if (matches.length === 0) {
      if (skipEmptyGlobs && GLOB_META_CHARS.test(rawPattern)) {
        skipped.push(rawPattern);
      } else {
        warnings.push(`no files matched pattern: ${rawPattern}`);
      }
      continue;
    }
    for (const match of [...matches].sort(utf8Compare)) {
      const fp = toSlash(match);
      // A directory match is expanded to its regular `.sql` files recursively
      // (`walkMatchedDir`, sorted); a file match is kept verbatim (`config.go:157-183`).
      // Go: `if err != nil { allErrors = append(allErrors, errors.Errorf("failed to
      // stat matched file: %w", err)); continue }` (`config.go:157-161`) — a match
      // that disappears (or is a broken symlink) between the glob and this stat
      // becomes a warning and is skipped, same as a walk failure below. Falling back
      // to treating it as a regular file (the previous behaviour here) would instead
      // hand a nonexistent path to the caller's later read, turning a warned-but-
      // otherwise-successful reset into a hard apply error.
      //
      // Go's `fs.Stat(fsys, fp)` (`config.go:157`) runs with its process cwd already
      // the workdir (`ChangeWorkDir`, `cmd/root.go`), so `fp` IS the exact string the
      // real syscall sees and the resulting error's path is that workdir-relative
      // `fp`. This module never `process.chdir`s, so the real stat needs an absolute
      // path here — but the wrapped message must still report the relative `fp`, not
      // the absolute path used to make the syscall work. Same substitution pattern as
      // `legacyApplySchemaFiles`'s read-error display path (`legacy-migration-apply.ts`).
      const absoluteFp = path.isAbsolute(fp) ? fp : path.join(workdir, fp);
      const statResult = yield* fs.stat(absoluteFp).pipe(Effect.result);
      if (Result.isFailure(statResult)) {
        const message = legacyRelativizeErrorMessage(
          legacyErrorMessage(statResult.failure),
          absoluteFp,
          fp,
        );
        warnings.push(`failed to stat matched file: ${message}`);
        continue;
      }
      const matchType = statResult.success.type;
      if (matchType === "Directory") {
        // Go: `if err != nil { allErrors = append(allErrors, err); continue }` — a walk
        // failure on this match becomes a warning (never a hard Effect failure, like
        // every other per-match/per-pattern problem here) and the loop moves on to the
        // next match, exactly like a malformed pattern or a "no files matched" miss.
        const walked = yield* legacyWalkSqlFiles(fs, path, workdir, fp).pipe(Effect.result);
        if (Result.isFailure(walked)) {
          warnings.push(walked.failure);
          continue;
        }
        for (const file of walked.success) {
          if (!seen.has(file)) {
            seen.add(file);
            files.push(file);
          }
        }
        continue;
      }
      if (!seen.has(fp)) {
        seen.add(fp);
        files.push(fp);
      }
    }
  }

  // Go: `if opts.errorOnAllSkipped && len(result) == 0 && len(skipped) > 0` — only
  // escalate silently-skipped patterns back into warnings when NOTHING matched at all.
  if (errorOnAllSkipped && files.length === 0 && skipped.length > 0) {
    for (const pattern of skipped) {
      warnings.push(`no files matched pattern: ${pattern}`);
    }
  }

  return { files, warnings } satisfies LegacySqlFilesGlobResult;
});
