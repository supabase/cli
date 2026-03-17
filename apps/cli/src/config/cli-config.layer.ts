import { Config, Effect, Layer, Option } from "effect";

import { RuntimeInfo } from "../runtime/runtime-info.service.ts";
import { CliConfig } from "./cli-config.service.ts";

const SUPABASE_API_URL = "https://api.supabase.com";
const SUPABASE_DASHBOARD_URL = "https://supabase.com/dashboard";

const makeCliConfig = Effect.gen(function* () {
  const runtimeInfo = yield* RuntimeInfo;
  const configuredHome = yield* Config.option(Config.string("SUPABASE_HOME"));

  return CliConfig.of({
    apiUrl: yield* Config.string("SUPABASE_API_URL").pipe(Config.withDefault(SUPABASE_API_URL)),
    dashboardUrl: yield* Config.string("SUPABASE_DASHBOARD_URL").pipe(
      Config.withDefault(SUPABASE_DASHBOARD_URL),
    ),
    accessToken: yield* Config.option(Config.redacted("SUPABASE_ACCESS_TOKEN")),
    noKeyring: yield* Config.option(Config.string("SUPABASE_NO_KEYRING")),
    supabaseHome: Option.getOrElse(configuredHome, () => `${runtimeInfo.homeDir}/.supabase`),
    debug: yield* Config.option(Config.string("SUPABASE_DEBUG")),
    telemetryDebug: yield* Config.option(Config.string("SUPABASE_TELEMETRY_DEBUG")),
    telemetry: yield* Config.option(Config.string("SUPABASE_TELEMETRY")),
    doNotTrack: yield* Config.option(Config.string("DO_NOT_TRACK")),
  });
});

export const cliConfigLayer = Layer.effect(CliConfig, makeCliConfig);
