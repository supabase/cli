// PostHog connection config shared by both shells' analytics layers.
// Release builds inject the shipped host/key via apps/cli/scripts/build.ts.
import { Option } from "effect";

const DEFAULT_HOST = "https://eu.i.posthog.com";

export interface PosthogConfig {
  readonly host: string;
  readonly key: Option.Option<string>;
}

function nonEmptyString(value: string | undefined): Option.Option<string> {
  return value === undefined || value === "" ? Option.none() : Option.some(value);
}

function readNonEmptyEnv(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): Option.Option<string> {
  return nonEmptyString(env[key]);
}

function shippedPosthogHost(): Option.Option<string> {
  return nonEmptyString(process.env.SUPABASE_CLI_POSTHOG_HOST);
}

function shippedPosthogKey(): Option.Option<string> {
  return nonEmptyString(process.env.SUPABASE_CLI_POSTHOG_KEY);
}

export function resolvePosthogConfig(
  env: Readonly<Record<string, string | undefined>>,
): PosthogConfig {
  return {
    host: readNonEmptyEnv(env, "SUPABASE_TELEMETRY_POSTHOG_HOST").pipe(
      Option.orElse(shippedPosthogHost),
      Option.getOrElse(() => DEFAULT_HOST),
    ),
    key: readNonEmptyEnv(env, "SUPABASE_TELEMETRY_POSTHOG_KEY").pipe(
      Option.orElse(shippedPosthogKey),
    ),
  };
}
