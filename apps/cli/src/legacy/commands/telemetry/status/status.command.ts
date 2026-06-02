import { Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyTelemetryStatus } from "./status.handler.ts";

const config = {};
export type LegacyTelemetryStatusFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyTelemetryStatusCommand = Command.make("status", config).pipe(
  Command.withDescription("Show CLI telemetry status."),
  Command.withShortDescription("Show telemetry status"),
  Command.withHandler((flags) =>
    legacyTelemetryStatus(flags).pipe(
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(commandRuntimeLayer(["telemetry", "status"])),
);
