/**
 * Any global flag `--foo-bar` falls back to the `SUPABASE_FOO_BAR` env var
 * when the flag is absent: `1/t/T/TRUE/true/True` parses as true,
 * `0/f/F/FALSE/false/False` as false, and any other value (`yes`, `on`,
 * empty, garbage) as false. Effect CLI's flag parser carries no env binding,
 * so callers OR the parsed flag value with this read (flag-set wins).
 */

import { Effect } from "effect";

import { envValue } from "../shared/config/env-option.ts";

const TRUE_VALUES = new Set(["1", "t", "T", "TRUE", "true", "True"]);

/** Truthiness for an already-resolved env value (see module doc). */
function parseEnvBool(raw: string | undefined): boolean {
  return raw !== undefined && TRUE_VALUES.has(raw);
}

/** Reads a single `SUPABASE_*` boolean env var from the ambient config provider (see module doc). */
export const supabaseEnvBool = (name: string) => Effect.map(envValue(name), parseEnvBool);

/**
 * Resolves a `SUPABASE_*` boolean where a project `supabase/.env` value may
 * also apply: shell presence (any value, including `false`, `""`, or
 * garbage) suppresses the project value entirely; `??` encodes exactly that
 * presence check. `opts.whenUnset` resolves a key absent from both shell and
 * project env, letting an opt-out gate default on while any present value
 * still disables.
 */
export const supabaseEnvBoolWithProjectFallback = (
  name: string,
  projectEnv: Record<string, string>,
  opts: { readonly whenUnset?: boolean } = {},
) =>
  Effect.map(envValue(name), (shell) => {
    const raw = shell ?? projectEnv[name];
    return raw === undefined ? (opts.whenUnset ?? false) : parseEnvBool(raw);
  });

/**
 * Resolves a `SUPABASE_*` string with the same shell-presence-wins semantics
 * as {@link supabaseEnvBoolWithProjectFallback}, but with no boolean coercion —
 * the raw merged string, or `""` when absent from both. `??` (not `||`)
 * encodes the presence check.
 */
export const supabaseEnvStringWithProjectFallback = (
  name: string,
  projectEnv: Record<string, string>,
) => Effect.map(envValue(name), (shell) => shell ?? projectEnv[name] ?? "");
