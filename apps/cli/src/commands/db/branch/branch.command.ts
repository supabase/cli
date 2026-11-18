import { Argument, Command } from "effect/cli";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { removedCommand } from "../../../command-internal/removed-command.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import { cliArgument, makeCommand } from "../../../shared/cli/cli-params.ts";

const REMOVED_SUGGESTION =
  "Local database branches are no longer supported. For hosted preview branches, see `supabase branches --help`.";

const withRemovedBranchTargetPolicy = withTargetPolicy({
  group: "removed",
  consent: "none",
  consentExemptReason: "removed command",
});

/** A tombstoned `db branch` leaf taking an optional `<branch name>` positional. */
function removedBranchLeaf(name: string, argDescription: string) {
  return makeCommand(name, {
    branchName: cliArgument("branch name", Argument.String, {
      description: argDescription,
      optional: true,
    }),
  } as const).pipe(
    Command.withDescription("Removed: local database branches are no longer supported."),
    Command.withShortDescription("Removed: local database branches are no longer supported"),
    // Removed: fails before any Management API call, so no flag changes what it calls.
    withPermissions({ operations: [], noApiEffectFlags: [] }),
    Command.withHandler(() =>
      removedCommand(REMOVED_SUGGESTION).pipe(withCommandTelemetry(), withJsonErrorHandling),
    ),
    Command.provide(commandRuntimeLayer(["db", "branch", name])),
    Command.provide(telemetryStateLayer),
    withRemovedBranchTargetPolicy,
  );
}

const dbBranchCreateCommand = removedBranchLeaf("create", "Name for the new branch.");
const dbBranchDeleteCommand = removedBranchLeaf("delete", "Name of the branch to delete.");
const dbBranchSwitchCommand = removedBranchLeaf("switch", "Name of the branch to switch to.");

const dbBranchListCommand = makeCommand("list", {}).pipe(
  Command.withDescription("Removed: local database branches are no longer supported."),
  Command.withShortDescription("Removed: local database branches are no longer supported"),
  // Removed: fails before any Management API call, so no flag changes what it calls.
  withPermissions({ operations: [], noApiEffectFlags: [] }),
  Command.withHandler(() =>
    removedCommand(REMOVED_SUGGESTION).pipe(withCommandTelemetry(), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["db", "branch", "list"])),
  Command.provide(telemetryStateLayer),
  withRemovedBranchTargetPolicy,
);

export const dbBranchCommand = Command.make("branch").pipe(
  Command.withDescription(
    "Removed: local database branches are no longer supported. See each subcommand for details.",
  ),
  Command.withShortDescription("Removed: local database branches are no longer supported"),
  Command.withSubcommands([
    dbBranchCreateCommand,
    dbBranchDeleteCommand,
    dbBranchListCommand,
    dbBranchSwitchCommand,
  ]),
);
