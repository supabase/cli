import { Effect, Option } from "effect";
import { LegacyCliSettings } from "../../../config/legacy-cli-settings.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import {
  buildFunctionsServeInspectArgs,
  resolveFunctionsServeInspectMode,
  type FunctionsServeFlags,
} from "../../../../shared/functions/serve.ts";
import {
  serveManagedFunctions,
  type ServeManagedFunctionsOperations,
} from "../../../../next/commands/functions/dev/functions-dev-runtime.ts";

export type {
  ManagedFunctionsStack,
  ServeManagedFunctionsOperations,
} from "../../../../next/commands/functions/dev/functions-dev-runtime.ts";

export type LegacyFunctionsServeFlags = FunctionsServeFlags;

export const legacyResolveFunctionsServeInspectMode = resolveFunctionsServeInspectMode;
export const legacyBuildFunctionsServeInspectArgs = buildFunctionsServeInspectArgs;

export const legacyFunctionsServe = Effect.fn("legacy.functions.serve")(function* (
  flags: LegacyFunctionsServeFlags,
  operations?: ServeManagedFunctionsOperations,
) {
  const cliSettings = yield* LegacyCliSettings;
  const telemetryState = yield* LegacyTelemetryState;
  yield* serveManagedFunctions(
    {
      projectRoot: cliSettings.workdir,
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
