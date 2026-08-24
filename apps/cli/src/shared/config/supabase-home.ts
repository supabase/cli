import { Path } from "effect";

/**
 * Resolves the global Supabase CLI state root.
 *
 * `SUPABASE_HOME` overrides the location when set to a non-empty value after
 * trimming surrounding whitespace (an absolute path is expected; the value is
 * used verbatim). Otherwise it defaults to `<homeDir>/.supabase`.
 *
 * This is the single source of truth for the `SUPABASE_HOME` contract in the
 * TypeScript CLI. It is a pure function: callers pass their own environment and
 * home directory so it stays trivially testable and free of global state. The
 * legacy and next shells both resolve through it, and every CLI call into
 * `@supabase/stack` passes the root resolved here explicitly, so this stays the
 * authoritative resolution for anything the CLI drives. Library-side fallbacks
 * do exist for non-CLI embedders — the managed layer's `resolveManagedStateRoot`
 * reads `SUPABASE_HOME` itself when no root is supplied (CLI-2106) — but the
 * CLI never relies on them.
 */
export const resolveSupabaseHome = (
  path: Path.Path,
  configuredHome: string | undefined,
  homeDir: string,
): string => {
  const configured = configuredHome?.trim();
  return configured !== undefined && configured.length > 0
    ? configured
    : path.join(homeDir, ".supabase");
};
