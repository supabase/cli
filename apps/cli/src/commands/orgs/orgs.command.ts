import { Command } from "effect/cli";
import { orgsCreateCommand } from "./create/create.command.ts";
import { orgsListCommand } from "./list/list.command.ts";

// There is no Long description, so the Short string is reused for both the subcommand
// summary and the `supabase orgs --help` long description. No trailing
// period.
export const orgsCommand = Command.make("orgs").pipe(
  Command.withDescription("Manage Supabase organizations"),
  Command.withShortDescription("Manage Supabase organizations"),
  Command.withSubcommands([orgsListCommand, orgsCreateCommand]),
);
