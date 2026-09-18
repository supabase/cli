import { join } from "node:path";
import { Option } from "effect";

/**
 * Resolves the global Supabase CLI state root.
 *
 * `SUPABASE_HOME` overrides the location when set to a non-empty value after trimming
 * surrounding whitespace (an absolute path is expected; the value is used verbatim). Otherwise it
 * defaults to `<homeDir>/.supabase`. A pure function, so every caller resolves through it with
 * its own environment and home directory, keeping the contract in one place.
 */
export const resolveSupabaseHomeValue = (value: Option.Option<string>, homeDir: string): string => {
  const configured = Option.isSome(value) ? value.value.trim() : undefined;
  return configured !== undefined && configured.length > 0
    ? configured
    : join(homeDir, ".supabase");
};

export const resolveSupabaseHome = (
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
): string =>
  resolveSupabaseHomeValue(
    env["SUPABASE_HOME"] === undefined ? Option.none() : Option.some(env["SUPABASE_HOME"]),
    homeDir,
  );
