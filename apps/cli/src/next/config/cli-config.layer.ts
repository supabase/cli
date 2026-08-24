import { Config, Effect, Layer, Option, Path, Redacted } from "effect";
import { resolveSupabaseHome } from "../../shared/config/supabase-home.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import { resolvePosthogConfig } from "../../shared/telemetry/posthog-config.ts";
import { CliConfig } from "./cli-config.service.ts";
import { ProjectContext } from "./project-context.service.ts";

const SUPABASE_API_URL = "https://api.supabase.com";
const SUPABASE_DASHBOARD_URL = "https://supabase.com/dashboard";
const SUPABASE_PROJECT_HOST = "supabase.co";

const CLI_ENV_KEYS = [
  "SUPABASE_API_URL",
  "SUPABASE_DASHBOARD_URL",
  "SUPABASE_PROJECT_HOST",
  "SUPABASE_ACCESS_TOKEN",
  "SUPABASE_NO_KEYRING",
  "SUPABASE_HOME",
  "SUPABASE_DEBUG",
  "SUPABASE_TELEMETRY_DEBUG",
  "SUPABASE_TELEMETRY_DISABLED",
  "DO_NOT_TRACK",
  "SUPABASE_TELEMETRY_POSTHOG_HOST",
  "SUPABASE_TELEMETRY_POSTHOG_KEY",
  "SUPABASE_CLI_POSTHOG_HOST",
  "SUPABASE_CLI_POSTHOG_KEY",
] as const;

function readEnv(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): Option.Option<string> {
  const value = env[key];
  return value === undefined ? Option.none() : Option.some(value);
}

const makeCliConfig = Effect.gen(function* () {
  const runtimeInfo = yield* RuntimeInfo;
  const path = yield* Path.Path;
  const projectContext = yield* ProjectContext;
  let effectiveEnv: Readonly<Record<string, string | undefined>>;
  if (Option.isSome(projectContext.projectEnv)) {
    effectiveEnv = projectContext.projectEnv.value.values;
  } else {
    const entries = yield* Effect.all(
      CLI_ENV_KEYS.map((key) =>
        Config.option(Config.string(key)).pipe(Effect.map((value) => ({ key, value }))),
      ),
    );
    effectiveEnv = Object.fromEntries(
      entries.flatMap(({ key, value }) => (Option.isSome(value) ? [[key, value.value]] : [])),
    );
  }
  const posthogConfig = resolvePosthogConfig(effectiveEnv);
  const configuredHome = readEnv(effectiveEnv, "SUPABASE_HOME");

  return CliConfig.of({
    apiUrl: Option.getOrElse(readEnv(effectiveEnv, "SUPABASE_API_URL"), () => SUPABASE_API_URL),
    dashboardUrl: Option.getOrElse(
      readEnv(effectiveEnv, "SUPABASE_DASHBOARD_URL"),
      () => SUPABASE_DASHBOARD_URL,
    ),
    projectHost: Option.getOrElse(
      readEnv(effectiveEnv, "SUPABASE_PROJECT_HOST"),
      () => SUPABASE_PROJECT_HOST,
    ),
    telemetryPosthogHost: posthogConfig.host,
    telemetryPosthogKey: posthogConfig.key,
    accessToken: Option.map(readEnv(effectiveEnv, "SUPABASE_ACCESS_TOKEN"), (token) =>
      Redacted.make(token, { label: "SUPABASE_ACCESS_TOKEN" }),
    ),
    noKeyring: readEnv(effectiveEnv, "SUPABASE_NO_KEYRING"),
    supabaseHome: resolveSupabaseHome(
      path,
      Option.getOrUndefined(configuredHome),
      runtimeInfo.homeDir,
    ),
    debug: readEnv(effectiveEnv, "SUPABASE_DEBUG"),
    telemetryDebug: readEnv(effectiveEnv, "SUPABASE_TELEMETRY_DEBUG"),
    telemetryDisabled: readEnv(effectiveEnv, "SUPABASE_TELEMETRY_DISABLED"),
    doNotTrack: readEnv(effectiveEnv, "DO_NOT_TRACK"),
  });
});

export const cliConfigLayer = Layer.effect(CliConfig, makeCliConfig);
