import { Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { telemetryDisable } from "./disable.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";

const config = {};
export type TelemetryDisableFlags = CliCommand.Command.Config.Infer<typeof config>;

export const telemetryDisableCommand = Command.make("disable", config).pipe(
  Command.withDescription("Disable CLI telemetry."),
  Command.withShortDescription("Disable telemetry"),
  withPermissions({ operations: [] }),
  Command.withHandler((flags) =>
    // `cli_command_executed` fires based on the consent value read at layer-construction
    // time, before this handler mutates it — so `disable` still fires when telemetry was
    // enabled going into the call, and stays silent when it was already disabled.
    telemetryDisable(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["telemetry", "disable"])),
  withTargetPolicy({
    group: "local-only",
    consent: "none",
    consentExemptReason: "changes only the local telemetry preference",
  }),
);
