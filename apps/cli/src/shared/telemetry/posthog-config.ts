// PostHog connection config shared by the analytics layers.
// Release builds inject the shipped host/key via apps/cli/scripts/build.ts.
import { Config, type ConfigProvider, Effect, Option } from "effect";

const DEFAULT_HOST = "https://eu.i.posthog.com";

export interface PosthogConfig {
  readonly host: string;
  readonly key: Option.Option<string>;
}

function nonEmptyString(value: string | undefined): Option.Option<string> {
  return value === undefined || value === "" ? Option.none() : Option.some(value);
}

function shippedPosthogHost(): Option.Option<string> {
  return nonEmptyString(process.env.SUPABASE_CLI_POSTHOG_HOST);
}

function shippedPosthogKey(): Option.Option<string> {
  return nonEmptyString(process.env.SUPABASE_CLI_POSTHOG_KEY);
}

function resolvePosthogConfigValues(
  host: Option.Option<string>,
  key: Option.Option<string>,
): PosthogConfig {
  return {
    host: Option.getOrElse(Option.orElse(host, shippedPosthogHost), () => DEFAULT_HOST),
    key: Option.orElse(key, shippedPosthogKey),
  };
}

export function resolvePosthogConfig(
  provider: ConfigProvider.ConfigProvider,
): Effect.Effect<PosthogConfig, Config.ConfigError> {
  return Effect.gen(function* () {
    const host = Option.filter(
      yield* Config.option(Config.string("SUPABASE_TELEMETRY_POSTHOG_HOST")).parse(provider),
      (value) => value.length > 0,
    );
    const key = Option.filter(
      yield* Config.option(Config.string("SUPABASE_TELEMETRY_POSTHOG_KEY")).parse(provider),
      (value) => value.length > 0,
    );
    return resolvePosthogConfigValues(host, key);
  });
}
