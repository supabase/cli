import { withSidebar } from "../../command-internal/command-sidebar.ts";
import { Command } from "effect/cli";
import { snippetsListCommand } from "./list/list.command.ts";
import { snippetsDownloadCommand } from "./download/download.command.ts";

export const snippetsCommand = Command.make("snippets").pipe(
  withSidebar({ category: "sql-snippets" }),
  Command.withDescription("Manage Supabase SQL snippets."),
  Command.withShortDescription("Manage Supabase SQL snippets"),
  Command.withSubcommands([snippetsListCommand, snippetsDownloadCommand]),
);
