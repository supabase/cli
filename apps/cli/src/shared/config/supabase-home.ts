import { join } from "node:path";

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
 * All CLI callers resolve through this function, keeping the `SUPABASE_HOME`
 * contract in one place.
 */
export const resolveSupabaseHome = (
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
): string => {
  const configured = env["SUPABASE_HOME"]?.trim();
  return configured !== undefined && configured.length > 0
    ? configured
    : join(homeDir, ".supabase");
};
