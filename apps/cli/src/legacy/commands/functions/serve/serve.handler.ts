import { Effect, Option } from "effect";
import { LegacyCliSettings } from "../../../config/legacy-cli-settings.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import type { FunctionsServeFlags } from "../../../../shared/functions/serve.ts";
import {
  serveManagedFunctions,
  type ServeManagedFunctionsOperations,
} from "../../../../shared/functions/managed-functions-runtime.ts";

export type LegacyFunctionsServeFlags = FunctionsServeFlags;

export const legacyFunctionsServe = Effect.fn("legacy.functions.serve")(function* (
  flags: LegacyFunctionsServeFlags,
  operations?: ServeManagedFunctionsOperations,
) {
  const cliSettings = yield* LegacyCliSettings;
  const telemetryState = yield* LegacyTelemetryState;
  yield* serveManagedFunctions(
    {
      projectRoot: cliSettings.workdir,
      cwd: cliSettings.workdir,
      stackName: "default",
      envFile: Option.getOrUndefined(flags.envFile),
      noVerifyJwt: Option.getOrUndefined(flags.noVerifyJwt),
      importMap: Option.getOrUndefined(flags.importMap),
      inspect: flags.inspect,
      inspectMode: Option.getOrUndefined(flags.inspectMode),
      inspectMain: flags.inspectMain,
    },
    operations,
  ).pipe(Effect.ensuring(telemetryState.flush));
});
