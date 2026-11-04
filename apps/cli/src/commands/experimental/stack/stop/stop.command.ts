import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { stackStop } from "./stop.handler.ts";
import { withTargetPolicy } from "../../../../command-internal/target/target-policy.ts";
import { cliFlag, makeCommand } from "../../../../shared/cli/cli-params.ts";

const config = {
  all: cliFlag("all", Flag.Boolean, {
    description: "Stop every readable managed stack.",
    optional: true,
  }),
  stack: cliFlag("stack", Flag.String, {
    description: "Stop the stack with this name (defaults to the current project stack).",
    optional: true,
  }),
  stackId: cliFlag("stack-id", Flag.String, {
    description: "Stop an existing stack by id or unique id prefix.",
    optional: true,
  }),
} as const;

export type StackStopFlags = CliCommand.Command.Config.Infer<typeof config>;

export const stackStopCommand = makeCommand("stop", config).pipe(
  Command.withDescription("Stop a managed local Supabase stack while preserving its data."),
  Command.withShortDescription("Stop a managed local stack"),
  Command.withExamples([
    {
      command: "supabase stack stop --stack feature-a",
      description: "Stop the existing feature-a stack",
    },
  ]),
  withPermissions({ operations: [], noApiEffectFlags: ["all", "stack", "stack-id"] }),
  Command.withHandler((flags) =>
    stackStop(flags).pipe(withCommandTelemetry({ flags, config }), withJsonErrorHandling),
  ),
  withTargetPolicy({ group: "local-only", consent: "none" }),
);
