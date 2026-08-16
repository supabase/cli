import { Command } from "effect/unstable/cli";
import { remotesAddCommand } from "./add/add.command.ts";
import { remotesListCommand } from "./list/list.command.ts";
import { remotesRemoveCommand } from "./remove/remove.command.ts";

export const remotesCommand = Command.make("remotes").pipe(
  Command.withDescription(
    "Manage named remote Supabase projects in supabase/config.toml, selectable per-invocation via --remote.",
  ),
  Command.withShortDescription("Manage named remote projects"),
  Command.withSubcommands([remotesListCommand, remotesAddCommand, remotesRemoveCommand]),
);
