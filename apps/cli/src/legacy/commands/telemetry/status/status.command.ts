import { Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyTelemetryStatus } from "./status.handler.ts";

const config = {};
export type LegacyTelemetryStatusFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyTelemetryStatusCommand = Command.make("status", config).pipe(
  Command.withDescription("Show CLI telemetry status."),
  Command.withShortDescription("Show telemetry status"),
  Command.withHandler((flags) => legacyTelemetryStatus(flags)),
);
