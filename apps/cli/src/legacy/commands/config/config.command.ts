import { Command } from "effect/unstable/cli";
import { legacyConfigPushCommand } from "./push/push.command.ts";

export const legacyConfigCommand = Command.make("config").pipe(
  Command.withDescription("Manage Supabase project configurations."),
  Command.withShortDescription("Manage project configurations"),
  Command.withSubcommands([legacyConfigPushCommand]),
);
