import { Effect, Path } from "effect";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { legacyFunctionsGoConfigCompat } from "../../../shared/legacy-functions-go-config.ts";
import { LegacyDebugFlag, LegacyNetworkIdFlag } from "../../../../shared/legacy/global-flags.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import {
  buildFunctionsServeInspectArgs,
  resolveFunctionsServeInspectMode,
  serveFunctions,
  type FunctionsServeFlags,
} from "../../../../shared/functions/serve.ts";

export type LegacyFunctionsServeFlags = FunctionsServeFlags;

export const legacyResolveFunctionsServeInspectMode = resolveFunctionsServeInspectMode;
export const legacyBuildFunctionsServeInspectArgs = buildFunctionsServeInspectArgs;

export const legacyFunctionsServe = Effect.fn("legacy.functions.serve")(function* (
  flags: LegacyFunctionsServeFlags,
) {
  const cliConfig = yield* LegacyCliConfig;
  const runtimeInfo = yield* RuntimeInfo;
  const telemetryState = yield* LegacyTelemetryState;
  const path = yield* Path.Path;
  const debug = yield* LegacyDebugFlag;
  const networkId = yield* LegacyNetworkIdFlag;
  const goConfigCompat = yield* legacyFunctionsGoConfigCompat;

  yield* serveFunctions(flags, {
    projectRoot: cliConfig.workdir,
    supabaseDir: path.join(cliConfig.workdir, "supabase"),
    flagCwd: runtimeInfo.cwd,
    platform: runtimeInfo.platform,
    debug,
    networkId,
    projectIdOverride: cliConfig.projectId,
    goViperCompat: true,
    goConfigCompat,
  }).pipe(Effect.ensuring(telemetryState.flush));
});
