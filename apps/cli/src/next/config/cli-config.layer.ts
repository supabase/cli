import { Effect, Layer, Option, Redacted } from "effect";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import { CliConfig } from "./cli-config.service.ts";
import { ProjectContext } from "./project-context.service.ts";

const SUPABASE_API_URL = "https://api.supabase.com";
const SUPABASE_DASHBOARD_URL = "https://supabase.com/dashboard";
const SUPABASE_PROJECT_HOST = "supabase.co";
const SUPABASE_TELEMETRY_POSTHOG_HOST = "https://eu.i.posthog.com";
const SUPABASE_TELEMETRY_POSTHOG_KEY = "phc_ihjC3EeB2wXCt87yccX5idgIgeZsub7WG0XR5hGFhJz";

function readEnv(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): Option.Option<string> {
  const value = env[key];
  return value === undefined ? Option.none() : Option.some(value);
}

const makeCliConfig = Effect.gen(function* () {
  const runtimeInfo = yield* RuntimeInfo;
  const projectContext = yield* ProjectContext;
  const effectiveEnv = Option.match(projectContext.projectEnv, {
    onNone: () => process.env,
    onSome: (projectEnv) => projectEnv.values,
  });

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
    telemetryPosthogHost: Option.getOrElse(
      readEnv(effectiveEnv, "SUPABASE_TELEMETRY_POSTHOG_HOST"),
      () => SUPABASE_TELEMETRY_POSTHOG_HOST,
    ),
    telemetryPosthogKey: Option.getOrElse(
      readEnv(effectiveEnv, "SUPABASE_TELEMETRY_POSTHOG_KEY"),
      () => SUPABASE_TELEMETRY_POSTHOG_KEY,
    ),
    accessToken: Option.map(readEnv(effectiveEnv, "SUPABASE_ACCESS_TOKEN"), (token) =>
      Redacted.make(token, { label: "SUPABASE_ACCESS_TOKEN" }),
    ),
    noKeyring: readEnv(effectiveEnv, "SUPABASE_NO_KEYRING"),
    supabaseHome: Option.getOrElse(
      readEnv(effectiveEnv, "SUPABASE_HOME"),
      () => `${runtimeInfo.homeDir}/.supabase`,
    ),
    debug: readEnv(effectiveEnv, "SUPABASE_DEBUG"),
    telemetryDebug: readEnv(effectiveEnv, "SUPABASE_TELEMETRY_DEBUG"),
    telemetryDisabled: readEnv(effectiveEnv, "SUPABASE_TELEMETRY_DISABLED"),
    doNotTrack: readEnv(effectiveEnv, "DO_NOT_TRACK"),
  });
});

export const cliConfigLayer = Layer.effect(CliConfig, makeCliConfig);
