import { Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyTelemetryEnable } from "./enable.handler.ts";

const config = {};
export type LegacyTelemetryEnableFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyTelemetryEnableCommand = Command.make("enable", config).pipe(
  Command.withDescription("Enable CLI telemetry."),
  Command.withShortDescription("Enable telemetry"),
  Command.withHandler((flags) =>
    legacyTelemetryEnable(flags).pipe(
      withLegacyCommandInstrumentation({ analytics: false, flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(commandRuntimeLayer(["telemetry", "enable"])),
);
