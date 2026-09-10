import { join } from "node:path";

/**
 * Resolves the global Supabase CLI state root.
 *
 * `SUPABASE_HOME` overrides the location when set to a non-empty value after trimming
 * surrounding whitespace (an absolute path is expected; the value is used verbatim). Otherwise it
 * defaults to `<homeDir>/.supabase`. A pure function, so every caller resolves through it with
 * its own environment and home directory, keeping the contract in one place.
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
