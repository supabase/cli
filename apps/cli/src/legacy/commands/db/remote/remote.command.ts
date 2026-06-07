import { Command } from "effect/unstable/cli";
import { legacyDbRemoteChangesCommand } from "./changes/changes.command.ts";
import { legacyDbRemoteCommitCommand } from "./commit/commit.command.ts";

export const legacyDbRemoteCommand = Command.make("remote").pipe(
  Command.withDescription("Manage remote databases."),
  Command.withShortDescription("Manage remote databases"),
  Command.withSubcommands([legacyDbRemoteChangesCommand, legacyDbRemoteCommitCommand]),
);
