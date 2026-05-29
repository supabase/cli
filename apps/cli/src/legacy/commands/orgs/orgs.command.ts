import { Command } from "effect/unstable/cli";
import { legacyOrgsCreateCommand } from "./create/create.command.ts";
import { legacyOrgsListCommand } from "./list/list.command.ts";

// Description text matches Go's `cmd/orgs.go:13` exactly — cobra has no Long,
// so the Short string is reused for both the subcommand summary and the
// `supabase orgs --help` long description. No trailing period.
export const legacyOrgsCommand = Command.make("orgs").pipe(
  Command.withDescription("Manage Supabase organizations"),
  Command.withShortDescription("Manage Supabase organizations"),
  Command.withSubcommands([legacyOrgsListCommand, legacyOrgsCreateCommand]),
);
