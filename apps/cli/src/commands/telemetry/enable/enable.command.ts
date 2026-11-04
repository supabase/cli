import { Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { telemetryEnable } from "./enable.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {};
export type TelemetryEnableFlags = CliCommand.Command.Config.Infer<typeof config>;

export const telemetryEnableCommand = makeCommand("enable", config).pipe(
  Command.withDescription("Turn on anonymous CLI usage telemetry for this machine."),
  Command.withShortDescription("Enable CLI telemetry"),
  Command.withExamples([
    { command: "supabase telemetry enable", description: "Turn telemetry on" },
  ]),
  withPermissions({ operations: [] }),
  Command.withHandler((flags) =>
    // `cli_command_executed` fires based on the consent value read at layer-construction
    // time: silent when enabling from a disabled state, since the snapshot is `false`.
    telemetryEnable(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["telemetry", "enable"])),
  withTargetPolicy({ group: "local-only", consent: "none" }),
);
