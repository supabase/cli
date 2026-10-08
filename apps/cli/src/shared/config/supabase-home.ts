import { Effect, Option, type Path } from "effect";

import { envOption } from "./env-option.ts";

/**
 * Resolves the global Supabase CLI state root.
 *
 * `SUPABASE_HOME` overrides the location when set to a non-empty value after trimming
 * surrounding whitespace (an absolute path is expected; the value is used verbatim). Otherwise it
 * defaults to `<homeDir>/.supabase`. Callers resolve through it with their own
 * home directory, keeping the contract in one place.
 */
export const resolveSupabaseHomeValue = (
  path: Pick<Path.Path, "join">,
  value: Option.Option<string>,
  homeDir: string,
): string => {
  const configured = Option.isSome(value) ? value.value.trim() : undefined;
  return configured !== undefined && configured.length > 0
    ? configured
    : path.join(homeDir, ".supabase");
};

export const readSupabaseHome = (path: Pick<Path.Path, "join">, homeDir: string) =>
  envOption("SUPABASE_HOME").pipe(
    Effect.map((value) => resolveSupabaseHomeValue(path, value, homeDir)),
  );
