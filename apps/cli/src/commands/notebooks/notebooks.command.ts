import { Command } from "effect/cli";
import { notebooksPullCommand } from "./pull/pull.command.ts";
import { notebooksPushCommand } from "./push/push.command.ts";

export const notebooksCommand = Command.make("notebooks").pipe(
  Command.withDescription(
    "Sync notebooks, which hold SQL and markdown cells, between your project and `supabase/notebooks/<name>.json`.",
  ),
  Command.withShortDescription("Manage notebooks"),
  Command.withSubcommands([notebooksPushCommand, notebooksPullCommand]),
);
