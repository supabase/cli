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
    // Go parity (`cmd/root.go:131-138,171-181`): `cli_command_executed` fires
    // gated on the CONSENT SNAPSHOT TAKEN BEFORE this command's handler runs
    // (Go's PersistentPreRunE reads the on-disk state before `disable`'s RunE
    // mutates it), not on the just-written `false`. `legacyAnalyticsLayer`
    // reproduces that naturally: it reads `TelemetryRuntime.consent` once, at
    // layer-construction time, before the handler below ever executes, so
    // leaving analytics enabled here fires the event exactly when telemetry
    // was enabled prior to this invocation, and stays silent when it was
    // already disabled — see `enable.command.ts` for the mirror-image case.
    legacyTelemetryDisable(flags).pipe(
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(commandRuntimeLayer(["telemetry", "disable"])),
);
