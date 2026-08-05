import { Effect, type FileSystem, type Path, Result } from "effect";

import { legacyErrorMessage } from "./legacy-error-message.ts";
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
 */
const splitPath = (p: string): { readonly dir: string; readonly file: string } => {
  const slash = p.lastIndexOf("/");
  if (slash === -1) return { dir: "", file: p };
  return slash === 0
    ? { dir: "/", file: p.slice(1) }
    : { dir: p.slice(0, slash), file: p.slice(slash + 1) };
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
    // No metacharacters: a direct existence check (Go's `fs.Glob` fast path).
    if (!META_CHARS.test(pattern)) {
      const exists = yield* fs.exists(resolve(pattern)).pipe(Effect.orElseSucceed(() => false));
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
          // `d === "/"` is the filesystem root (from `splitPath`'s preserved root
          // prefix, above) — join without a doubled slash, matching Go's
          // `filepath.Join("/", name)`.
          result.push(d === "" ? name : d === "/" ? `/${name}` : `${d}/${name}`);
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
        const names = yield* fs
          .readDirectory(absDir)
          .pipe(
            Effect.mapError(
              (error) => `failed to walk matched directory: ${legacyErrorMessage(error)}`,
            ),
          );
        for (const name of names) {
          const childRel = `${rel}/${name}`;
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
          const childType = yield* fs.stat(childAbs).pipe(
            Effect.map((info) => info.type),
            Effect.orElseSucceed(() => "Unknown" as const),
          );
          if (childType === "Directory") {
            yield* walk(childRel);
          } else if (childType === "File" && childRel.endsWith(".sql")) {
            collected.push(toSlash(childRel));
          }
        }
      });
    yield* walk(dir);
    return collected.sort();
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
      if (skipEmptyGlobs && GLOB_META_CHARS.test(pattern)) {
        skipped.push(pattern);
      } else {
        warnings.push(`no files matched pattern: ${pattern}`);
      }
      continue;
    }
    for (const match of [...matches].sort()) {
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
      const statResult = yield* fs
        .stat(path.isAbsolute(fp) ? fp : path.join(workdir, fp))
        .pipe(Effect.result);
      if (Result.isFailure(statResult)) {
        warnings.push(`failed to stat matched file: ${legacyErrorMessage(statResult.failure)}`);
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
