import { withSidebar } from "../../command-internal/command-sidebar.ts";
import { Command } from "effect/cli";
import { notebooksPullCommand } from "./pull/pull.command.ts";
import { notebooksPushCommand } from "./push/push.command.ts";

export const notebooksCommand = Command.make("notebooks").pipe(
  withSidebar({ category: "notebooks", title: "Manage notebooks" }),
  Command.withDescription(
    "Manage Supabase notebooks: SQL and markdown cells stored with your project, kept in `supabase/notebooks/<name>.json`.",
  ),
  Command.withShortDescription("Manage Supabase notebooks"),
  Command.withSubcommands([notebooksPushCommand, notebooksPullCommand]),
);
