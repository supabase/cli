import { Command } from "effect/unstable/cli";
import { legacySecretsListCommand } from "./list/list.command.ts";
import { legacySecretsSetCommand } from "./set/set.command.ts";
import { legacySecretsUnsetCommand } from "./unset/unset.command.ts";

export const legacySecretsCommand = Command.make("secrets").pipe(
  Command.withDescription("Manage Supabase secrets."),
  Command.withShortDescription("Manage Supabase secrets"),
  Command.withSubcommands([
    legacySecretsListCommand,
    legacySecretsSetCommand,
    legacySecretsUnsetCommand,
  ]),
);
