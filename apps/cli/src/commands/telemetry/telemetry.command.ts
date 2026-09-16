import { Command } from "effect/unstable/cli";
import { telemetryDisableCommand } from "./disable/disable.command.ts";
import { telemetryEnableCommand } from "./enable/enable.command.ts";
import { telemetryStatusCommand } from "./status/status.command.ts";

export const telemetryCommand = Command.make("telemetry").pipe(
  Command.withDescription("Manage CLI telemetry settings."),
  Command.withShortDescription("Manage telemetry"),
  Command.withSubcommands([
    telemetryEnableCommand,
    telemetryDisableCommand,
    telemetryStatusCommand,
  ]),
);
