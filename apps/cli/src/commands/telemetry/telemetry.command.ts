import { Command } from "effect/unstable/cli";
import { legacyTelemetryDisableCommand } from "./disable/disable.command.ts";
import { legacyTelemetryEnableCommand } from "./enable/enable.command.ts";
import { legacyTelemetryStatusCommand } from "./status/status.command.ts";

export const legacyTelemetryCommand = Command.make("telemetry").pipe(
  Command.withDescription("Manage CLI telemetry settings."),
  Command.withShortDescription("Manage telemetry"),
  Command.withSubcommands([
    legacyTelemetryEnableCommand,
    legacyTelemetryDisableCommand,
    legacyTelemetryStatusCommand,
  ]),
);
