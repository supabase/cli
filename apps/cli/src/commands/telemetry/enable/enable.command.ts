import { Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { telemetryEnable } from "./enable.handler.ts";

const config = {};
export type TelemetryEnableFlags = CliCommand.Command.Config.Infer<typeof config>;

export const telemetryEnableCommand = Command.make("enable", config).pipe(
  Command.withDescription("Enable CLI telemetry."),
  Command.withShortDescription("Enable telemetry"),
  Command.withHandler((flags) =>
    // `cli_command_executed` fires based on the consent value read at layer-construction
    // time: silent when enabling from a disabled state, since the snapshot is `false`.
    telemetryEnable(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["telemetry", "enable"])),
);
