import { Command } from "effect/cli";
import { telemetryDisableCommand } from "./disable/disable.command.ts";
import { telemetryEnableCommand } from "./enable/enable.command.ts";
import { telemetryStatusCommand } from "./status/status.command.ts";

export const telemetryCommand = Command.make("telemetry").pipe(
  Command.withDescription(
    "Turn anonymous CLI usage telemetry on or off, or check whether it is on.",
  ),
  Command.withShortDescription("Manage CLI telemetry"),
  Command.withSubcommands([
    telemetryEnableCommand,
    telemetryDisableCommand,
    telemetryStatusCommand,
  ]),
);
