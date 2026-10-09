/**
 * Any global flag `--foo-bar` falls back to the `SUPABASE_FOO_BAR` env var
 * when the flag is absent: `1/t/T/TRUE/true/True` parses as true,
 * `0/f/F/FALSE/false/False` as false, and any other value (`yes`, `on`,
 * empty, garbage) as false. Effect CLI's flag parser carries no env binding,
 * so callers OR the parsed flag value with this read (flag-set wins).
 */

import { Config, Effect, Option } from "effect";

const VIPER_TRUE = new Set(["1", "t", "T", "TRUE", "true", "True"]);

/** Truthiness for an already-resolved env value (see module doc). */
function viperBool(raw: string | undefined): boolean {
  return raw !== undefined && VIPER_TRUE.has(raw);
}

/** Env-record providers never fail this read, so a `ConfigError` here is a defect. */
const shellEnv = (name: string) =>
  Config.option(Config.string(name)).pipe(Effect.map(Option.getOrUndefined), Effect.orDie);

/** Reads a single `SUPABASE_*` boolean env var through `Config` (see module doc). */
export const viperEnvBool = Effect.fnUntraced(function* (name: string) {
  return viperBool(yield* shellEnv(name));
});

/**
 * Resolves a `SUPABASE_*` boolean where a project `supabase/.env` value may
 * also apply: shell presence (any value, including `false`, `""`, or
 * garbage) suppresses the project value entirely; `??` encodes exactly that
 * presence check. `opts.whenUnset` resolves a key absent from both shell and
 * project env, letting an opt-out gate default on while any present value
 * still disables.
 */
export const viperEnvBoolWithProjectFallback = Effect.fnUntraced(function* (
  name: string,
  projectEnv: Record<string, string>,
  opts: { readonly whenUnset?: boolean } = {},
) {
  const raw = (yield* shellEnv(name)) ?? projectEnv[name];
  if (raw === undefined) return opts.whenUnset ?? false;
  return viperBool(raw);
});

/**
 * Resolves a `SUPABASE_*` string with the same shell-presence-wins semantics
 * as {@link viperEnvBoolWithProjectFallback}, but with no boolean coercion —
 * the raw merged string, or `""` when absent from both. `??` (not `||`)
 * encodes the presence check.
 */
export const viperEnvStringWithProjectFallback = Effect.fnUntraced(function* (
  name: string,
  projectEnv: Record<string, string>,
) {
  return (yield* shellEnv(name)) ?? projectEnv[name] ?? "";
});
