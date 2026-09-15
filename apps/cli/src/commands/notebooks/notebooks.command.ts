import { Command } from "effect/unstable/cli";
import { notebooksPullCommand } from "./pull/pull.command.ts";
import { notebooksPushCommand } from "./push/push.command.ts";

export const notebooksCommand = Command.make("notebooks").pipe(
  Command.withDescription(
    "Manage Supabase notebooks: SQL and markdown cells stored with your project, kept in supabase/notebooks/<name>.json.",
  ),
  Command.withShortDescription("Manage Supabase notebooks"),
  Command.withSubcommands([notebooksPushCommand, notebooksPullCommand]),
);
