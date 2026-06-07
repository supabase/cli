import { Command } from "effect/unstable/cli";
import { legacySnippetsListCommand } from "./list/list.command.ts";
import { legacySnippetsDownloadCommand } from "./download/download.command.ts";

export const legacySnippetsCommand = Command.make("snippets").pipe(
  Command.withDescription("Manage Supabase SQL snippets."),
  Command.withShortDescription("Manage Supabase SQL snippets"),
  Command.withSubcommands([legacySnippetsListCommand, legacySnippetsDownloadCommand]),
);
