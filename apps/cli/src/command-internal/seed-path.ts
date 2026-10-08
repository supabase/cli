import type { Path } from "effect";

/**
 * Joins `pattern` under `supabase/`, collapsing `.`/`..` segments (e.g.
 * `../seed.sql` → `seed.sql`). The cleaned, forward-slash-only path is the
 * seed-tracking hash key, so an uncollapsed key would miss a previously
 * recorded entry and re-run the seed.
 */
function joinSupabaseSeedPath(pattern: string): string {
  const out: Array<string> = [];
  for (const segment of `supabase/${pattern}`.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
    } else {
      out.push(segment);
    }
  }
  return out.length === 0 ? "." : out.join("/");
}

/**
 * A bare leading separator (`/schemas`) has no Windows volume, so it's
 * relative and joins under `supabase/` — unlike Node's win32 `isAbsolute`,
 * which treats it as rooted at the current drive.
 */
const goIsAbs = (pathSvc: Path.Path, pattern: string): boolean => {
  if (process.platform !== "win32") {
    return pathSvc.isAbsolute(pattern);
  }
  const isSeparator = (c: string | undefined): boolean => c === "/" || c === "\\";
  // Drive-letter volume (`C:\`, `c:/`): `volumeNameLen` accepts any byte before
  // `:` (case 2, `path[1] === ':'`), then `IsAbs` requires a separator right after.
  if (pattern.length >= 3 && pattern[1] === ":" && isSeparator(pattern[2])) {
    return true;
  }
  // UNC volume (`\\server\share`, `//server/share`): `IsAbs` treats a
  // double-separator-prefixed volume as absolute unconditionally.
  return pattern.length >= 2 && isSeparator(pattern[0]) && isSeparator(pattern[1]);
};

/**
 * Resolves a single seed/schema-paths entry: a relative pattern is joined
 * under `supabase/`; an absolute (or empty) pattern is returned verbatim.
 * Used by the reader for `[db.seed].sql_paths` and
 * `[db.migrations].schema_paths`, and by `db reset` for its `--sql-paths`
 * override — all three feed the glob the same resolved paths.
 */
export const resolveSeedSqlPath = (pathSvc: Path.Path, pattern: string): string =>
  pattern.length === 0 || goIsAbs(pathSvc, pattern) ? pattern : joinSupabaseSeedPath(pattern);
