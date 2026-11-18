import { Command } from "effect/cli";
import { snippetsListCommand } from "./list/list.command.ts";
import { snippetsDownloadCommand } from "./download/download.command.ts";

export const snippetsCommand = Command.make("snippets").pipe(
  Command.withDescription("List and download the SQL snippets saved in a project."),
  Command.withShortDescription("Manage SQL snippets"),
  Command.withSubcommands([snippetsListCommand, snippetsDownloadCommand]),
);
