import { Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyTelemetryDisable } from "./disable.handler.ts";

const config = {};
export type LegacyTelemetryDisableFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyTelemetryDisableCommand = Command.make("disable", config).pipe(
  Command.withDescription("Disable CLI telemetry."),
  Command.withShortDescription("Disable telemetry"),
  Command.withHandler((flags) => legacyTelemetryDisable(flags)),
);
