/**
 * Any global flag `--foo-bar` falls back to the `SUPABASE_FOO_BAR` env var
 * when the flag is absent: `1/t/T/TRUE/true/True` parses as true,
 * `0/f/F/FALSE/false/False` as false, and any other value (`yes`, `on`,
 * empty, garbage) as false. Effect CLI's flag parser carries no env binding,
 * so callers OR the parsed flag value with this read (flag-set wins).
 */

const VIPER_TRUE = new Set(["1", "t", "T", "TRUE", "true", "True"]);

/** Truthiness for an already-resolved env value (see module doc). */
function viperBool(raw: string | undefined): boolean {
  return raw !== undefined && VIPER_TRUE.has(raw);
}

/** Reads a single `SUPABASE_*` boolean env var from `process.env` (see module doc). */
export function viperEnvBool(name: string): boolean {
  return viperBool(process.env[name]);
}

/**
 * Resolves a `SUPABASE_*` boolean where a project `supabase/.env` value may
 * also apply: shell presence (any value, including `false`, `""`, or
 * garbage) suppresses the project value entirely; `??` encodes exactly that
 * presence check. `opts.whenUnset` resolves a key absent from both shell and
 * project env, letting an opt-out gate default on while any present value
 * still disables.
 */
export function viperEnvBoolWithProjectFallback(
  name: string,
  projectEnv: Record<string, string>,
  opts: { readonly whenUnset?: boolean } = {},
): boolean {
  const raw = process.env[name] ?? projectEnv[name];
  if (raw === undefined) return opts.whenUnset ?? false;
  return viperBool(raw);
}

/**
 * Resolves a `SUPABASE_*` string with the same shell-presence-wins semantics
 * as {@link viperEnvBoolWithProjectFallback}, but with no boolean coercion —
 * the raw merged string, or `""` when absent from both. `??` (not `||`)
 * encodes the presence check.
 */
export function viperEnvStringWithProjectFallback(
  name: string,
  projectEnv: Record<string, string>,
): string {
  return process.env[name] ?? projectEnv[name] ?? "";
}
