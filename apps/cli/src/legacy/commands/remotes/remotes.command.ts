import { Command } from "effect/unstable/cli";
import { legacyRemotesAddCommand } from "./add/add.command.ts";
import { legacyRemotesListCommand } from "./list/list.command.ts";
import { legacyRemotesRemoveCommand } from "./remove/remove.command.ts";

export const legacyRemotesCommand = Command.make("remotes").pipe(
  Command.withDescription(
    "Manage named remote Supabase projects in supabase/config.toml, selectable per-invocation via --remote.",
  ),
  Command.withShortDescription("Manage named remote projects"),
  Command.withSubcommands([
    legacyRemotesListCommand,
    legacyRemotesAddCommand,
    legacyRemotesRemoveCommand,
  ]),
);
