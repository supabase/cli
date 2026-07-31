import { Effect, type FileSystem, type Path } from "effect";

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

// Go globs/reads glob-config paths through an OS-root-rooted `afero.NewOsFs`, where the
// CLI's "workdir" is just `os.Chdir(workdir)` (`internal/utils/misc.go`) — which only
// affects RELATIVE paths. An absolute glob-config entry, preserved verbatim by the config
// loader (`pkg/config/config.go`, gated on `!filepath.IsAbs`), therefore resolves at the OS
// root, never under the workdir. Mirror that: only join under the workdir when the path is
// relative (`path.join` would otherwise collapse `/repo` + `/tmp/seed.sql` to
// `/repo/tmp/seed.sql`).
export const legacyResolveUnderWorkdir = (path: Path.Path, workdir: string, p: string): string =>
  path.isAbsolute(p) ? p : path.join(workdir, p);

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
    if (!legacyHasGlobMeta(pattern)) {
      const exists = yield* fs
        .exists(legacyResolveUnderWorkdir(path, workdir, pattern))
        .pipe(Effect.orElseSucceed(() => false));
      return exists ? [pattern] : [];
    }
    const slash = pattern.lastIndexOf("/");
    const dirPattern = slash === -1 ? "" : pattern.slice(0, slash);
    const filePattern = slash === -1 ? pattern : pattern.slice(slash + 1);
    const dirs = legacyHasGlobMeta(dirPattern)
      ? yield* legacyGlobPattern(fs, path, workdir, dirPattern)
      : [dirPattern];
    const result: Array<string> = [];
    for (const dir of dirs) {
      const absDir = dir.length === 0 ? workdir : legacyResolveUnderWorkdir(path, workdir, dir);
      const names = yield* fs.readDirectory(absDir).pipe(Effect.orElseSucceed(() => []));
      for (const name of names) {
        if (legacyPathMatch(filePattern, name).matched) {
          result.push(dir.length === 0 ? name : `${dir}/${name}`);
        }
      }
    }
    return result;
  });
