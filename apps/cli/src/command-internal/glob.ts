import { Effect, type FileSystem, type Path } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { pathMatch } from "./path-match.ts";

/**
 * Filesystem-matching primitives for glob-shaped config fields (e.g. `[db.seed] sql_paths`,
 * `[db.migrations] schema_paths`), resolving each pattern relative to the workdir unless it's
 * absolute.
 */

// `\` counts as a glob metacharacter alongside `*`, `?`, `[`, since it's the escape character
// {@link pathMatch} handles. Paths are normalized to `/` separators before this runs.
const hasGlobMeta = (pattern: string): boolean => /[*?[\\]/u.test(pattern);

// A bare Windows drive root like `C:` is not `path.isAbsolute` (Node requires the trailing
// separator), but it's already an absolute path component and must not be joined under the
// workdir.
const isWindowsDriveRoot = (p: string): boolean => /^[A-Za-z]:$/.test(p);

// Only a relative path resolves under the workdir; an absolute path stays absolute (`path.join`
// would otherwise collapse `/repo` + `/tmp/seed.sql` into `/repo/tmp/seed.sql`).
export const resolveUnderWorkdir = (path: Path.Path, workdir: string, p: string): string =>
  path.isAbsolute(p) || isWindowsDriveRoot(p) ? p : path.join(workdir, p);

/**
 * Resolves a single glob pattern against the workdir, returning matched paths relative to the
 * workdir. A literal pattern (no glob metacharacter) returns itself if it exists; a pattern with
 * metacharacters lists each parent directory and matches per segment via {@link pathMatch}. The
 * caller validates the whole pattern up front, so a malformed character class never reaches here.
 */
export const globPattern = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  pattern: string,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    // Normalize `\` to `/` before matching (POSIX already uses `/`) so a Windows path like
    // `schemas\foo.sql` isn't misread by `hasGlobMeta` as containing glob-escape syntax.
    const normalized = path.sep === "/" ? pattern : pattern.replaceAll("\\", "/");
    if (!hasGlobMeta(normalized)) {
      const exists = yield* fs
        .exists(resolveUnderWorkdir(path, workdir, normalized))
        .pipe(Effect.orElseSucceed(() => false));
      return exists ? [normalized] : [];
    }
    const slash = normalized.lastIndexOf("/");
    // A leading-slash-only pattern (e.g. `/*.sql`) keeps its directory as `/`, distinct from the
    // no-slash case where an empty directory means "resolve under workdir" — otherwise it would
    // glob the workdir instead of the filesystem root.
    const dirPattern = slash === -1 ? "" : slash === 0 ? "/" : normalized.slice(0, slash);
    const filePattern = slash === -1 ? normalized : normalized.slice(slash + 1);
    const dirs = hasGlobMeta(dirPattern)
      ? yield* globPattern(fs, path, workdir, dirPattern)
      : [dirPattern];
    const result: Array<string> = [];
    for (const dir of dirs) {
      const absDir = dir.length === 0 ? workdir : resolveUnderWorkdir(path, workdir, dir);
      const names = yield* fs.readDirectory(absDir).pipe(Effect.orElseSucceed(() => []));
      for (const name of names) {
        if (pathMatch(filePattern, name).matched) {
          // `dir` is already `/` for the root case above; appending `/${name}` the same way as
          // other `dir` values would double the separator.
          result.push(
            dir.length === 0 ? name : dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`,
          );
        }
      }
    }
    return result;
  });

/**
 * Byte-wise UTF-8 order, not JS's UTF-16 code-unit order; the two disagree for supplementary-plane
 * characters (encoded as surrogate pairs) relative to Basic Multilingual Plane private-use
 * characters, e.g. `["a\u{1F600}.sql","a.sql"].sort()` disagrees with a byte-wise compare.
 */
export function compareUtf8Bytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Recursively lists `.sql` files under `dir`, byte-sorted, skipping symlinked directories and
 * files. The `FileSystem` service exposes no non-following `lstat`, so a successful
 * `fs.readLink` stands in for "this entry is a symlink" at every level; `dir` itself is never
 * checked, so a symlinked root walks normally.
 *
 * Sorts every directory level and the final flattened list: a directory's own files can byte-sort
 * after a sibling's full path even though the directory name sorts first (e.g. `"foo.sql" <
 * "foo/bar.sql"`), so per-level order alone isn't enough. Returns paths relative to `dir`.
 */
export const walkSqlFiles = (
  fs: FileSystem.FileSystem,
  dir: string,
  relativePrefix: string,
): Effect.Effect<ReadonlyArray<string>, PlatformError> =>
  Effect.gen(function* () {
    const names = [...(yield* fs.readDirectory(dir))].sort(compareUtf8Bytes);
    const files: Array<string> = [];
    for (const name of names) {
      const absChild = `${dir}/${name}`;
      const relChild = relativePrefix.length === 0 ? name : `${relativePrefix}/${name}`;
      const isSymlink = yield* fs.readLink(absChild).pipe(
        Effect.map(() => true),
        Effect.orElseSucceed(() => false),
      );
      if (isSymlink) continue;
      // Unlike the `readLink` probe above (where failure just means "not a symlink"), a `stat`
      // failure here means something went wrong reading an entry `readDirectory` just listed;
      // propagate it rather than silently treating the entry as absent.
      const info = yield* fs.stat(absChild);
      if (info.type === "Directory") {
        files.push(...(yield* walkSqlFiles(fs, absChild, relChild)));
      } else if (info.type === "File" && relChild.endsWith(".sql")) {
        files.push(relChild);
      }
    }
    return files.sort(compareUtf8Bytes);
  });
