import { Option, Redacted } from "effect";
import { resolvePosthogConfig } from "../../shared/telemetry/posthog-config.ts";
import { resolveSupabaseHome } from "../../shared/config/supabase-home.ts";

function readEnv(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): Option.Option<string> {
  const value = env[key];
  return value === undefined ? Option.none() : Option.some(value);
}

/**
 * Next `CliConfig` fields sourced from a resolved legacy profile.
 *
 * `--profile` is a stable global. Commands that reuse next services must not
 * ignore it: API host, dashboard, project host, and the env access token come
 * from `LegacyCliConfig`, while telemetry / `SUPABASE_HOME` stay env-based.
 */
export const cliConfigFromLegacyProfile = (input: {
  readonly apiUrl: string;
  readonly dashboardUrl: string;
  readonly projectHost: string;
  readonly accessToken: Option.Option<Redacted.Redacted<string>>;
  readonly homeDir: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}) => {
  const env = input.env ?? process.env;
  const posthogConfig = resolvePosthogConfig(env);
  return {
    apiUrl: input.apiUrl,
    dashboardUrl: input.dashboardUrl,
    projectHost: input.projectHost,
    telemetryPosthogHost: posthogConfig.host,
    telemetryPosthogKey: posthogConfig.key,
    accessToken: input.accessToken,
    noKeyring: readEnv(env, "SUPABASE_NO_KEYRING"),
    supabaseHome: resolveSupabaseHome(env, input.homeDir),
    debug: readEnv(env, "SUPABASE_DEBUG"),
    telemetryDebug: readEnv(env, "SUPABASE_TELEMETRY_DEBUG"),
    telemetryDisabled: readEnv(env, "SUPABASE_TELEMETRY_DISABLED"),
    doNotTrack: readEnv(env, "DO_NOT_TRACK"),
  };
};
