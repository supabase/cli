import { Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyTelemetryDisable } from "./disable.handler.ts";

const config = {};
export type LegacyTelemetryDisableFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyTelemetryDisableCommand = Command.make("disable", config).pipe(
  Command.withDescription("Disable CLI telemetry."),
  Command.withShortDescription("Disable telemetry"),
  Command.withHandler((flags) =>
    legacyTelemetryDisable(flags).pipe(
      withLegacyCommandInstrumentation({ analytics: false, flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(commandRuntimeLayer(["telemetry", "disable"])),
);
