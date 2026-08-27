import { Effect } from "effect";
import { join } from "node:path";
import { LegacyCliSettings } from "../../../config/legacy-cli-settings.service.ts";
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
  const cliSettings = yield* LegacyCliSettings;
  const runtimeInfo = yield* RuntimeInfo;
  const telemetryState = yield* LegacyTelemetryState;
  const debug = yield* LegacyDebugFlag;
  const networkId = yield* LegacyNetworkIdFlag;

  yield* serveFunctions(flags, {
    projectRoot: cliSettings.workdir,
    supabaseDir: join(cliSettings.workdir, "supabase"),
    flagCwd: runtimeInfo.cwd,
    platform: runtimeInfo.platform,
    debug,
    networkId,
    projectIdOverride: cliSettings.projectId,
    goViperCompat: true,
    goConfigCompat: legacyFunctionsGoConfigCompat,
  }).pipe(Effect.ensuring(telemetryState.flush));
});
