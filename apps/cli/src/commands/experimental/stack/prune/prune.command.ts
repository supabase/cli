import { Layer } from "effect";
import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { machineErrorContextLayer } from "../../../../shared/output/machine-error-context.layer.ts";
import { stdinLayer } from "../../../../shared/runtime/stdin.layer.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { stackPrune } from "./prune.handler.ts";
import { withTargetPolicy } from "../../../../command-internal/target/target-policy.ts";

const config = {
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription(
      "List the stacks whose project directory no longer exists without destroying them.",
    ),
    Flag.withDefault(false),
  ),
} as const;

export type StackPruneFlags = CliCommand.Command.Config.Infer<typeof config>;

export const stackPruneCommand = Command.make("prune", config).pipe(
  Command.withDescription(
    "Permanently destroy managed local stacks whose project directory no longer exists, such as those of deleted worktrees or moved directories, with their owned data and Storage uploads.",
  ),
  Command.withShortDescription("Destroy stacks whose project directory no longer exists"),
  Command.withExamples([
    {
      command: "supabase stack prune --dry-run",
      description: "List the stacks whose project directory no longer exists",
    },
    {
      command: "supabase stack prune --yes",
      description:
        "Permanently destroy every stack whose project directory no longer exists, without a prompt",
    },
  ]),
  withPermissions({ operations: [], noApiEffectFlags: ["dry-run"] }),
  Command.withHandler((flags) =>
    stackPrune(flags).pipe(withCommandTelemetry({ flags, config }), withJsonErrorHandling),
  ),
  // `stdinLayer` satisfies `promptYesNo`'s `Stdin` requirement; a non-TTY run rejects before
  // reading it. `machineErrorContextLayer` lists the stacks destroyed before a partial failure.
  Command.provide(Layer.mergeAll(stdinLayer, machineErrorContextLayer)),
  withTargetPolicy({ group: "local-only", consent: "none" }),
);
