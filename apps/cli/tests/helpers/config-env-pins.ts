import { ConfigProvider, Context, Effect, Layer } from "effect";

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

/** Pins `process.env` as of layer build, for suites that set variables on it themselves. */
export const processEnvPinsLayer: Layer.Layer<never> = Layer.effect(
  ConfigEnvPins,
  Effect.sync(() => definedEnv(process.env)),
);

/** A provider over `explicit` plus the current pins, never the ambient `process.env`. */
export const pinnedConfigProvider = (
  explicit: Readonly<Record<string, string>> = {},
): Effect.Effect<ConfigProvider.ConfigProvider> =>
  Effect.map(Effect.service(ConfigEnvPins), (pins) =>
    ConfigProvider.fromEnvRecord({ ...explicit, ...pins }, { preserveEmptyStrings: true }),
  );
