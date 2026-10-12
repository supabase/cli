import { ConfigProvider, Context, Effect } from "effect";

/** Env values a test pinned; the test config layers build their shell tier from these alone. */
export const ConfigEnvPins = Context.Reference<Readonly<Record<string, string>>>(
  "tests/ConfigEnvPins",
  { defaultValue: () => ({}) },
);

export const PINNED_ENV_PREFIXES = ["SUPABASE_", "DOTENV_", "NEXT_PUBLIC_SUPABASE_"] as const;

export const definedEnv = (
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).flatMap(([name, value]): Array<[string, string]> =>
      value === undefined ? [] : [[name, value]],
    ),
  );

/** A provider over `explicit` plus the current pins, never the ambient `process.env`. */
export const pinnedConfigProvider = (
  explicit: Readonly<Record<string, string>> = {},
): Effect.Effect<ConfigProvider.ConfigProvider> =>
  Effect.map(Effect.service(ConfigEnvPins), (pins) =>
    ConfigProvider.fromEnvRecord({ ...explicit, ...pins }, { preserveEmptyStrings: true }),
  );
