import { Argument, Command } from "effect/unstable/cli";
import { removedCommand } from "../../../command-internal/removed-command.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";

const REMOVED_SUGGESTION =
  "Local database branches are no longer supported. For hosted preview branches, see `supabase branches --help`.";

/** A tombstoned `db branch` leaf taking an optional `<branch name>` positional. */
function removedBranchLeaf(name: string, argDescription: string) {
  return Command.make(name, {
    branchName: Argument.string("branch name").pipe(
      Argument.withDescription(argDescription),
      Argument.optional,
    ),
  } as const).pipe(
    Command.withDescription("Removed: local database branches are no longer supported."),
    Command.withShortDescription("Removed: local database branches are no longer supported"),
    Command.withHandler(() =>
      removedCommand(REMOVED_SUGGESTION).pipe(withCommandTelemetry(), withJsonErrorHandling),
    ),
    Command.provide(commandRuntimeLayer(["db", "branch", name])),
    Command.provide(telemetryStateLayer),
  );
}

const dbBranchCreateCommand = removedBranchLeaf("create", "Name for the new branch.");
const dbBranchDeleteCommand = removedBranchLeaf("delete", "Name of the branch to delete.");
const dbBranchSwitchCommand = removedBranchLeaf("switch", "Name of the branch to switch to.");

const dbBranchListCommand = Command.make("list", {}).pipe(
  Command.withDescription("Removed: local database branches are no longer supported."),
  Command.withShortDescription("Removed: local database branches are no longer supported"),
  Command.withHandler(() =>
    removedCommand(REMOVED_SUGGESTION).pipe(withCommandTelemetry(), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["db", "branch", "list"])),
  Command.provide(telemetryStateLayer),
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
