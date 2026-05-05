import { Command } from "effect/unstable/cli";
import { legacyOrgsCreateCommand } from "./create/create.command.ts";
import { legacyOrgsListCommand } from "./list/list.command.ts";

export const legacyOrgsCommand = Command.make("orgs").pipe(
  Command.withDescription("Manage Supabase organizations."),
  Command.withShortDescription("Manage organizations"),
  Command.withSubcommands([legacyOrgsListCommand, legacyOrgsCreateCommand]),
);
