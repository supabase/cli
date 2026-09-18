import { Command } from "effect/unstable/cli";
import { dbRemoteChangesCommand } from "./changes/changes.command.ts";
import { dbRemoteCommitCommand } from "./commit/commit.command.ts";

export const dbRemoteCommand = Command.make("remote").pipe(
  Command.withDescription("Manage remote databases."),
  Command.withShortDescription("Manage remote databases"),
  Command.withSubcommands([dbRemoteChangesCommand, dbRemoteCommitCommand]),
);
