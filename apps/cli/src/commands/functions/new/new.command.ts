import { Layer } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import { commandSettingsLayer } from "../../../config/command-settings.layer.ts";
import { debugLoggerLayer } from "../../../command-internal/debug-logger.layer.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { functionsNew } from "./new.handler.ts";

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

export type FunctionsNewFlags = CliCommand.Command.Config.Infer<typeof config>;

const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));

const functionsNewRuntimeLayer = Layer.mergeAll(
  cliSettings,
  telemetryStateLayer,
  commandRuntimeLayer(["functions", "new"]),
  // `stdinLayer`: the first-function IDE prompts read piped stdin via
  // `promptYesNo`.
  stdinLayer,
);

export const functionsNewCommand = Command.make("new", config).pipe(
  Command.withDescription("Create a new Function locally."),
  Command.withShortDescription("Create a new Function locally"),
  Command.withHandler((flags) =>
    functionsNew(flags).pipe(withCommandTelemetry({ flags, config }), withJsonErrorHandling),
  ),
  Command.provide(functionsNewRuntimeLayer),
);
