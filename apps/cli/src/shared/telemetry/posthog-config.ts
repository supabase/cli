// PostHog connection config shared by the analytics layers.
// Release builds inject the shipped host/key via apps/cli/scripts/build.ts.
import { Config, ConfigProvider, Effect, Option } from "effect";

declare const SUPABASE_CLI_POSTHOG_HOST: string | undefined;
declare const SUPABASE_CLI_POSTHOG_KEY: string | undefined;

const DEFAULT_HOST = "https://eu.i.posthog.com";

export interface PosthogConfig {
  readonly host: string;
  readonly key: Option.Option<string>;
}

function nonEmptyString(value: string): Option.Option<string> {
  return value === "" ? Option.none() : Option.some(value);
}

function readNonEmptyString(
  provider: ConfigProvider.ConfigProvider,
  name: string,
): Effect.Effect<Option.Option<string>, Config.ConfigError> {
  return Config.option(Config.string(name))
    .parse(provider)
    .pipe(Effect.map(Option.flatMap(nonEmptyString)));
}

function readShippedValue(
  injected: string | undefined,
  name: string,
): Effect.Effect<Option.Option<string>, Config.ConfigError> {
  return injected === undefined
    ? Effect.suspend(() => readNonEmptyString(ConfigProvider.fromEnv(), name))
    : Effect.succeed(nonEmptyString(injected));
}

export function resolvePosthogConfig(
  provider: ConfigProvider.ConfigProvider,
): Effect.Effect<PosthogConfig, Config.ConfigError> {
  return Effect.gen(function* () {
    const host = yield* readNonEmptyString(provider, "SUPABASE_TELEMETRY_POSTHOG_HOST");
    const key = yield* readNonEmptyString(provider, "SUPABASE_TELEMETRY_POSTHOG_KEY");
    return {
      host: Option.getOrElse(
        Option.isSome(host)
          ? host
          : yield* readShippedValue(
              typeof SUPABASE_CLI_POSTHOG_HOST === "string" ? SUPABASE_CLI_POSTHOG_HOST : undefined,
              "SUPABASE_CLI_POSTHOG_HOST",
            ),
        () => DEFAULT_HOST,
      ),
      key: Option.isSome(key)
        ? key
        : yield* readShippedValue(
            typeof SUPABASE_CLI_POSTHOG_KEY === "string" ? SUPABASE_CLI_POSTHOG_KEY : undefined,
            "SUPABASE_CLI_POSTHOG_KEY",
          ),
    };
  });
}
