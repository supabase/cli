import { Command } from "effect/unstable/cli";
import { snippetsListCommand } from "./list/list.command.ts";
import { snippetsDownloadCommand } from "./download/download.command.ts";

export const snippetsCommand = Command.make("snippets").pipe(
  Command.withDescription("Manage Supabase SQL snippets."),
  Command.withShortDescription("Manage Supabase SQL snippets"),
  Command.withSubcommands([snippetsListCommand, snippetsDownloadCommand]),
);
