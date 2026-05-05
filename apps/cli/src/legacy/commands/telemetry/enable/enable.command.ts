import { Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyTelemetryEnable } from "./enable.handler.ts";

const config = {};
export type LegacyTelemetryEnableFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyTelemetryEnableCommand = Command.make("enable", config).pipe(
  Command.withDescription("Enable CLI telemetry."),
  Command.withShortDescription("Enable telemetry"),
  Command.withHandler((flags) => legacyTelemetryEnable(flags)),
);
