import { Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { telemetryStatus } from "./status.handler.ts";

const config = {};
export type TelemetryStatusFlags = CliCommand.Command.Config.Infer<typeof config>;

export const telemetryStatusCommand = Command.make("status", config).pipe(
  Command.withDescription("Show CLI telemetry status."),
  Command.withShortDescription("Show telemetry status"),
  Command.withHandler((flags) =>
    telemetryStatus(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["telemetry", "status"])),
);
