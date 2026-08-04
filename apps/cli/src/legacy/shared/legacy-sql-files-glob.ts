import { Effect, type FileSystem, type Path } from "effect";

import { LEGACY_BAD_PATTERN_MESSAGE, legacyPathMatch } from "./legacy-path-match.ts";

const META_CHARS = /[*?[\\]/u;

const toSlash = (p: string): string => p.replaceAll("\\", "/");

/** Splits a forward-slashed path into its directory prefix and final element. */
const splitPath = (p: string): { readonly dir: string; readonly file: string } => {
  const slash = p.lastIndexOf("/");
  return slash === -1 ? { dir: "", file: p } : { dir: p.slice(0, slash), file: p.slice(slash + 1) };
};

/** Faithful port of Go's `fs.Glob` for one pattern, rooted at `workdir`. */
const globOne = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  pattern: string,
): Effect.Effect<ReadonlyArray<string>, never> =>
  Effect.gen(function* () {
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
          result.push(d === "" ? name : `${d}/${name}`);
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
 */
const legacyWalkSqlFiles = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  dir: string,
): Effect.Effect<ReadonlyArray<string>, never> =>
  Effect.gen(function* () {
    const collected: Array<string> = [];
    const walk = (rel: string): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const absDir = path.isAbsolute(rel) ? rel : path.join(workdir, rel);
        const names = yield* fs
          .readDirectory(absDir)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
        for (const name of names) {
          const childRel = `${rel}/${name}`;
          const childType = yield* fs
            .stat(path.isAbsolute(childRel) ? childRel : path.join(workdir, childRel))
            .pipe(
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
   * Per-pattern problems (`no files matched pattern: …` / `failed to glob files: …`),
   * in pattern order. Never fatal by itself — callers decide when a warning matters
   * (e.g. the seed path always surfaces it; the schema-files apply path only surfaces
   * it when NO pattern matched anything at all, mirroring Go's `apply.go:53-55`).
   */
  readonly warnings: ReadonlyArray<string>;
}

/**
 * Resolves SQL-file glob patterns to existing files, porting Go's `config.Glob.SQLFiles`
 * over `fs.Glob` (`apps/cli-go/pkg/config/config.go:123-211`). Shared by `[db.seed].sql_paths`
 * (via `legacyGlobSeedFiles`, `legacy-seed-ops.ts`) and `[db.migrations].schema_paths` (via
 * `legacyApplySchemaFiles`, `legacy-migration-apply.ts`) — both Go fields resolve through the
 * exact same `Glob` type and `SQLFiles` method, so the traversal logic lives here once.
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
) {
  const seen = new Set<string>();
  const files: Array<string> = [];
  const warnings: Array<string> = [];

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
      warnings.push(`no files matched pattern: ${pattern}`);
      continue;
    }
    for (const match of [...matches].sort()) {
      const fp = toSlash(match);
      // A directory match is expanded to its regular `.sql` files recursively
      // (`walkMatchedDir`, sorted); a file match is kept verbatim (`config.go:157-183`).
      const matchType = yield* fs.stat(path.isAbsolute(fp) ? fp : path.join(workdir, fp)).pipe(
        Effect.map((info) => info.type),
        Effect.orElseSucceed(() => "File" as const),
      );
      if (matchType === "Directory") {
        for (const file of yield* legacyWalkSqlFiles(fs, path, workdir, fp)) {
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

  return { files, warnings } satisfies LegacySqlFilesGlobResult;
});
