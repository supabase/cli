import { Effect } from "effect";
import { join } from "node:path";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { functionsGoConfigCompat } from "../../../command-internal/functions-go-config.ts";
import { DebugFlag, NetworkIdFlag } from "../../../command-internal/global-flags.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { serveFunctions, type FunctionsServeFlags } from "../../../shared/functions/serve.ts";

export const functionsServe = Effect.fn("functions.serve")(function* (flags: FunctionsServeFlags) {
  const cliSettings = yield* CommandSettings;
  const runtimeInfo = yield* RuntimeInfo;
  const telemetryState = yield* TelemetryState;
  const debug = yield* DebugFlag;
  const networkId = yield* NetworkIdFlag;

  yield* serveFunctions(flags, {
    projectRoot: cliSettings.workdir,
    supabaseDir: join(cliSettings.workdir, "supabase"),
    flagCwd: runtimeInfo.cwd,
    platform: runtimeInfo.platform,
    debug,
    networkId,
    projectIdOverride: cliSettings.projectId,
    goViperCompat: true,
    goConfigCompat: functionsGoConfigCompat,
  }).pipe(Effect.ensuring(telemetryState.flush));
});
