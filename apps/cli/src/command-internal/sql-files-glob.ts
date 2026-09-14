import { Effect, type FileSystem, type Path, Result } from "effect";

import { errorMessage, relativizeErrorMessage } from "./error-message.ts";
import { BAD_PATTERN_MESSAGE, pathMatch } from "./path-match.ts";

const META_CHARS = /[*?[\\]/u;

// Narrower than `META_CHARS` above (excludes `\`); only used to gate `skipEmptyGlobs` below.
const GLOB_META_CHARS = /[*?[]/u;

// Only Windows uses `\` as a path separator; everywhere else it's a `pathMatch` escape
// character (`foo\.sql`), and converting it unconditionally would corrupt that escape.
const toSlash = (p: string): string => (process.platform === "win32" ? p.replaceAll("\\", "/") : p);

// Byte-wise UTF-8 order, not JS's UTF-16 code-unit order; the two differ outside the BMP, and
// established sort output depends on byte-wise order.
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

// Delegates to the injected `Path.Path` service (backed by `node:path`) for a cleaned join,
// matching how both the glob-match and walked-child paths are built: a `.`/`..`/doubled-slash
// segment in the directory portion must resolve to the same clean path either way. For seeds,
// the result becomes the `supabase_migrations.seed_files.path` hash key, so a cleaning
// mismatch would cause a spurious re-run or mis-record.
const joinRelChild = (path: Path.Path, rel: string, name: string): string => path.join(rel, name);

/**
 * Splits a forward-slashed path into its directory prefix and final element.
 *
 * A bare root prefix stays `"/"`, never chopped to `""` — collapsing it would make
 * `globOne` treat an absolute root-level pattern as relative to the workdir instead of the
 * filesystem root. On Windows, a bare drive-root prefix (`"C:/"`) needs the same treatment:
 * chopping it to `"C:"` would make `path.isAbsolute` report `false` (a bare drive letter is
 * drive-relative, not absolute), so `globOne` would wrongly resolve it under the workdir.
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

/** Resolves one glob pattern to matching paths, rooted at `workdir`. */
const globOne = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  pattern: string,
): Effect.Effect<ReadonlyArray<string>, never> =>
  Effect.gen(function* () {
    // An empty pattern must yield no matches: `path.join(workdir, "")` resolves to `workdir`
    // itself, which would wrongly report the workdir as a match for an empty
    // `schema_paths`/`sql_paths` entry.
    if (pattern.length === 0) {
      return [];
    }
    // Absolute patterns resolve against the filesystem root; relative ones are
    // rooted at the workdir.
    const resolve = (p: string): string => (path.isAbsolute(p) ? p : path.join(workdir, p));
    // A literal pattern must match a broken symlink too (the link itself exists, even if its
    // target doesn't): `fs.exists` alone follows the symlink and would wrongly report no
    // match, so probe with `readLink` first (no-follow) and only fall back to `fs.exists` for
    // everything else. The later `fs.stat` in `sqlFilesGlob` is what fails on the dangling
    // target.
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
        if (pathMatch(file, name).matched) {
          // Not slashed here: the caller sorts these raw (possibly backslash-joined) matches
          // before converting to forward slash, and slashing here first would change the
          // byte-order sort result on Windows (`\` is `0x5C`, `/` is `0x2F`).
          result.push(joinRelChild(path, d, name));
        }
      }
    }
    return result;
  });

/**
 * Recursively collects the regular `.sql` files under a matched directory. Paths are
 * workdir-relative, forward-slashed, and sorted for deterministic application.
 *
 * A `readDirectory` failure anywhere in the tree fails the whole walk with `failed to walk
 * matched directory: <cause>`, discarding every file collected so far rather than returning
 * a partial list.
 */
const walkSqlFiles = (
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
        // The real read needs `absDir`, but the wrapped error must report the workdir-relative
        // `rel` (same substitution pattern used below and by `applySchemaFiles`'s read errors).
        const names = yield* fs
          .readDirectory(absDir)
          .pipe(
            Effect.mapError(
              (error) =>
                `failed to walk matched directory: ${relativizeErrorMessage(errorMessage(error), absDir, rel)}`,
            ),
          );
        // `readDirectory` gives raw OS enumeration order, not a sorted one, so sort explicitly
        // to keep error ordering and output deterministic across multiple problematic children.
        for (const name of [...names].sort(utf8Compare)) {
          const childRel = joinRelChild(path, rel, name);
          const childAbs = path.isAbsolute(childRel) ? childRel : path.join(workdir, childRel);
          // A symlinked file or subdirectory below the matched root is never included or
          // recursed into, regardless of its target; only the matched root itself may be a
          // symlink. `readLink` succeeds only for a symlink, used here as the no-follow probe.
          const isSymlink = yield* fs.readLink(childAbs).pipe(
            Effect.map(() => true),
            Effect.orElseSucceed(() => false),
          );
          if (isSymlink) {
            continue;
          }
          const statResult = yield* fs.stat(childAbs).pipe(Effect.result);
          if (Result.isFailure(statResult)) {
            // TOCTOU: this child existed in the `readDirectory` snapshot but vanished before
            // the stat above (e.g. a concurrent removal). Losing it here must not silently
            // drop the file and let the walk appear to succeed with nothing applied — include
            // it optimistically and let the real downstream read surface the failure.
            if (childRel.endsWith(".sql")) {
              collected.push(toSlash(childRel));
              continue;
            }
            // TOCTOU, directory variant: unlike the `.sql`-file case above, a vanished
            // non-`.sql` entry could have been a subdirectory, and its type can't be recovered
            // after the fact (a directory entry's type comes from the same syscall as the
            // listing; this `stat` is a separate one). Treat it as a potential directory and
            // fail the whole walk — never silently apply a partial schema/seed set.
            return yield* Effect.fail(
              `failed to walk matched directory: ${relativizeErrorMessage(errorMessage(statResult.failure), childAbs, childRel)}`,
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
interface SqlFilesGlobResult {
  /** Workdir-relative, forward-slashed matches, deduplicated in first-seen order across patterns. */
  readonly files: ReadonlyArray<string>;
  /**
   * Per-pattern/per-match problems (`no files matched pattern: …` / `failed to glob files:
   * …` / `failed to walk matched directory: …`), in pattern order. Never fatal by itself —
   * e.g. the seed path always surfaces it, while the schema-files apply path only surfaces
   * it when no pattern matched anything at all.
   */
  readonly warnings: ReadonlyArray<string>;
}

/**
 * Glob options used only by `db diff`'s declarative path; every other caller (schema-files
 * apply, both seed-path callers) passes none.
 */
export interface SqlFilesGlobOptions {
  /**
   * A pattern containing a glob metacharacter (`*`, `?`, `[`; not `\`) that matches nothing
   * is silently skipped — no "no files matched pattern" warning — unless
   * `errorOnAllSkipped` retroactively un-skips it. A literal pattern that doesn't exist
   * always warns, regardless of this flag.
   */
  readonly skipEmptyGlobs?: boolean;
  /**
   * Only meaningful with `skipEmptyGlobs`: if the overall result ends up empty and at
   * least one pattern was silently skipped, every skipped pattern's silence is turned
   * back into a "no files matched pattern" warning.
   */
  readonly errorOnAllSkipped?: boolean;
}

/**
 * Resolves SQL-file glob patterns to existing files, shared by `[db.seed].sql_paths` and
 * `[db.migrations].schema_paths` so the traversal logic lives in one place.
 *
 * Each pattern is matched and sorted independently (byte order), keeping cross-pattern
 * declaration order with first-seen dedup. A directory match expands recursively to its
 * regular `.sql` files; an empty or malformed pattern warns without stopping the loop.
 */
export const sqlFilesGlob = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  patterns: ReadonlyArray<string>,
  workdir: string,
  options?: SqlFilesGlobOptions,
) {
  const skipEmptyGlobs = options?.skipEmptyGlobs ?? false;
  const errorOnAllSkipped = options?.errorOnAllSkipped ?? false;
  const seen = new Set<string>();
  const files: Array<string> = [];
  const warnings: Array<string> = [];
  const skipped: Array<string> = [];

  for (const rawPattern of patterns) {
    // Warnings and the skipped-pattern list report the original `rawPattern`, not the
    // slashed form used for matching — on Windows, a backslash pattern (`C:\schemas\*.sql`)
    // must warn with that raw form.
    const pattern = toSlash(rawPattern);
    // A malformed glob is reported as `failed to glob files: ...` and contributes no
    // matches, rather than the misleading "no files matched" below.
    if (pathMatch(pattern, "").badPattern) {
      warnings.push(`failed to glob files: ${BAD_PATTERN_MESSAGE}`);
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
      // A directory match expands recursively to its regular `.sql` files; a file match is
      // kept verbatim. A match that disappears (or is a broken symlink) between the glob and
      // this stat becomes a warning and is skipped, rather than reaching the caller's later
      // read as a hard apply error.
      //
      // The real stat needs an absolute path, but the wrapped message must report the
      // relative `fp` (same substitution pattern as `applySchemaFiles`'s read errors).
      const absoluteFp = path.isAbsolute(fp) ? fp : path.join(workdir, fp);
      const statResult = yield* fs.stat(absoluteFp).pipe(Effect.result);
      if (Result.isFailure(statResult)) {
        const message = relativizeErrorMessage(errorMessage(statResult.failure), absoluteFp, fp);
        warnings.push(`failed to stat matched file: ${message}`);
        continue;
      }
      const matchType = statResult.success.type;
      if (matchType === "Directory") {
        // A walk failure on this match becomes a warning, like every other per-match/
        // per-pattern problem here, rather than a hard Effect failure — the loop continues.
        const walked = yield* walkSqlFiles(fs, path, workdir, fp).pipe(Effect.result);
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

  // Only escalate silently-skipped patterns back into warnings when nothing matched at all.
  if (errorOnAllSkipped && files.length === 0 && skipped.length > 0) {
    for (const pattern of skipped) {
      warnings.push(`no files matched pattern: ${pattern}`);
    }
  }

  return { files, warnings } satisfies SqlFilesGlobResult;
});
