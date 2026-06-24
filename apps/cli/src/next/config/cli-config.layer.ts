import { Effect, Layer, Option, Redacted } from "effect";
import { resolveSupabaseHome } from "../../shared/config/supabase-home.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import { resolvePosthogConfig } from "../../shared/telemetry/posthog-config.ts";
import { CliConfig } from "./cli-config.service.ts";
import { ProjectContext } from "./project-context.service.ts";

const SUPABASE_API_URL = "https://api.supabase.com";
const SUPABASE_DASHBOARD_URL = "https://supabase.com/dashboard";
const SUPABASE_PROJECT_HOST = "supabase.co";

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
  const posthogConfig = resolvePosthogConfig(effectiveEnv);

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
    supabaseHome: resolveSupabaseHome(effectiveEnv, runtimeInfo.homeDir),
    debug: readEnv(effectiveEnv, "SUPABASE_DEBUG"),
    telemetryDebug: readEnv(effectiveEnv, "SUPABASE_TELEMETRY_DEBUG"),
    telemetryDisabled: readEnv(effectiveEnv, "SUPABASE_TELEMETRY_DISABLED"),
    doNotTrack: readEnv(effectiveEnv, "DO_NOT_TRACK"),
  });
});

export const cliConfigLayer = Layer.effect(CliConfig, makeCliConfig);
