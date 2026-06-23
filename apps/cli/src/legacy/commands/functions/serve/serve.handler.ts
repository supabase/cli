import { Effect } from "effect";
import { join } from "node:path";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
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
  const debug = yield* LegacyDebugFlag;
  const networkId = yield* LegacyNetworkIdFlag;

  yield* serveFunctions(flags, {
    projectRoot: cliConfig.workdir,
    supabaseDir: join(cliConfig.workdir, "supabase"),
    flagCwd: runtimeInfo.cwd,
    platform: runtimeInfo.platform,
    debug,
    networkId,
    projectIdOverride: cliConfig.projectId,
  }).pipe(Effect.ensuring(telemetryState.flush));
});
