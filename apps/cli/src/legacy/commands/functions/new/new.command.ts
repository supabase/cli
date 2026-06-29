import { Layer } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { legacyCliConfigLayer } from "../../../config/legacy-cli-config.layer.ts";
import { legacyDebugLoggerLayer } from "../../../shared/legacy-debug-logger.layer.ts";
import { legacyTelemetryStateLayer } from "../../../telemetry/legacy-telemetry-state.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyFunctionsNew } from "./new.handler.ts";

const AUTH_MODE_VALUES = ["none", "apikey", "user"] as const;

const config = {
  functionName: Argument.string("Function name").pipe(
    Argument.withDescription("Name of the Function to create."),
  ),
  auth: Flag.choice("auth", AUTH_MODE_VALUES).pipe(
    Flag.withDescription("use a specific auth mode"),
    Flag.withDefault("apikey" as const),
  ),
} as const;

export type LegacyFunctionsNewFlags = CliCommand.Command.Config.Infer<typeof config>;

const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));

const legacyFunctionsNewRuntimeLayer = Layer.mergeAll(
  cliConfig,
  legacyTelemetryStateLayer,
  commandRuntimeLayer(["functions", "new"]),
);

export const legacyFunctionsNewCommand = Command.make("new", config).pipe(
  Command.withDescription("Create a new Function locally."),
  Command.withShortDescription("Create a new Function locally"),
  Command.withHandler((flags) =>
    legacyFunctionsNew(flags).pipe(
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyFunctionsNewRuntimeLayer),
);
