import { Command } from "effect/unstable/cli";
import { orgsCreateCommand } from "./create/create.command.ts";
import { orgsListCommand } from "./list/list.command.ts";

// cobra has no Long, so the Short string is reused for both the subcommand
// summary and the `supabase orgs --help` long description. No trailing
// period.
export const orgsCommand = Command.make("orgs").pipe(
  Command.withDescription("Manage Supabase organizations"),
  Command.withShortDescription("Manage Supabase organizations"),
  Command.withSubcommands([orgsListCommand, orgsCreateCommand]),
);
