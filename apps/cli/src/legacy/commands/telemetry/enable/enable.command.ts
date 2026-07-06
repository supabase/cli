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
    // Go parity (`cmd/root.go:131-138,171-181`): `cli_command_executed` fires
    // gated on the pre-toggle consent snapshot, same as `disable` — see that
    // command's comment. In the common case (enabling from a disabled state)
    // the snapshot is `false`, so the event stays silent; running `enable`
    // when telemetry is ALREADY enabled fires it, matching Go's uniform,
    // state-based (not command-based) gate.
    legacyTelemetryEnable(flags).pipe(
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(commandRuntimeLayer(["telemetry", "enable"])),
);
